import { Hono } from "hono";
import { z } from "zod";
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
} from "../clients/supabase";
import {
  createContainer,
  getContainerStatus,
  instanceTarget,
  NOVNC_PORT_INTERNAL,
  OBS_WS_PORT_INTERNAL,
  removeContainer,
  startContainer,
  stopContainer,
} from "../clients/docker";
import { NODE_ID } from "../utils/node";
import { KeyedRateLimiter, MessageRateLimiter } from "../utils/rate-limit";
import { upgradeWebSocket } from "../utils/ws";
import { debug, log } from "../utils/logger";
import { pullObsConfig, pushObsConfig, removeLocalConfig, removeS3Config, injectStreamKey, clearStreamKey, injectObsWsPassword } from "../services/obs-config";
import { decryptPassword } from "../utils/crypto";
import { getStreamKey } from "../services/twitch";
import type { AppVariables, CreateInstanceBody } from "../types";

const DEFAULT_RESOLUTION = "1920x1080";
const RESOLUTION_RE = /^(\d+)x(\d+)$/;
const MAX_RESOLUTION_WIDTH = 3840;
const MAX_RESOLUTION_HEIGHT = 2160;

// Upstream connect must complete within this window or the proxy gives up
// and closes the client side, instead of leaving it open indefinitely.
const CONNECT_TIMEOUT_MS = 10_000;

// Bounds how often one user can trigger container creation -- this is the
// one HTTP route that's actually expensive (spins up a Docker container),
// so it gets its own limiter rather than relying on WS-only throttling.
const createInstanceLimiter = new KeyedRateLimiter(5, 60_000);

const createInstanceSchema = z.object({
  resolution: z
    .string()
    .regex(RESOLUTION_RE, "Invalid resolution format, expected WIDTHxHEIGHT")
    .refine((val) => {
      const match = RESOLUTION_RE.exec(val)!;
      const width = Number(match[1]);
      const height = Number(match[2]);
      return width > 0 && height > 0 && width <= MAX_RESOLUTION_WIDTH && height <= MAX_RESOLUTION_HEIGHT;
    }, `Resolution out of bounds, max ${MAX_RESOLUTION_WIDTH}x${MAX_RESOLUTION_HEIGHT}`)
    .optional(),
  template: z.string().min(1).optional(),
  obs_ws_password: z.string().min(1).optional(),
});

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

        const connectTimeout = setTimeout(() => {
          debug("ws", `${id}:${port} upstream connect timeout`);
          ws.close(4408, "Upstream timeout");
        }, CONNECT_TIMEOUT_MS);

        upstream.onopen = () => {
          clearTimeout(connectTimeout);
          debug(
            "ws",
            `${id}:${port} upstream connected, flushing ${queued.length} queued message(s)`,
          );
          for (const message of queued) upstream?.send(message);
          queued = [];
        };
        upstream.onmessage = (event) => ws.send(event.data);
        upstream.onclose = () => {
          clearTimeout(connectTimeout);
          debug("ws", `${id}:${port} upstream closed`);
          ws.close();
        };
        upstream.onerror = (event) => {
          clearTimeout(connectTimeout);
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

  if (!createInstanceLimiter.allow(userId)) {
    return c.json({ error: "Too many instance creation requests, try again later" }, 429);
  }

  const body = await c.req
    .json<CreateInstanceBody>()
    .catch(() => ({}) as CreateInstanceBody);

  const parsed = createInstanceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid request body" }, 400);
  }
  const resolution = parsed.data.resolution ?? DEFAULT_RESOLUTION;
  const template = parsed.data.template;
  const obsWsPassword = parsed.data.obs_ws_password;

  if (!obsWsPassword) {
    return c.json({ error: "obs_ws_password is required" }, 400);
  }

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
    obs_ws_password_ciphertext: null,
    obs_ws_password_iv: null,
    obs_ws_password_tag: null,
  });

  let containerId: string | null = null;
  try {
    await pullObsConfig(userId, instanceId, template).catch((e) =>
      log("warn", "obs config pull failed, starting with empty config", {
        instanceId,
        error: (e as Error).message,
      })
    );

    await injectObsWsPassword(instanceId, obsWsPassword);

    const streamKey = await getStreamKey(userId);
    if (streamKey) await injectStreamKey(instanceId, streamKey);

    containerId = await createContainer({
      instanceId,
      containerName,
      node,
      resolution,
      obsWsPassword,
    });
    await startContainer(containerId);

    const updated = await updateInstance(instanceId, {
      container_id: containerId,
      status: "running",
    });

    return c.json(updated, 201);
  } catch (err) {
    await updateInstance(instanceId, { status: "error" });
    if (containerId) {
      await removeContainer(containerId).catch((e) =>
        debug("docker", `cleanup of orphaned container ${containerId} failed: ${(e as Error).message}`),
      );
    }
    return c.json({ error: (err as Error).message }, 500);
  }
});

