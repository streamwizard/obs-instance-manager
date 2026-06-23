import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { authMiddleware } from "../middleware/auth";
import {
  countActiveInstances,
  deleteInstance,
  getInstanceById,
  getNode,
  insertInstance,
  listUserInstances,
  sumAllocatedVram,
  updateInstance,
} from "../lib/supabase";
import {
  createContainer,
  getContainerStatus,
  instanceTarget,
  NOVNC_PORT_INTERNAL,
  OBS_WS_PORT_INTERNAL,
  removeContainer,
  startContainer,
  stopContainer,
} from "../lib/docker";
import { NODE_ID } from "../lib/node";
import type { AppVariables, CreateInstanceBody } from "../types";

const DEFAULT_RESOLUTION = "1920x1080";

export const { upgradeWebSocket, websocket } = createBunWebSocket();

const instances = new Hono<{ Variables: AppVariables }>();

instances.use("*", authMiddleware);

// Bridges a browser websocket connection to an instance container's internal
// noVNC/obs-websocket port over the shared `obs-net` Docker network. Instance
// containers publish no host ports, so this proxy is the only path in.
function proxyRoute(port: number) {
  return upgradeWebSocket(async (c) => {
    const userId = c.get("userId") as string;
    const id = c.req.param("id") as string;
    const instance = await getInstanceById(id, userId);

    let upstream: WebSocket | null = null;
    let queued: (string | ArrayBufferLike)[] = [];

    return {
      onOpen(_event, ws) {
        if (!instance) {
          ws.close(4404, "Instance not found");
          return;
        }

        upstream = new WebSocket(`ws://${instanceTarget(instance.container_name, port)}`);
        upstream.binaryType = "arraybuffer";
        upstream.onopen = () => {
          for (const message of queued) upstream?.send(message);
          queued = [];
        };
        upstream.onmessage = (event) => ws.send(event.data);
        upstream.onclose = () => ws.close();
        upstream.onerror = () => ws.close();
      },
      onMessage(event, _ws) {
        const data = event.data as string | ArrayBufferLike;
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(data);
        } else {
          queued.push(data);
        }
      },
      onClose() {
        upstream?.close();
      },
    };
  });
}

instances.get("/:id/novnc", proxyRoute(NOVNC_PORT_INTERNAL));
instances.get("/:id/obsws", proxyRoute(OBS_WS_PORT_INTERNAL));

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

  const node = await getNode(NODE_ID);

  const activeCount = await countActiveInstances(node.id);
  if (activeCount >= node.max_instances) {
    return c.json({ error: "Node has reached max_instances capacity" }, 409);
  }

  const currentVram = await sumAllocatedVram(node.id);
  if (currentVram + node.vram_mb > node.total_vram_mb) {
    return c.json({ error: "Allocating this instance would exceed total_vram_mb" }, 409);
  }

  const instanceId = crypto.randomUUID();
  const containerName = `obs-instance-${instanceId}`;

  const instance = await insertInstance({
    id: instanceId,
    user_id: userId,
    node_id: node.id,
    container_id: null,
    container_name: containerName,
    resolution,
    status: "creating",
    vram_allocated_mb: node.vram_mb,
  });

  try {
    const containerId = await createContainer({
      instanceId,
      containerName,
      node,
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
