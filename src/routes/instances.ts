import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import {
  countActiveInstances,
  deleteInstance,
  getInstanceById,
  getSubscriptionLimits,
  insertInstance,
  listUserInstances,
  updateInstance,
} from "../clients/supabase";
import { refreshNode } from "../services/node-cache";
import {
  createContainer,
  clearApiStopping,
  getContainerStatus,
  instanceTarget,
  markApiStopping,
  NOVNC_PORT_INTERNAL,
  OBS_WS_PORT_INTERNAL,
  removeContainer,
  startContainer,
  stopContainer,
} from "../clients/docker";
import { broadcastLifecycle } from "../clients/ws-server";
import { NODE_ID } from "../utils/node";
import { withInstanceLock } from "../utils/instance-lock";
import { KeyedRateLimiter, MessageRateLimiter } from "../utils/rate-limit";
import { upgradeWebSocket } from "../utils/ws";
import { debug, log } from "../utils/logger";
import { pullObsConfig, pushObsConfig, removeLocalConfig, removeS3Config, injectStreamKey, clearStreamKey, injectObsWsPassword } from "../services/obs-config";
import { syncPlugins } from "../services/plugins";
import { encryptPassword, generateVncPassword } from "../utils/crypto";
import { getStreamKey } from "../services/twitch";
import { consumeTicket, issueTicket, type Ticket, type TicketScope } from "../services/ws-tickets";
import { restartInstance, resolveVncPassword } from "../services/instance-lifecycle";
import type { AppVariables, CreateInstanceBody } from "../types";

// Upstream connect must complete within this window or the proxy gives up
// and closes the client side, instead of leaving it open indefinitely.
const CONNECT_TIMEOUT_MS = 10_000;

// Bounds how often one user can trigger container creation -- this is the
// one HTTP route that's actually expensive (spins up a Docker container),
// so it gets its own limiter rather than relying on WS-only throttling.
const createInstanceLimiter = new KeyedRateLimiter(5, 60_000);

const createInstanceSchema = z.object({
  subscription_id: z.string().uuid(),
  template: z.string().min(1).optional(),
  obs_ws_password: z.string().min(1).optional(),
  obs_ws_password_ciphertext: z.string().min(1).optional(),
  obs_ws_password_iv: z.string().min(1).optional(),
  obs_ws_password_tag: z.string().min(1).optional(),
});

const instances = new Hono<{ Variables: AppVariables }>();

// Bounds ws-ticket minting per user. Tickets are cheap to issue, but there's
// no reason to let one caller flood the store.
const wsTicketLimiter = new KeyedRateLimiter(30, 60_000);

// The WS proxy upgrades authenticate via single-use ws-tickets consumed inside
// proxyRoute -- NOT the JWT authMiddleware below. Browsers can't set an
// Authorization header on a WS upgrade, so these are registered before the
// middleware: the upgrade handler runs first and never calls next(), so the
// JWT check is skipped for them while every REST route still goes through it.
instances.get("/:id/novnc", proxyRoute(NOVNC_PORT_INTERNAL, 200, "novnc", (id, ticket) => getInstanceById(id, ticket.userId)));
instances.get("/:id/obsws", proxyRoute(OBS_WS_PORT_INTERNAL, 10, "obsws", (id, ticket) => getInstanceById(id, ticket.userId)));

instances.use("*", authMiddleware);

