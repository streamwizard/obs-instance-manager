import { randomUUID } from "node:crypto";
import { Hono, type Context, type Next } from "hono";
import { deleteInstance, getInstanceByIdAdmin, isAdmin, listNodeInstances, updateInstance } from "../clients/supabase";
import { getAllMetrics } from "../services/metrics";
import { createContainer, NOVNC_PORT_INTERNAL, OBS_WS_PORT_INTERNAL, removeContainer, startContainer, stopContainer } from "../clients/docker";
import { NODE_ID } from "../utils/node";
import { authMiddleware } from "../middleware/auth";
import { upgradeWebSocket } from "../utils/ws";
import { debug, log } from "../utils/logger";
import { pullObsConfig, pushObsConfig, removeLocalConfig, removeS3Config, injectObsWsPassword } from "../services/obs-config";
import { decryptPassword } from "../utils/crypto";
import { proxyRoute } from "./instances";
import { consumeTicket, issueTicket } from "../services/ws-tickets";
import { KeyedRateLimiter } from "../utils/rate-limit";
import { STREAM_INTERVAL_MS } from "../utils/constants";
import type { AppVariables } from "../types";

const admin = new Hono<{ Variables: AppVariables }>();

const wsTicketLimiter = new KeyedRateLimiter(30, 60_000);

// Twitch EventSub-style session lifecycle for the metrics stream. The client
// arms a watchdog from keepalive_timeout_seconds and reconnects if no frame
// (notification or keepalive) arrives in time -- so a half-open socket is
// detected instead of silently going stale.
const KEEPALIVE_TIMEOUT_SECONDS = 10;
const KEEPALIVE_INTERVAL_MS = 8000;

interface MetricsSocket {
  send: (data: string) => void;
}

const metricsSockets = new Set<MetricsSocket>();

// Called from index.ts on shutdown: tell every connected metrics client to
// reconnect (mint a fresh ticket and re-dial) before the process exits, so a
// node drain/redeploy doesn't surface as a dropped stream. Mirrors Twitch
// EventSub's session_reconnect.
export function notifyMetricsDrain(reconnectUrl: string) {
  const message = JSON.stringify({ type: "session_reconnect", session: { reconnect_url: reconnectUrl } });
  for (const ws of metricsSockets) {
    try {
      ws.send(message);
    } catch {
      // best-effort; the socket may already be tearing down
    }
  }
}

