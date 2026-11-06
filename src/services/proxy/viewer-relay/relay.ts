// The relay that runs in OIM's Selkies entry page (viewer-page.ts), between the
// Selkies client and the StreamWizard app that frames it.
//
// The app shows this page in a cross-origin <iframe> and draws its own
// controls around it. The Selkies client only takes window messages from its
// own origin, so the relay pairs with the parent, re-posts an allowlisted set
// of its messages to its own window, and forwards a few of the client's status
// messages back. Nothing else crosses: the parent can't switch streaming
// modes, send input or read settings, and gets plain data only. Clipboard
// text doesn't cross either: Selkies syncs it itself inside the frame
// (Ctrl+C / Ctrl+V), with the clipboard permissions the frame's allow
// attribute delegates.
//
// It also watches the client's fetches for a dead viewer session (2 minutes
// without a socket, or the 12-hour cap; services/auth/selkies-viewer-sessions)
// and tells the parent, which mints a new ticket and loads a new frame with
// it. Left alone, the client would reload this page with the dead token and
// loop on 401. A new #token on this same page is no fix: the client builds its
// socket's token subprotocol once per page load, so only a fresh load picks
// up a new ticket.
//
// Pure logic, no DOM: relay-browser.ts wires it to the real window, and
// relay.test.ts drives it with fakes.

export const RELAY_VERSION = 1;

const ROLE_LIMIT = 32;

/** Parent -> client messages the relay passes on, after rebuilding them. */
export const PARENT_TO_CORE_TYPES = ["setMute", "setVolume", "pipelineControl"] as const;
/**
 * Client -> parent messages the relay forwards. Disjoint from the list above,
 * so a message the relay re-posts to its own window never echoes back out.
 * The client's `stats` reply is missing on purpose: it posts it to
 * window.parent with its own origin as the target, which the browser drops
 * for a cross-origin parent.
 */
export const CORE_TO_PARENT_TYPES = ["pipelineStatusUpdate", "clientRoleUpdate"] as const;

export type CoreMessage =
  | { type: "setMute"; value: boolean }
  | { type: "setVolume"; value: number }
  | { type: "pipelineControl"; pipeline: "audio"; enabled: boolean };

export type ParentMessage =
  | { type: "pipelineStatusUpdate"; video?: boolean; audio?: boolean }
  | { type: "clientRoleUpdate"; role: string };

export type RelayMessage =
  | { type: "sw-ready"; version: number }
  | { type: "viewer-expired" }
  | { type: "audio-state"; blocked: boolean };

type Fields = Record<string, unknown>;

function asObject(data: unknown): Fields | null {
  return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Fields) : null;
}

/**
 * The origins the relay may pair with, or null when it must not pair at all:
 * PANEL_ORIGIN is "*" or unset, or names nothing that is an exact origin.
 */
export function pairableOrigins(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.includes("*")) return null;
  const origins = raw.filter((o): o is string => {
    if (typeof o !== "string") return false;
    try {
      const url = new URL(o);
      return (url.protocol === "https:" || url.protocol === "http:") && url.origin === o;
    } catch {
      return false;
    }
  });
  return origins.length > 0 ? origins : null;
}

/** Whether a parent message is the pairing handshake. */
export function isHello(data: unknown): boolean {
  return asObject(data)?.type === "sw-hello";
}


/** A parent message the client accepts, rebuilt from its known fields, or null. */
export function toCoreMessage(data: unknown): CoreMessage | null {
  const m = asObject(data);
  if (!m) return null;
  switch (m.type) {
    case "setMute":
      return typeof m.value === "boolean" ? { type: "setMute", value: m.value } : null;
    case "setVolume":
      return typeof m.value === "number" && Number.isFinite(m.value)
        ? { type: "setVolume", value: Math.min(1, Math.max(0, m.value)) }
        : null;
    case "pipelineControl":
      // Audio only: the parent mutes the stream, it never stops the picture.
      return m.pipeline === "audio" && typeof m.enabled === "boolean"
        ? { type: "pipelineControl", pipeline: "audio", enabled: m.enabled }
        : null;
    default:
      return null;
  }
}

