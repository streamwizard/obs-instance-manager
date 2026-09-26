import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { instanceTarget, SELKIES_PORT_INTERNAL } from "../clients/docker";
import { consumeTicket, type Ticket } from "../services/ws-tickets";
import {
  SELKIES_COOKIE,
  SELKIES_SESSION_TTL_MS,
  sessionKeyFrom,
  signSession,
  verifySession,
  type SelkiesSession,
} from "../services/selkies-session";
import { MessageRateLimiter } from "../utils/rate-limit";
import { upgradeWebSocket } from "../utils/ws";
import { debug, log } from "../utils/logger";

// Reverse proxy for the Selkies web viewer running inside an instance
// container (port 8080 on obs-net). Mounted at /instances/:id/selkies/* and
// /admin/instances/:id/selkies/*. The panel iframes the entry URL with a
// ws-ticket (scope "selkies"); that is swapped for a signed session cookie
// (services/selkies-session.ts) that every asset request and the WebSocket
// upgrade then present. The Selkies client builds every URL relative to its
// own page path, so serving it under this prefix needs no rewriting.

const CONNECT_TIMEOUT_MS = 10_000;

const sessionKey = sessionKeyFrom(process.env.TOKEN_ENCRYPTION_KEY ?? "");

// "Lax" works when the panel and this API share a site (localhost:3001 and
// localhost:3100 do). A panel on another site iframing the node's tunnel
// hostname needs "None", which browsers only accept together with Secure.
const SAME_SITE = (process.env.SELKIES_COOKIE_SAMESITE ?? "Lax") as "Lax" | "Strict" | "None";

// Only what a browser needs to fetch static assets and the API. Above all no
// Cookie or Authorization: the panel's Supabase cookies alone can exceed
// Selkies' 8 KiB aiohttp header limit ("Got more than 8190 bytes"), and none
// of our credentials belong inside the container. No Accept-Encoding either,
// so the body comes back as-is and Content-Length/Encoding stay truthful.
const FORWARD_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "content-length",
  "if-none-match",
  "if-modified-since",
  "range",
  "user-agent",
];

const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "set-cookie"];

const STARTING_PAGE = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2">
<title>Starting</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#000;color:#fffa;font:14px system-ui">
OBS is starting&hellip;</body>`;

type GetInstance = (id: string, ticket: Ticket) => Promise<{ container_name: string } | null>;

// "/instances/<id>/selkies/assets/x.js" -> { base: "/instances/<id>/selkies", rest: "/assets/x.js" }
function splitPath(path: string, id: string): { base: string; rest: string } {
  const marker = `/${id}/selkies`;
  const at = path.indexOf(marker);
  const base = path.slice(0, at + marker.length);
  return { base, rest: path.slice(base.length) };
}

function sessionFor(c: Context, id: string): SelkiesSession | null {
  return verifySession(sessionKey, getCookie(c, SELKIES_COOKIE), id);
}

function searchWithout(url: URL, param: string): string {
  const params = new URLSearchParams(url.search);
  params.delete(param);
  const s = params.toString();
  return s ? `?${s}` : "";
}

const websocketRelay = upgradeWebSocket((c) => {
  const id = c.req.param("id") as string;
  const session = sessionFor(c, id);
  const url = new URL(c.req.url);
  const { rest } = splitPath(url.pathname, id);
  // Mouse motion and keystrokes are high-frequency, like noVNC's RFB stream.
  const limiter = new MessageRateLimiter(2000, 200);

  let upstream: WebSocket | null = null;
  let queued: (string | ArrayBufferLike)[] = [];
  let dropped = 0;

  return {
    onOpen(_event, ws) {
      if (!session) {
        ws.close(4401, "Invalid session");
        return;
      }
      const target = `ws://${instanceTarget(session.containerName, SELKIES_PORT_INTERNAL)}${rest}${url.search}`;
      debug("ws", `${id}:selkies client connected, dialing ${target}`);
      upstream = new WebSocket(target);
      upstream.binaryType = "arraybuffer";

      const timeout = setTimeout(() => ws.close(4408, "Upstream timeout"), CONNECT_TIMEOUT_MS);
      upstream.onopen = () => {
        clearTimeout(timeout);
        for (const m of queued) upstream?.send(m);
        queued = [];
      };
      upstream.onmessage = (event) => ws.send(event.data);
      upstream.onclose = (event) => {
        clearTimeout(timeout);
        // Pass Selkies' own close codes through (e.g. 4000-range "another
        // client took over") so the viewer can show why.
        const code = event.code >= 3000 && event.code < 5000 ? event.code : 1000;
        ws.close(code, event.reason);
      };
      upstream.onerror = () => {
        clearTimeout(timeout);
        ws.close(1011, "Upstream error");
      };
    },
    onMessage(event) {
      if (!limiter.allow()) {
        if (++dropped === 1) log("warn", "selkies proxy dropping client frames, rate limit exceeded", { id });
        return;
      }
      const data = event.data as string | ArrayBufferLike;
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(data);
      else queued.push(data);
    },
    onClose() {
      debug("ws", `${id}:selkies client disconnected`);
      upstream?.close();
    },
  };
});