// Same JWT auth every end-user route uses (authMiddleware) -- the only
// difference here is the authorization check is "has the admin role"
// instead of "owns this instance".
async function requireAdmin(c: Context<{ Variables: AppVariables }>, next: Next) {
  const userId = c.get("userId");
  if (!(await isAdmin(userId))) {
    debug("auth", `user ${userId} is not an admin, rejecting ${c.req.path}`);
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
}

// WS upgrades (metrics/novnc/obsws) authenticate via single-use ws-tickets
// consumed in their handlers, NOT the JWT middleware below -- browsers can't
// send an Authorization header on a WS upgrade. Registered before admin.use()
// so the upgrade handler runs first and the JWT/admin check is skipped for
// them, while every REST route still goes through it. The admin role was
// already enforced at mint time (POST /admin/.../ws-ticket).

// Node-wide metrics for every instance on this node, wrapped in a Twitch-style
// session envelope (welcome -> notification frames, with keepalives).
admin.get(
  "/metrics/stream",
  upgradeWebSocket((c) => {
    const ticket = consumeTicket(c.req.query("ticket"), "metrics");
    let interval: ReturnType<typeof setInterval> | null = null;
    let keepalive: ReturnType<typeof setInterval> | null = null;
    let lastSendAt = 0;
    let registered: MetricsSocket | null = null;

    const send = (ws: MetricsSocket, message: unknown) => {
      ws.send(JSON.stringify(message));
      lastSendAt = Date.now();
    };

    const sendMetrics = async (ws: MetricsSocket) => {
      const nodeInstances = await listNodeInstances(NODE_ID);
      const payload = await getAllMetrics(nodeInstances);
      send(ws, { type: "notification", payload });
      debug("ws", `metrics/stream sent payload for ${nodeInstances.length} instance(s)`);
    };

    return {
      onOpen(_event, ws) {
        if (!ticket) {
          ws.close(4401, "Invalid ticket");
          return;
        }
        debug("ws", "metrics/stream client connected");
        registered = ws;
        metricsSockets.add(ws);

        send(ws, {
          type: "session_welcome",
          session: { id: randomUUID(), keepalive_timeout_seconds: KEEPALIVE_TIMEOUT_SECONDS },
        });

        sendMetrics(ws).catch((err) => debug("ws", "metrics/stream send failed", err));
        interval = setInterval(() => {
          sendMetrics(ws).catch((err) => debug("ws", "metrics/stream send failed", err));
        }, STREAM_INTERVAL_MS);

        // Only emits if metric generation has stalled long enough that the
        // client would otherwise trip its watchdog.
        keepalive = setInterval(() => {
          if (Date.now() - lastSendAt >= KEEPALIVE_INTERVAL_MS) {
            send(ws, { type: "session_keepalive" });
          }
        }, KEEPALIVE_INTERVAL_MS);
      },
      onClose() {
        debug("ws", "metrics/stream client disconnected");
        if (interval) clearInterval(interval);
        if (keepalive) clearInterval(keepalive);
        if (registered) metricsSockets.delete(registered);
      },
    };
  })
);

admin.get("/instances/:id/novnc", proxyRoute(NOVNC_PORT_INTERNAL, 200, "novnc", (id) => getInstanceByIdAdmin(id)));
admin.get("/instances/:id/obsws", proxyRoute(OBS_WS_PORT_INTERNAL, 10, "obsws", (id) => getInstanceByIdAdmin(id)));

admin.use("*", authMiddleware, requireAdmin);

// Mints the single-use ws-tickets the browser puts on the WS URL. Admin role
// is enforced here (via requireAdmin) while the JWT is still in the
// Authorization header -- the credential never rides on the socket.
admin.post("/ws-ticket", async (c) => {
  const userId = c.get("userId") as string;
  if (!wsTicketLimiter.allow(userId)) {
    return c.json({ error: "Too many ticket requests, try again later" }, 429);
  }

  const body = await c.req.json<{ scope?: string }>().catch(() => ({}) as { scope?: string });
  if (body.scope !== "metrics") {
    return c.json({ error: "Invalid scope" }, 400);
  }

  const ticket = issueTicket({ userId, scope: "metrics" });
  return c.json({ ticket, expires_in: 30 });
});

admin.post("/instances/:id/ws-ticket", async (c) => {
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

  const instance = await getInstanceByIdAdmin(id);
  if (!instance) return c.json({ error: "Instance not found" }, 404);

  const ticket = issueTicket({ userId, scope, instanceId: id });
  return c.json({ ticket, expires_in: 30 });
});

// Admin-scoped start/stop -- same docker actions as the end-user
// /instances/:id/start|stop routes, but looked up without an owning-user
// filter since the caller's authority here comes from the admin role check,
// not instance ownership.
admin.post("/instances/:id/start", async (c) => {
  const id = c.req.param("id");

  const instance = await getInstanceByIdAdmin(id);
  if (!instance) return c.json({ error: "Instance not found" }, 404);
  if (instance.status === "running") return c.json({ error: "Instance is already running" }, 400);

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

  let containerId: string | null = null;
  try {
    containerId = await createContainer({
      instanceId: instance.id,
      containerName: instance.container_name,
      resolution: instance.resolution,
      obsWsPassword,
      memory_mb: instance.memory_mb,
      cpu_quota: instance.cpu_quota,
      shm_size: instance.shm_size,
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

admin.post("/instances/:id/stop", async (c) => {
  const id = c.req.param("id");

  const instance = await getInstanceByIdAdmin(id);
  if (!instance) return c.json({ error: "Instance not found" }, 404);
  if (!instance.container_id) return c.json({ error: "Instance has no container" }, 400);

  await stopContainer(instance.container_id);

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

admin.delete("/instances/:id", async (c) => {
  const id = c.req.param("id");

  const instance = await getInstanceByIdAdmin(id);
  if (!instance) return c.json({ error: "Instance not found" }, 404);

  if (instance.container_id) {
    await stopContainer(instance.container_id).catch((e) =>
      debug("docker", `stop failed for ${id}: ${(e as Error).message}`)
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

export default admin;
