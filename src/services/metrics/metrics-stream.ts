import { randomUUID } from "node:crypto";
import { upgradeWebSocket } from "hono/bun";
import { consumeTicket } from "@/services/auth/ws-tickets";
import { getCachedNodeInstances } from "@/services/cache/instance-cache";
import { getAllMetrics } from "@/services/metrics/metrics";
import { STREAM_INTERVAL_MS } from "@/utils/constants";
import { debug } from "@/utils/logger";

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

// Called from shutdown.ts: tell every connected metrics client to
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

// Node-wide metrics for every instance on this node, wrapped in a Twitch-style
// session envelope (welcome -> notification frames, with keepalives).
// Authenticates via a single-use "metrics" ws-ticket, so it must be mounted
// before the JWT middleware (browsers can't set Authorization on a WS upgrade).
export const metricsStreamHandler = upgradeWebSocket((c) => {
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
    // Cached: admin start/stop/delete invalidate it, so a state change this
    // process made is visible on the next 3s tick — same as when this
    // fetched live, minus the rest-api round trip per tick per socket.
    const nodeInstances = await getCachedNodeInstances();
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
});
