import type { Context } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { instanceTarget, SELKIES_PORT_INTERNAL } from "@/clients/docker";
import { consumeTicket, type Ticket } from "@/services/auth/ws-tickets";
import { ViewerSessions, type ViewerSession } from "@/services/auth/selkies-viewer-sessions";
import { getInstanceSecrets } from "@/services/cache/instance-secrets-cache";
import { containerNameForInstance } from "@/utils/container-name";
import { isStaticPath, tokenFromBearer, tokenFromCookie, tokenFromProtocols } from "@/services/proxy/selkies-request";
import { clientFileResponse, hardenUpstreamHeaders, selkiesWebRoot } from "@/services/proxy/selkies-client-files";
import { RELAY_SCRIPT_PATH, relayScriptResponse, viewerPageResponse } from "@/services/proxy/viewer-relay/viewer-page";
import { MessageRateLimiter } from "@/utils/rate-limit";
import { debug, log } from "@/utils/logger";

// Reverse proxy for the Selkies web viewer running inside an instance
// container (port 8080 on obs-net). Mounted at /instances/:id/selkies/* and
// /admin/instances/:id/selkies/*. The Selkies client builds every URL
// relative to its own page path, so serving it under this prefix needs no
// rewriting.
//
// Auth works like the old noVNC socket, minus the reconnect minting the panel
// can't do from here (see services/auth/selkies-viewer-sessions.ts):
// - The panel opens <prefix>/#token=<ticket>. The fragment never reaches a
//   server, so the ticket stays out of URLs and logs.
// - Static client files (HTML, JS, CSS, codecs) load without it. OIM serves
//   them from its own copy of the Selkies client (selkies-client-files.ts),
//   never from the container, so nothing running inside an instance can put
//   a page of its own on this origin. They hold nothing per user. The entry
//   page itself is OIM's (viewer-relay/viewer-page.ts): the Selkies client
//   plus a relay for the StreamWizard app that frames it.
// - Everything under /api/ needs the ticket: the client sends it as
//   "Authorization: Bearer" on fetches (or its own "selkies_token" cookie
//   where it can't set a header) and as the "selkies.token.<b64url>"
//   WebSocket subprotocol. The first use spends the ticket and opens a viewer
//   session; every WebSocket connect checks instance ownership again.
//
// Only /api/ and the WebSocket reach the container. Its HTTP answers get a
// sandbox CSP and nosniff, so they stay data even if a browser opens one.
//
// Selkies itself keeps basic auth on, with the instance's own password
// (rest-api's vnc_password): every instance shares obs-net, so without it one
// container could reach another tenant's desktop. This proxy adds that
// Authorization header upstream; the browser never sees the password.

const CONNECT_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 2_000;

// Only what a browser needs to fetch static assets and the API. Above all no
// Cookie or Authorization from the browser: site-wide cookies alone can exceed
// Selkies' 8 KiB aiohttp header limit ("Got more than 8190 bytes"), and the
// browser's Bearer token is ours, not Selkies'. The only Authorization
// upstream is the instance's own basic auth. No Accept-Encoding either, so the
// body comes back as-is and Content-Length/Encoding stay truthful.
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

// Selkies' basic-auth user, fixed by the image's entrypoint.
const SELKIES_USER = "app";

type GetInstance = (id: string, ticket: Ticket) => Promise<{ container_name: string } | null>;

interface UpgradeContext {
  authorization: string;
  session: ViewerSession;
  sessions: ViewerSessions;
}

// The WebSocket handler below is set up synchronously, so what it needs is
// looked up before the upgrade and handed over per request.
const pendingUpgrades = new WeakMap<Request, UpgradeContext>();

// "/instances/<id>/selkies/assets/x.js" -> { base: "/instances/<id>/selkies", rest: "/assets/x.js" }
function splitPath(path: string, id: string): { base: string; rest: string } {
  const marker = `/${id}/selkies`;
  const at = path.indexOf(marker);
  const base = path.slice(0, at + marker.length);
  return { base, rest: path.slice(base.length) };
}

async function upstreamAuthorization(instanceId: string): Promise<string> {
  const { vnc_password } = await getInstanceSecrets(instanceId);
  return `Basic ${Buffer.from(`${SELKIES_USER}:${vnc_password}`).toString("base64")}`;
}

function searchWithout(url: URL, param: string): string {
  const params = new URLSearchParams(url.search);
  params.delete(param);
  const s = params.toString();
  return s ? `?${s}` : "";
}

const websocketRelay = upgradeWebSocket((c) => {
  const id = c.req.param("id") as string;
  const ctx = pendingUpgrades.get(c.req.raw);
  const url = new URL(c.req.url);
  const { rest } = splitPath(url.pathname, id);
  // Mouse motion and keystrokes are high-frequency.
  const limiter = new MessageRateLimiter(2000, 200);

  let upstream: WebSocket | null = null;
  let queued: (string | ArrayBufferLike)[] = [];
  let dropped = 0;
  let counted = false;

  return {
    onOpen(_event, ws) {
      if (!ctx) {
        ws.close(4401, "Invalid session");
        return;
      }
      ctx.sessions.socketOpened(ctx.session);
      counted = true;
      // Never pass the client's subprotocols on: they carry its token.
      const target = `ws://${instanceTarget(ctx.session.containerName, SELKIES_PORT_INTERNAL)}${rest}${searchWithout(url, "token")}`;
      debug("ws", `${id}:selkies client connected, dialing ${target}`);
      // Bun's WebSocket client accepts extra upgrade headers.
      upstream = new WebSocket(target, { headers: { Authorization: ctx.authorization } });
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
      if (ctx && counted) ctx.sessions.socketClosed(ctx.session);
      upstream?.close();
    },
  };
});