instances.post("/:id/start", async (c) => {
  const userId = c.get("userId") as string;
  const id = c.req.param("id");

  const instance = await getInstanceById(id, userId);
  if (!instance) return c.json({ error: "Instance not found" }, 404);
  if (instance.status === "running") return c.json({ error: "Instance is already running" }, 400);

  const node = await getNode(NODE_ID);

  await pullObsConfig(instance.user_id, instance.id).catch((e) =>
    log("warn", "obs config pull failed, starting with empty config", {
      instanceId: instance.id,
      error: (e as Error).message,
    })
  );

  if (!instance.obs_ws_password_ciphertext || !instance.obs_ws_password_iv || !instance.obs_ws_password_tag) {
    return c.json({ error: "Instance is missing OBS WebSocket password." }, 500);
  }

  const obsWsPassword = decryptPassword(
    instance.obs_ws_password_ciphertext,
    instance.obs_ws_password_iv,
    instance.obs_ws_password_tag,
  );

  await injectObsWsPassword(instance.id, obsWsPassword);

  const streamKey = await getStreamKey(instance.user_id);
  if (streamKey) await injectStreamKey(instance.id, streamKey);

  let containerId: string | null = null;
  try {
    containerId = await createContainer({
      instanceId: instance.id,
      containerName: instance.container_name,
      node,
      resolution: instance.resolution,
      obsWsPassword,
    });
    await startContainer(containerId);
    const updated = await updateInstance(id, { container_id: containerId, status: "running" });
    return c.json(updated);
  } catch (err) {
    await updateInstance(id, { status: "error" });
    if (containerId) {
      await removeContainer(containerId).catch((e) =>
        debug("docker", `cleanup of orphaned container ${containerId} failed: ${(e as Error).message}`)
      );
    }
    return c.json({ error: (err as Error).message }, 500);
  }
});

instances.post("/:id/stop", async (c) => {
  const userId = c.get("userId") as string;
  const id = c.req.param("id");

  const instance = await getInstanceById(id, userId);
  if (!instance) return c.json({ error: "Instance not found" }, 404);
  if (!instance.container_id)
    return c.json({ error: "Instance has no container" }, 400);

  await stopContainer(instance.container_id);

  await clearStreamKey(instance.id).catch((e) =>
    log("warn", "failed to clear stream key before push", { instanceId: instance.id, error: (e as Error).message })
  );

  await pushObsConfig(instance.user_id, instance.id).catch((e) =>
    log("warn", "obs config push failed after stop", {
      instanceId: instance.id,
      error: (e as Error).message,
    })
  );

  await removeLocalConfig(instance.id).catch((e) =>
    log("warn", "failed to remove local config dir after stop", {
      instanceId: instance.id,
      error: (e as Error).message,
    })
  );

  await removeContainer(instance.container_id).catch((e) =>
    debug("docker", `remove failed for ${id}: ${(e as Error).message}`)
  );

  const updated = await updateInstance(id, { container_id: null, status: "stopped" });

  return c.json(updated);
});

instances.delete("/:id", async (c) => {
  const userId = c.get("userId") as string;
  const id = c.req.param("id");

  const instance = await getInstanceById(id, userId);
  if (!instance) return c.json({ error: "Instance not found" }, 404);

  if (instance.container_id) {
    await stopContainer(instance.container_id).catch((e) =>
      debug("docker", `stop failed for ${id}: ${(e as Error).message}`)
    );

    await clearStreamKey(instance.id).catch((e) =>
      log("warn", "failed to clear stream key before delete push", { instanceId: instance.id, error: (e as Error).message })
    );

    await pushObsConfig(instance.user_id, instance.id).catch((e) =>
      log("warn", "obs config push failed before delete", {
        instanceId: instance.id,
        error: (e as Error).message,
      })
    );

    await removeLocalConfig(instance.id).catch((e) =>
      log("warn", "failed to remove local config dir before delete", {
        instanceId: instance.id,
        error: (e as Error).message,
      })
    );

    await removeContainer(instance.container_id).catch((e) =>
      debug("docker", `remove failed for ${id}: ${(e as Error).message}`)
    );
  }

  await removeS3Config(instance.user_id, instance.id).catch((e) =>
    log("warn", "S3 config removal failed", { instanceId: instance.id, error: (e as Error).message })
  );

  await deleteInstance(id);

  return c.json({ success: true });
});

export default instances;
