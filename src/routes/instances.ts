import { Hono } from "hono";
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
import { MessageRateLimiter } from "../lib/rate-limit";
import { upgradeWebSocket } from "../lib/ws";
import { debug } from "../lib/logger";
import type { AppVariables, CreateInstanceBody } from "../types";

const DEFAULT_RESOLUTION = "1920x1080";

const instances = new Hono<{ Variables: AppVariables }>();

instances.use("*", authMiddleware);

// Bridges a browser websocket connection to an instance container's internal
// noVNC/obs-websocket port over the shared `obs-net` Docker network. Instance
// containers publish no host ports, so this proxy is the only path in.
//
// messagesPerWindow/windowMs bound how fast one client can push input into a
// container (mirrors Wings' WS throttle). noVNC gets a much higher ceiling
// than obsws since mouse/keyboard streams are naturally high-frequency,
// unlike sparse OBS control commands.
//
// getInstance is pluggable so the admin routes can reuse this proxy with an
// ownership-free lookup (getInstanceByIdAdmin) instead of the end-user one.
export function proxyRoute(
  port: number,
  messagesPerWindow: number,
  getInstance: (id: string, c: any) => Promise<{ container_name: string } | null>,
  windowMs = 200,
) {
  return upgradeWebSocket(async (c) => {
    const id = c.req.param("id") as string;
    const instance = await getInstance(id, c);
    const limiter = new MessageRateLimiter(messagesPerWindow, windowMs);

    let upstream: WebSocket | null = null;
    let queued: (string | ArrayBufferLike)[] = [];

    return {
      onOpen(_event, ws) {
        if (!instance) {
          debug("ws", `${id}:${port} rejected, instance not found`);
          ws.close(4404, "Instance not found");
          return;
        }

        const target = instanceTarget(instance.container_name, port);
        debug(
          "ws",
          `${id}:${port} client connected, dialing upstream ${target}`,
        );

        upstream = new WebSocket(`ws://${target}`);
        upstream.binaryType = "arraybuffer";
        upstream.onopen = () => {
          debug(
            "ws",
            `${id}:${port} upstream connected, flushing ${queued.length} queued message(s)`,
          );
          for (const message of queued) upstream?.send(message);
          queued = [];
        };
        upstream.onmessage = (event) => ws.send(event.data);
        upstream.onclose = () => {
          debug("ws", `${id}:${port} upstream closed`);
          ws.close();
        };
        upstream.onerror = (event) => {
          debug("ws", `${id}:${port} upstream error`, event);
          ws.close();
        };
      },
      onMessage(event, _ws) {
        if (!limiter.allow()) {
          debug("ws", `${id}:${port} message dropped, rate limit exceeded`);
          return;
        }

        const data = event.data as string | ArrayBufferLike;
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(data);
        } else {
          queued.push(data);
        }
      },
      onClose() {
        debug("ws", `${id}:${port} client disconnected`);
        upstream?.close();
      },
    };
  });
}

const getOwnedInstance = (id: string, c: any) =>
  getInstanceById(id, c.get("userId") as string);

instances.get("/:id/novnc", proxyRoute(NOVNC_PORT_INTERNAL, 200, getOwnedInstance));
instances.get("/:id/obsws", proxyRoute(OBS_WS_PORT_INTERNAL, 10, getOwnedInstance));

instances.get("/", async (c) => {
  const userId = c.get("userId") as string;
  const userInstances = await listUserInstances(userId);

  const withStatus = await Promise.all(
    userInstances.map(async (instance) => ({
      ...instance,
      docker_status: instance.container_id
        ? await getContainerStatus(instance.container_id)
        : "not_found",
    })),
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
  const body = await c.req
    .json<CreateInstanceBody>()
    .catch(() => ({}) as CreateInstanceBody);
  const resolution = body.resolution ?? DEFAULT_RESOLUTION;

  const node = await getNode(NODE_ID);

  const activeCount = await countActiveInstances(node.id);
  if (activeCount >= node.max_instances) {
    return c.json({ error: "Node has reached max_instances capacity" }, 409);
  }

  const currentVram = await sumAllocatedVram(node.id);
  if (currentVram + node.vram_mb > node.total_vram_mb) {
    return c.json(
      { error: "Allocating this instance would exceed total_vram_mb" },
      409,
    );
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
  if (!instance.container_id)
    return c.json({ error: "Instance has no container" }, 400);

  await startContainer(instance.container_id);
  const updated = await updateInstance(id, { status: "running" });

  return c.json(updated);
});

instances.post("/:id/stop", async (c) => {
  const userId = c.get("userId") as string;
  const id = c.req.param("id");

  const instance = await getInstanceById(id, userId);
  if (!instance) return c.json({ error: "Instance not found" }, 404);
  if (!instance.container_id)
    return c.json({ error: "Instance has no container" }, 400);

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