/** A client message the parent gets, as plain data, or null. */
export function toParentMessage(data: unknown): ParentMessage | null {
  const m = asObject(data);
  if (!m) return null;
  switch (m.type) {
    case "pipelineStatusUpdate": {
      const out: ParentMessage = { type: "pipelineStatusUpdate" };
      if (typeof m.video === "boolean") out.video = m.video;
      if (typeof m.audio === "boolean") out.audio = m.audio;
      return out.video === undefined && out.audio === undefined ? null : out;
    }
    case "clientRoleUpdate":
      return typeof m.role === "string" && m.role.length > 0 && m.role.length <= ROLE_LIMIT
        ? { type: "clientRoleUpdate", role: m.role }
        : null;
    default:
      return null;
  }
}

/** The client's route prefix: the page path up to its last "/" (Selkies' getRoutePrefix). */
export function routePrefix(pathname: string): string {
  return pathname.slice(0, pathname.lastIndexOf("/"));
}

export interface PageLocation {
  href: string;
  origin: string;
  pathname: string;
}

type FetchInput = string | URL | { url: string; method?: string };
type FetchLike = (input: FetchInput, init?: { method?: string }) => Promise<Response>;

function requestTarget(input: FetchInput, init: { method?: string } | undefined, page: PageLocation) {
  const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : undefined) ?? "GET").toUpperCase();
  try {
    return { method, url: new URL(raw, page.href) };
  } catch {
    return null;
  }
}

/**
 * Whether a request is the client's reconnect probe: a GET of
 * `<prefix>/api/websockets` on this origin (selkies-ws-core.js,
 * scheduleReconnect). OIM answers it 401 once the viewer session is dead.
 */
export function isReconnectProbe(method: string, url: URL, page: PageLocation): boolean {
  return method === "GET" && url.origin === page.origin && url.pathname === `${routePrefix(page.pathname)}/api/websockets`;
}

function isApiRequest(url: URL, page: PageLocation): boolean {
  return url.origin === page.origin && url.pathname.startsWith(`${routePrefix(page.pathname)}/api/`);
}

// What the client sees instead of the 401 and, after it, instead of every API
// call. Selkies treats a 503 as "server away" (lib/util.js serverAnswers): its
// reconnect ladder keeps waiting without opening sockets, and its auth guard
// (lib/auth-guard.js), which reloads the page on any 401, never sees one.
function sessionEnded(): Response {
  return new Response(null, { status: 503, statusText: "Viewer session ended" });
}

interface EventTargetLike {
  addEventListener(type: string, listener: (event: { stopImmediatePropagation(): void }) => void, options: { capture: boolean }): void;
}

/**
 * Keeps `pointerrawupdate` from the client in a framed page. Chromium gives
 * those events coordinates relative to the top-level window, not the frame,
 * and Selkies sends hover motion from them (lib/input.js,
 * _handleRawPointerUpdate), so the remote pointer sat lower than the visible
 * one by the frame's offset (the app's header). Clicks come from mousedown
 * and were right. Without raw updates Selkies sends motion from mousemove,
 * which is frame-relative, as it does in Safari. Call before the client
 * loads: the capture listener on window then runs ahead of its own.
 */
export function blockRawPointerUpdates(target: EventTargetLike): void {
  target.addEventListener("pointerrawupdate", (event) => event.stopImmediatePropagation(), { capture: true });
}

interface AudioContextLike {
  readonly state: string;
  addEventListener(type: "statechange", listener: () => void): void;
}

/** How long a new AudioContext may stay suspended before it counts as blocked. */
export const AUDIO_GRACE_MS = 1_500;

/**
 * Watches the client's AudioContexts for the browser's autoplay block.
 * Selkies never suspends one itself and retries resume() on every audio
 * packet, so a context still suspended after AUDIO_GRACE_MS is one the
 * browser refuses until the page gets a click. Reports changes only.
 *
 * There is no "resume" for the parent to call: browsers don't pass a click on
 * the parent page into the frame (checked in Chromium, also with
 * allow="autoplay"), so only a click inside the frame starts the sound.
 */
