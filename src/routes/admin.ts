import { Hono, type Context, type Next } from "hono";
import { getInstanceByIdAdmin, isAdmin, listNodeInstances, updateInstance } from "../lib/supabase";
import { getAllMetrics } from "../lib/metrics";
import { NOVNC_PORT_INTERNAL, OBS_WS_PORT_INTERNAL, startContainer, stopContainer } from "../lib/docker";
import { NODE_ID } from "../lib/node";
import { authMiddleware } from "../middleware/auth";
import { upgradeWebSocket } from "../lib/ws";
import { debug } from "../lib/logger";
import { proxyRoute } from "./instances";
import { STREAM_INTERVAL_MS } from "../lib/constants";
import type { AppVariables } from "../types";

const admin = new Hono<{ Variables: AppVariables }>();

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

admin.use("*", authMiddleware, requireAdmin);

// Node-wide metrics for every instance on this node, not just one user's —
// this is what the panel's admin Nodes page consumes, gated by the caller's
// own Supabase JWT having the admin role (same as every other route here,
// just a role check instead of an ownership check).
admin.get(
  "/metrics/stream",
  upgradeWebSocket(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

    const sendMetrics = async (ws: { send: (data: string) => void }) => {
      const nodeInstances = await listNodeInstances(NODE_ID);
      const payload = await getAllMetrics(nodeInstances);
      ws.send(JSON.stringify(payload));
      debug("ws", `metrics/stream sent payload for ${nodeInstances.length} instance(s)`);
    };

    return {
      onOpen(_event, ws) {
        debug("ws", "metrics/stream client connected");
        sendMetrics(ws).catch((err) => debug("ws", "metrics/stream send failed", err));
        interval = setInterval(() => {
          sendMetrics(ws).catch((err) => debug("ws", "metrics/stream send failed", err));
        }, STREAM_INTERVAL_MS);
      },
      onClose() {
        debug("ws", "metrics/stream client disconnected");
        if (interval) clearInterval(interval);
      },
    };
  })
);

// Admin-scoped start/stop -- same docker actions as the end-user
// /instances/:id/start|stop routes, but looked up without an owning-user
// filter since the caller's authority here comes from the admin role check,
// not instance ownership.
admin.post("/instances/:id/start", async (c) => {
  const id = c.req.param("id");

  const instance = await getInstanceByIdAdmin(id);
  if (!instance) return c.json({ error: "Instance not found" }, 404);
  if (!instance.container_id)
    return c.json({ error: "Instance has no container" }, 400);

  await startContainer(instance.container_id);
  const updated = await updateInstance(id, { status: "running" });

  return c.json(updated);
});

admin.post("/instances/:id/stop", async (c) => {
  const id = c.req.param("id");

  const instance = await getInstanceByIdAdmin(id);
  if (!instance) return c.json({ error: "Instance not found" }, 404);
  if (!instance.container_id)
    return c.json({ error: "Instance has no container" }, 400);

  await stopContainer(instance.container_id);
  const updated = await updateInstance(id, { status: "stopped" });

  return c.json(updated);
});

// Same noVNC/obsws proxy the end-user routes expose, just backed by the
// ownership-free admin lookup so any admin can watch/control any instance
// on this node, gated by the role check above rather than instance ownership.
admin.get("/instances/:id/novnc", proxyRoute(NOVNC_PORT_INTERNAL, 200, (id) => getInstanceByIdAdmin(id)));
admin.get("/instances/:id/obsws", proxyRoute(OBS_WS_PORT_INTERNAL, 10, (id) => getInstanceByIdAdmin(id)));

export default admin;
