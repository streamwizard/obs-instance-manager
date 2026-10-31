import { instanceTarget } from "@/clients/docker";
import { consumeTicket, type Ticket, type TicketScope } from "@/services/auth/ws-tickets";
import { MessageRateLimiter } from "@/utils/rate-limit";
import { upgradeWebSocket } from "hono/bun";
import { debug, log } from "@/utils/logger";

// Upstream connect must complete within this window or the proxy gives up
// and closes the client side, instead of leaving it open indefinitely.
const CONNECT_TIMEOUT_MS = 10_000;

// Bridges a browser websocket connection to an instance container's internal
// noVNC/obs-websocket port over the shared `obs-net` Docker network. Instance
// containers publish no host ports, so this proxy is the only path in.
//
// Authenticates via a single-use ws-ticket on the URL (?ticket=...), not the
// JWT authMiddleware: browsers can't set an Authorization header on a WS
// upgrade, so routes using this must be registered before that middleware.
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
    // A null ticket means missing/expired/replayed/wrong-scope.
    const ticket = consumeTicket(c.req.query("ticket"), scope, id);
    const instance = ticket ? await getInstance(id, ticket) : null;
    const limiter = new MessageRateLimiter(messagesPerWindow, windowMs);

    let upstream: WebSocket | null = null;
    let queued: (string | ArrayBufferLike)[] = [];
    let droppedFrames = 0;

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
          // Dropping a frame out of the RFB byte stream can lose input events
          // (clipboard cut-text especially) or desync the parser entirely, so
          // this must be loud enough to spot -- warn once per connection.
          droppedFrames += 1;
          if (droppedFrames === 1) {
            log("warn", "ws proxy dropping client frames, rate limit exceeded", { id, port });
          }
          debug("ws", `${id}:${port} message dropped, rate limit exceeded (${droppedFrames} total)`);
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
