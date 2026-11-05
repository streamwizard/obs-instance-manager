// Pure request checks for the Selkies proxy (selkies-proxy.ts).

// What the Selkies client offers on a WebSocket handshake that carries its
// page token (Selkies' stream_server.py, SESSION_TOKEN_PROTOCOL_PREFIX).
const TOKEN_PROTOCOL_PREFIX = "selkies.token.";

// Static client files: plain path characters only, nothing under /api.
const STATIC_PATH = /^\/(?!api(?:\/|$))[A-Za-z0-9._~\-/]*$/;

export function isStaticPath(rest: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return false;
  }
  return STATIC_PATH.test(decoded) && !decoded.split("/").includes("..");
}

/** The page token a Selkies WebSocket handshake carries, or null. */
export function tokenFromProtocols(header: string | undefined): string | null {
  if (!header) return null;
  for (const raw of header.split(",")) {
    const protocol = raw.trim();
    if (!protocol.startsWith(TOKEN_PROTOCOL_PREFIX)) continue;
    const decoded = Buffer.from(protocol.slice(TOKEN_PROTOCOL_PREFIX.length), "base64url").toString("utf8");
    return decoded || null;
  }
  return null;
}

/** The page token a Selkies API fetch carries, or null. */
export function tokenFromBearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match?.[1] ?? null;
}

// The Selkies client also copies its page token into this cookie, scoped to
// its own api/ path, for requests it can't add a header to (the dashboard's
// first /api/status probe). Same token, same session rules.
const TOKEN_COOKIE = "selkies_token";

/** The page token in the Selkies client's own cookie, or null. */
export function tokenFromCookie(header: string | undefined): string | null {
  for (const part of (header ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== TOKEN_COOKIE) continue;
    try {
      return decodeURIComponent(rest.join("=")) || null;
    } catch {
      return null;
    }
  }
  return null;
}
