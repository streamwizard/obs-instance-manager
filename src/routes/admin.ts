import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context, type Next } from "hono";
import { listNodeInstances } from "../lib/supabase";
import { getAllMetrics } from "../lib/metrics";
import { NODE_ADMIN_TOKEN, NODE_ID } from "../lib/node";
import { upgradeWebSocket } from "../lib/ws";
import { debug } from "../lib/logger";
import type { AppVariables } from "../types";

const STREAM_INTERVAL_MS = 3000;

const admin = new Hono<{ Variables: AppVariables }>();

// Hash both sides to a fixed length before comparing so a length mismatch on
// the raw token can't short-circuit the comparison (timingSafeEqual throws
// on mismatched lengths, which itself leaks timing/length information).
function constantTimeTokenMatch(candidate: string): boolean {
  const expected = createHash("sha256").update(NODE_ADMIN_TOKEN).digest();
  const actual = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(expected, actual);
}

async function requireNodeAdminToken(c: Context<{ Variables: AppVariables }>, next: Next) {
  const header = c.req.header("Authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  const token = bearer ?? c.req.query("token");

  if (!token || !constantTimeTokenMatch(token)) {
    return c.json({ error: "Invalid or missing node admin token" }, 401);
  }

  await next();
}

admin.use("*", requireNodeAdminToken);

// Node-wide metrics for every instance on this node, not just one user's —
// this is what the panel's admin Nodes page consumes, never exposed to
// end-user browsers directly.
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