async function forwardHttp(c: Context, session: SelkiesSession, base: string, rest: string, search: string) {
  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  const method = c.req.method;
  const hasBody = method !== "GET" && method !== "HEAD";
  const target = `http://${instanceTarget(session.containerName, SELKIES_PORT_INTERNAL)}${rest || "/"}${search}`;

  let res: Response;
  try {
    res = await fetch(target, {
      method,
      headers,
      body: hasBody ? c.req.raw.body : undefined,
      redirect: "manual",
      // Required by fetch for a streamed request body.
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);
  } catch (err) {
    debug("http", `selkies upstream ${target} unreachable`, (err as Error).message);
    // The panel opens the viewer as soon as the instance row says running,
    // which is before Selkies inside it listens. The page is what lands in
    // the iframe, so keep retrying there instead of showing a raw 502.
    if (rest === "/") return c.html(STARTING_PAGE, 503, { "Retry-After": "2" });
    return c.json({ error: "Viewer not reachable (instance starting or stopped?)" }, 502);
  }

  const out = new Headers(res.headers);
  for (const h of HOP_BY_HOP) out.delete(h);
  // Keep upstream redirects inside this proxy's prefix.
  const location = out.get("location");
  if (location?.startsWith("/")) out.set("location", `${base}${location}`);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

export function selkiesProxy(getInstance: GetInstance) {
  return async (c: Context, next: () => Promise<void>) => {
    const id = c.req.param("id") as string;
    const url = new URL(c.req.url);
    const { base, rest } = splitPath(url.pathname, id);

    // Entry: spend the ticket, set the session, and land on a clean URL. The
    // trailing slash matters: the client resolves "api/websockets" and
    // "./assets/..." against its own directory.
    const ticketParam = url.searchParams.get("ticket");
    if (ticketParam !== null) {
      const ticket = consumeTicket(ticketParam, "selkies", id);
      const instance = ticket ? await getInstance(id, ticket) : null;
      if (!ticket || !instance) {
        debug("http", `${id}:selkies entry rejected (${ticket ? "instance not found" : "invalid ticket"})`);
        return c.text(ticket ? "Instance not found" : "Invalid or expired link, reopen the viewer", ticket ? 404 : 401);
      }
      const expiresAt = Date.now() + SELKIES_SESSION_TTL_MS;
      setCookie(
        c,
        SELKIES_COOKIE,
        signSession(sessionKey, { instanceId: id, userId: ticket.userId, containerName: instance.container_name, expiresAt }),
        {
          path: base,
          httpOnly: true,
          sameSite: SAME_SITE,
          secure: SAME_SITE === "None" || url.protocol === "https:",
          maxAge: Math.floor(SELKIES_SESSION_TTL_MS / 1000),
        },
      );
      return c.redirect(`${base}/${searchWithout(url, "ticket")}`, 302);
    }

    if (rest === "") return c.redirect(`${base}/${url.search}`, 301);

    const session = sessionFor(c, id);
    if (!session) return c.text("Viewer session expired, reopen the viewer", 401);

    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      return websocketRelay(c, next);
    }
    return forwardHttp(c, session, base, rest, url.search);
  };
}
