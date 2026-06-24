import { Hono, type Context, type Next } from "hono";
import { isAdmin, listNodeInstances } from "../lib/supabase";
import { getAllMetrics } from "../lib/metrics";
import { NODE_ID } from "../lib/node";
import { authMiddleware } from "../middleware/auth";
import { upgradeWebSocket } from "../lib/ws";
import { debug } from "../lib/logger";
import type { AppVariables } from "../types";

const STREAM_INTERVAL_MS = 3000;

const admin = new Hono<{ Variables: AppVariables }>();

// Same JWT auth every end-user route uses (authMiddleware) -- the only
// difference here is the authorization check is "has the admin role"
// instead of "owns this instance".
async function requireAdmin(c: Context<{ Variables: AppVariables }>, next: Next) {
  const userId = c.get("userId");
  if (!(await isAdmin(userId))) {
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

export default admin;
