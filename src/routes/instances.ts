import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import {
  countActiveInstances,
  deleteInstance,
  getDefaultNode,
  getInstanceById,
  getUsedPorts,
  insertInstance,
  listUserInstances,
  sumAllocatedVram,
  updateInstance,
} from "../lib/supabase";
import { allocatePorts } from "../lib/ports";
import {
  createContainer,
  getContainerStatus,
  removeContainer,
  startContainer,
  stopContainer,
} from "../lib/docker";
import type { AppVariables, CreateInstanceBody } from "../types";

const DEFAULT_RESOLUTION = "1920x1080";

const instances = new Hono<{ Variables: AppVariables }>();

instances.use("*", authMiddleware);

instances.get("/", async (c) => {
  const userId = c.get("userId") as string;
  const userInstances = await listUserInstances(userId);

  const withStatus = await Promise.all(
    userInstances.map(async (instance) => ({
      ...instance,
      docker_status: instance.container_id
        ? await getContainerStatus(instance.container_id)
        : "not_found",
    }))
  );

  return c.json(withStatus);
});

instances.get("/:id", async (c) => {
  const userId = c.get("userId") as string;
  const id = c.req.param("id");

  const instance = await getInstanceById(id, userId);
  if (!instance) return c.json({ error: "Instance not found" }, 404);

  const docker_status = instance.container_id
    ? await getContainerStatus(instance.container_id)
    : "not_found";

  return c.json({ ...instance, docker_status });
});

instances.post("/", async (c) => {
  const userId = c.get("userId") as string;
  const body = await c.req.json<CreateInstanceBody>().catch(() => ({} as CreateInstanceBody));
  const resolution = body.resolution ?? DEFAULT_RESOLUTION;

  const node = await getDefaultNode();

  const activeCount = await countActiveInstances(node.id);
  if (activeCount >= node.max_instances) {
    return c.json({ error: "Node has reached max_instances capacity" }, 409);
  }

  const currentVram = await sumAllocatedVram(node.id);
  if (currentVram + node.vram_mb > node.total_vram_mb) {
    return c.json({ error: "Allocating this instance would exceed total_vram_mb" }, 409);
  }

  const usedPorts = await getUsedPorts(node.id);

  let ports;
  try {
    ports = allocatePorts(node, usedPorts);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 409);
  }

  const instanceId = crypto.randomUUID();
  const containerName = `obs-instance-${instanceId}`;

  const instance = await insertInstance({
    id: instanceId,
    user_id: userId,
    node_id: node.id,
    container_id: null,
    container_name: containerName,
    vnc_port: ports.vnc_port,
    novnc_port: ports.novnc_port,
    obs_ws_port: ports.obs_ws_port,
    resolution,
    status: "creating",
    vram_allocated_mb: node.vram_mb,
  });

  try {
    const containerId = await createContainer({
      instanceId,
      containerName,
      node,
      ports,
      resolution,
    });
    await startContainer(containerId);

    const updated = await updateInstance(instanceId, {
      container_id: containerId,
      status: "running",
    });

    return c.json(updated, 201);
  } catch (err) {
    await updateInstance(instanceId, { status: "error" });
    return c.json({ error: (err as Error).message }, 500);
  }
});

instances.post("/:id/start", async (c) => {
  const userId = c.get("userId") as string;
  const id = c.req.param("id");

  const instance = await getInstanceById(id, userId);
  if (!instance) return c.json({ error: "Instance not found" }, 404);
  if (!instance.container_id) return c.json({ error: "Instance has no container" }, 400);

  await startContainer(instance.container_id);
  const updated = await updateInstance(id, { status: "running" });

  return c.json(updated);
});

instances.post("/:id/stop", async (c) => {
  const userId = c.get("userId") as string;
  const id = c.req.param("id");

  const instance = await getInstanceById(id, userId);
  if (!instance) return c.json({ error: "Instance not found" }, 404);
  if (!instance.container_id) return c.json({ error: "Instance has no container" }, 400);

  await stopContainer(instance.container_id);
  const updated = await updateInstance(id, { status: "stopped" });

  return c.json(updated);
});

instances.delete("/:id", async (c) => {
  const userId = c.get("userId") as string;
  const id = c.req.param("id");

  const instance = await getInstanceById(id, userId);
  if (!instance) return c.json({ error: "Instance not found" }, 404);

  if (instance.container_id) {
    await stopContainer(instance.container_id).catch(() => {});
    await removeContainer(instance.container_id).catch(() => {});
  }

  await deleteInstance(id);

  return c.json({ success: true });
});

export default instances;