// Mints a short-lived, single-use ticket that the browser then puts on the WS
// URL (?ticket=...). Ownership is enforced here while the JWT is still in the
// Authorization header, so the powerful credential never rides on the socket.
instances.post("/:id/ws-ticket", async (c) => {
  const userId = c.get("userId") as string;
  const id = c.req.param("id");

  if (!wsTicketLimiter.allow(userId)) {
    return c.json({ error: "Too many ticket requests, try again later" }, 429);
  }

  const body = await c.req.json<{ scope?: string }>().catch(() => ({}) as { scope?: string });
  const scope = body.scope;
  if (scope !== "novnc" && scope !== "obsws") {
    return c.json({ error: "Invalid scope" }, 400);
  }

  const instance = await getInstanceById(id, userId);
  if (!instance) return c.json({ error: "Instance not found" }, 404);

  const ticket = issueTicket({ userId, scope, instanceId: id });

  // The novnc WS proxy is a blind byte relay -- the actual RFB auth handshake
  // happens directly between the browser's VNC client and x11vnc inside the
  // container, so the browser needs the password to complete it itself.
  // Riding along on this response (not the ticket/URL) keeps it out of logs
  // and off the WS URL query string.
  if (scope === "novnc") {
    const vncPassword = await resolveVncPassword(instance);
    return c.json({ ticket, expires_in: 30, vnc_password: vncPassword });
  }

  return c.json({ ticket, expires_in: 30 });
});

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
// ownership-free lookup (getInstanceByIdAdmin) instead of the end-user one. The
// resolved ticket is passed through so the end-user variant can still scope the
// lookup to the ticket's owner.
export function proxyRoute(
  port: number,
  messagesPerWindow: number,
  scope: TicketScope,
  getInstance: (id: string, ticket: Ticket) => Promise<{ container_name: string } | null>,
  windowMs = 200,
) {
  return upgradeWebSocket(async (c) => {
    const id = c.req.param("id") as string;
    // Single-use ticket consumed here (not the JWT) -- see the route comment in
    // this file. A null ticket means missing/expired/replayed/wrong-scope.
    const ticket = consumeTicket(c.req.query("ticket"), scope, id);
    const instance = ticket ? await getInstance(id, ticket) : null;
    const limiter = new MessageRateLimiter(messagesPerWindow, windowMs);

    let upstream: WebSocket | null = null;
    let queued: (string | ArrayBufferLike)[] = [];

    return {
      onOpen(_event, ws) {
        if (!ticket) {
          debug("ws", `${id}:${port} rejected, invalid ticket`);
          ws.close(4401, "Invalid ticket");
          return;
        }
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
  const { subscription_id: subscriptionId, template } = parsed.data;
  const obsWsPassword = parsed.data.obs_ws_password;
  const obsWsPasswordCiphertext = parsed.data.obs_ws_password_ciphertext ?? null;
  const obsWsPasswordIv = parsed.data.obs_ws_password_iv ?? null;
  const obsWsPasswordTag = parsed.data.obs_ws_password_tag ?? null;

  if (!obsWsPassword) {
    return c.json({ error: "obs_ws_password is required" }, 400);
  }

  // refreshNode, not the cached read: max_instances/max_encoder_sessions gate
  // authorization here rather than feeding telemetry, so an admin raising
  // capacity to unblock someone must take effect on the very next create — not
  // whenever the TTL happens to lapse. Creates are rare and rate-limited, so
  // the live read costs nothing.
  const [node, planLimits] = await Promise.all([
    refreshNode(),
    getSubscriptionLimits(subscriptionId),
  ]);

  if (!planLimits) {
    return c.json({ error: "Subscription not found or inactive" }, 400);
  }

  const activeCount = await countActiveInstances(node.id);
  if (activeCount >= node.max_instances) {
    return c.json({ error: "Node has reached max_instances capacity" }, 409);
  }

  // Consumer NVIDIA drivers cap concurrent NVENC sessions (8 as of the 500+
  // driver series) independent of VRAM headroom -- Quadro/RTX-A cards have no
  // such cap, which is why this is a per-node config value (null = unlimited)
  // rather than a hardcoded constant. One instance == one NVENC session in
  // this architecture, so activeCount (already computed above) is exact.
  if (node.max_encoder_sessions !== null && activeCount >= node.max_encoder_sessions) {
    return c.json({ error: "Node has reached max_encoder_sessions capacity" }, 409);
  }

  // No VRAM ledger check here: plan vram_mb allocations are far more
  // conservative than real usage (~4 GB booked vs ~300 MB measured per
  // streaming instance), so enforcing the sum against total_vram_mb starved
  // nodes long before actual VRAM pressure. vram_allocated_mb is still
  // recorded on the row for display; max_instances and max_encoder_sessions
  // remain the capacity guards.
  const instanceId = crypto.randomUUID();
  const containerName = `obs-instance-${instanceId}`;

  // Generated and encrypted server-side (unlike obsWsPassword, which the
  // client generates/encrypts today) since the VNC password never needs to
  // be seen by the panel -- x11vnc's RFB auth is purely an internal
  // obs-net-isolation measure, not something the end user interacts with.
  const vncPassword = generateVncPassword();
  const encryptedVncPassword = encryptPassword(vncPassword);

  const instance = await insertInstance({
    id: instanceId,
    user_id: userId,
    node_id: node.id,
    container_id: null,
    container_name: containerName,
    resolution: planLimits.resolution,
    status: "creating",
    vram_allocated_mb: planLimits.vram_mb,
    memory_mb: planLimits.memory_mb,
    cpu_quota: planLimits.cpu_quota,
    shm_size: planLimits.shm_size,
    config_template: planLimits.config_template ?? null,
    subscription_id: subscriptionId,
    obs_ws_password_ciphertext: obsWsPasswordCiphertext,
    obs_ws_password_iv: obsWsPasswordIv,
    obs_ws_password_tag: obsWsPasswordTag,
    vnc_password_ciphertext: encryptedVncPassword.ciphertext,
    vnc_password_iv: encryptedVncPassword.iv,
    vnc_password_tag: encryptedVncPassword.tag,
  });

  // Leading-edge signal for the fresh-launch flow (status "creating"): show
  // "Starting…" on every device while the container is provisioned.
  broadcastLifecycle(userId, instanceId, "starting");

  let containerId: string | null = null;
  try {
    await Promise.all([
      pullObsConfig(userId, instanceId, planLimits.config_template ?? template).catch((e) =>
        log("warn", "obs config pull failed, starting with empty config", {
          instanceId,
          error: (e as Error).message,
        })
      ),
      syncPlugins().catch((e) =>
        log("warn", "plugin sync failed, starting with existing local plugins", {
          instanceId,
          error: (e as Error).message,
        })
      ),
    ]);

    await injectObsWsPassword(instanceId, obsWsPassword);

    const streamKey = await getStreamKey(userId);
    if (streamKey) await injectStreamKey(instanceId, streamKey);

    containerId = await createContainer({
      instanceId,
      containerName,
      resolution: planLimits.resolution,
      obsWsPassword,
      vncPassword,
      memory_mb: planLimits.memory_mb,
      cpu_quota: planLimits.cpu_quota,
      shm_size: planLimits.shm_size,
    });
    await startContainer(containerId);

    const updated = await updateInstance(instanceId, {
      container_id: containerId,
      status: "running",
    });

    broadcastLifecycle(userId, instanceId, "started");
    return c.json(updated, 201);
  } catch (err) {
    await updateInstance(instanceId, { status: "error" });
    broadcastLifecycle(userId, instanceId, "error");
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

  try {
    const updated = await restartInstance(instance);
    return c.json(updated);
  } catch (err) {
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

  const updated = await withInstanceLock(id, async () => {
    const containerId = instance.container_id as string;
    markApiStopping(containerId);
    // Leading-edge signal: this stop is deliberate. Lets other devices show
    // "Stopping…" instead of reading the imminent socket drop as a blip.
    broadcastLifecycle(instance.user_id, id, "stopping");
    try {
      await stopContainer(containerId);

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

      await removeContainer(containerId).catch((e) =>
        debug("docker", `remove failed for ${id}: ${(e as Error).message}`)
      );

      const result = await updateInstance(id, { container_id: null, status: "stopped" });
      broadcastLifecycle(instance.user_id, id, "stopped");
      return result;
    } finally {
      clearApiStopping(containerId);
    }
  });

  return c.json(updated);
});

instances.delete("/:id", async (c) => {
  const userId = c.get("userId") as string;
  const id = c.req.param("id");

  const instance = await getInstanceById(id, userId);
  if (!instance) return c.json({ error: "Instance not found" }, 404);

  await withInstanceLock(id, async () => {
    if (instance.container_id) {
      const containerId = instance.container_id;
      markApiStopping(containerId);
      try {
        await stopContainer(containerId).catch((e) =>
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

        await removeContainer(containerId).catch((e) =>
          debug("docker", `remove failed for ${id}: ${(e as Error).message}`)
        );
      } finally {
        clearApiStopping(containerId);
      }
    }

    await removeS3Config(instance.user_id, instance.id).catch((e) =>
      log("warn", "S3 config removal failed", { instanceId: instance.id, error: (e as Error).message })
    );

    await deleteInstance(id);
    broadcastLifecycle(instance.user_id, id, "deleted");
  });

  return c.json({ success: true });
});

export default instances;