async function forwardHttp(c: Context, containerName: string, authorization: string, base: string, rest: string) {
  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  headers.set("authorization", authorization);
  const method = c.req.method;
  const hasBody = method !== "GET" && method !== "HEAD";
  const search = searchWithout(new URL(c.req.url), "token");
  const target = `http://${instanceTarget(containerName, SELKIES_PORT_INTERNAL)}${rest}${search}`;

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
    return c.json({ error: "Viewer not reachable (instance starting or stopped?)" }, 502);
  }

  const out = hardenUpstreamHeaders(new Headers(res.headers));
  for (const h of HOP_BY_HOP) out.delete(h);
  // Keep upstream redirects inside this proxy's prefix.
  const location = out.get("location");
  if (location?.startsWith("/")) out.set("location", `${base}${location}`);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

// Whether Selkies inside the container answers yet.
async function upstreamReady(containerName: string, authorization: string): Promise<boolean> {
  try {
    const res = await fetch(`http://${instanceTarget(containerName, SELKIES_PORT_INTERNAL)}/api/health`, {
      headers: { authorization },
      redirect: "manual",
      signal: AbortSignal.timeout(READY_TIMEOUT_MS),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

export function selkiesProxy(getInstance: GetInstance, webRoot = selkiesWebRoot()) {
  // One store per mount, so a user-route session never opens the admin route.
  const sessions = new ViewerSessions();
  // First uses of the same token in flight (the client may probe the API and
  // open its socket at once); the ticket can only be spent once.
  const starting = new Map<string, Promise<ViewerSession | null>>();

  async function sessionFor(token: string, id: string, recheckOwner: boolean): Promise<ViewerSession | null> {
    const existing = sessions.get(token, id);
    if (existing) {
      if (!recheckOwner) return existing;
      const instance = await getInstance(id, existing.ticket);
      if (!instance) {
        sessions.end(token);
        return null;
      }
      existing.containerName = instance.container_name;
      return existing;
    }

    const inFlight = starting.get(token);
    if (inFlight) return inFlight;
    const start = (async () => {
      const ticket = consumeTicket(token, "selkies", id);
      if (!ticket) return null;
      const instance = await getInstance(id, ticket);
      return instance ? sessions.start(token, ticket, instance.container_name) : null;
    })().finally(() => starting.delete(token));
    starting.set(token, start);
    return start;
  }

  return async (c: Context, next: () => Promise<void>) => {
    const id = c.req.param("id") as string;
    const ownContainer = containerNameForInstance(id);
    if (!ownContainer) return c.text("Instance not found", 404);

    const url = new URL(c.req.url);
    const { base, rest } = splitPath(url.pathname, id);
    // The trailing slash matters: the client resolves "api/websockets" and
    // "./assets/..." against its own directory. Browsers keep the #token
    // fragment across this redirect.
    if (rest === "") return c.redirect(`${base}/${url.search}`, 301);

    const isUpgrade = c.req.header("upgrade")?.toLowerCase() === "websocket";

    if (!isUpgrade && isStaticPath(rest)) {
      if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("Method not allowed", 405);
      if (rest === "/") {
        // An instance row says running before Selkies inside it listens.
        // The panel probes this (HEAD, no ticket) until it answers 200 and
        // only then mints; a page opened earlier keeps retrying (the refresh
        // keeps the #token fragment) until it does.
        let ready = false;
        try {
          ready = await upstreamReady(ownContainer, await upstreamAuthorization(id));
        } catch (err) {
          log("warn", "selkies proxy could not load the instance's viewer password", { id, error: (err as Error).message });
        }
        if (!ready) return c.html(STARTING_PAGE, 503, { "Retry-After": "2" });
        return viewerPageResponse(c.req.method);
      }
      if (rest === RELAY_SCRIPT_PATH) return relayScriptResponse(c.req.method);
      const file = await clientFileResponse(webRoot, rest, c.req.method);
      return file ?? c.text("Not found", 404);
    }

    const token = isUpgrade
      ? tokenFromProtocols(c.req.header("sec-websocket-protocol"))
      : (tokenFromBearer(c.req.header("authorization")) ?? tokenFromCookie(c.req.header("cookie")));
    const session = token ? await sessionFor(token, id, isUpgrade) : null;
    if (!session) {
      debug("http", `${id}:selkies request rejected (${token ? "expired or not yours" : "no token"})`);
      // A dead ticket on the WebSocket gets a plain HTTP 401, not an accepted
      // socket closed with 4001 "Invalid token". The 4001 would stop the
      // client cleanly, but it also skips the reconnect probe (GET
      // .../api/websockets) whose 401 the viewer relay (viewer-relay/relay.ts)
      // watches to tell the framing app to mint a new ticket. Refusing the
      // upgrade also costs no socket for a request that can't succeed.
      if (isUpgrade) return c.text("Viewer link expired, reopen the viewer", 401);
      return c.json({ error: "Viewer link expired, reopen the viewer" }, 401);
    }

    let authorization: string;
    try {
      authorization = await upstreamAuthorization(id);
    } catch (err) {
      log("warn", "selkies proxy could not load the instance's viewer password", { id, error: (err as Error).message });
      return c.json({ error: "Viewer not reachable, try again" }, 502);
    }

    if (isUpgrade) {
      pendingUpgrades.set(c.req.raw, { authorization, session, sessions });
      return websocketRelay(c, next);
    }
    return forwardHttp(c, session.containerName, authorization, base, rest);
  };
}