export function createAudioWatch({
  onChange,
  schedule = (fn: () => void, ms: number) => void setTimeout(fn, ms),
}: {
  onChange: (blocked: boolean) => void;
  schedule?: (fn: () => void, ms: number) => void;
}) {
  const contexts = new Set<AudioContextLike>();
  let blocked: boolean | null = null;

  function evaluate() {
    for (const ctx of contexts) if (ctx.state === "closed") contexts.delete(ctx);
    // Safari's "interrupted" holds the sound back the same way.
    const now = [...contexts].some((ctx) => ctx.state === "suspended" || ctx.state === "interrupted");
    if (now === blocked) return;
    blocked = now;
    onChange(now);
  }

  return {
    track(ctx: AudioContextLike) {
      contexts.add(ctx);
      ctx.addEventListener("statechange", evaluate);
      schedule(evaluate, AUDIO_GRACE_MS);
    },
  };
}

export interface RelayEnv {
  /** window.__SW_PANEL_ORIGINS, as injected by OIM. */
  origins: unknown;
  location: () => PageLocation;
  /** This page's own window, to recognize the client's messages. */
  self: unknown;
  /** window.parent when the page is framed, else null. */
  parent: unknown;
  postToCore: (message: CoreMessage) => void;
  postToParent: (target: unknown, message: ParentMessage | RelayMessage, origin: string) => void;
  /** Shows the "session ended" text, for a page with no parent to tell. */
  showEnded: () => void;
  warn: (text: string) => void;
}

export interface MessageEventLike {
  data: unknown;
  origin: string;
  source: unknown;
}

export function createRelay(env: RelayEnv) {
  const origins = pairableOrigins(env.origins);
  let paired: { source: unknown; origin: string } | null = null;
  let refusalLogged = false;
  let expired = false;
  // Last status the client reported, replayed on pairing: the parent may pair
  // after the socket is already up.
  let pipeline: Extract<ParentMessage, { type: "pipelineStatusUpdate" }> | null = null;
  let role: ParentMessage | null = null;
  let audioBlocked: boolean | null = null;

  function toParent(message: ParentMessage | RelayMessage) {
    if (paired) env.postToParent(paired.source, message, paired.origin);
  }

  function pair(event: MessageEventLike) {
    if (!origins) {
      if (!refusalLogged) {
        refusalLogged = true;
        env.warn("StreamWizard relay: PANEL_ORIGIN is * or unset on this node, not pairing with the parent page.");
      }
      return;
    }
    if (!origins.includes(event.origin)) return;
    paired = { source: event.source, origin: event.origin };
    toParent({ type: "sw-ready", version: RELAY_VERSION });
    if (expired) toParent({ type: "viewer-expired" });
    else {
      if (pipeline) toParent(pipeline);
      if (role) toParent(role);
      if (audioBlocked !== null) toParent({ type: "audio-state", blocked: audioBlocked });
    }
  }

  function expire() {
    if (expired) return;
    expired = true;
    if (paired) toParent({ type: "viewer-expired" });
    else env.showEnded();
  }

  return {
    handleMessage(event: MessageEventLike) {
      if (env.parent !== null && event.source === env.parent) {
        if (isHello(event.data)) {
          pair(event);
          return;
        }
        if (!paired || event.source !== paired.source || event.origin !== paired.origin || expired) return;
        const message = toCoreMessage(event.data);
        if (message) env.postToCore(message);
        return;
      }
      if (event.source !== env.self || event.origin !== env.location().origin) return;
      const message = toParentMessage(event.data);
      if (!message) return;
      if (message.type === "pipelineStatusUpdate") pipeline = { ...pipeline, ...message };
      if (message.type === "clientRoleUpdate") role = message;
      if (!expired) toParent(message);
    },

    /** The audio watch's verdict, forwarded to the parent when it changes. */
    setAudioBlocked(blocked: boolean) {
      if (blocked === audioBlocked) return;
      audioBlocked = blocked;
      if (!expired) toParent({ type: "audio-state", blocked });
    },

    /**
     * Wraps window.fetch. Installed before the client loads, so it sits inside
     * the client's own auth-guard wrapper, which binds whatever window.fetch
     * is at its init.
     */
    wrapFetch(realFetch: FetchLike): FetchLike {
      return async (input, init) => {
        const page = env.location();
        const target = requestTarget(input, init, page);
        if (expired && target && isApiRequest(target.url, page)) return sessionEnded();
        const res = await realFetch(input, init);
        if (res.status === 401 && target && isReconnectProbe(target.method, target.url, page)) {
          expire();
          await res.body?.cancel();
          return sessionEnded();
        }
        return res;
      };
    },

    get paired() {
      return paired !== null;
    },
    get expired() {
      return expired;
    },
  };
}
