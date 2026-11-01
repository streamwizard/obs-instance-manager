import { createHmac, timingSafeEqual } from "node:crypto";

// The Selkies viewer is a whole web app (HTML, JS, CSS, a WebSocket) loaded in
// an iframe, so unlike the noVNC/obsws sockets it can't carry a single-use
// ws-ticket on every request. The ticket is spent once, on the entry URL, and
// swapped for this session: an HMAC-signed, HttpOnly cookie scoped to that one
// instance's proxy path. It names the container so asset requests need no
// rest-api lookup; the signature is what makes that safe to trust.

export const SELKIES_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const SELKIES_COOKIE = "sw_selkies";

export interface SelkiesSession {
  instanceId: string;
  userId: string;
  containerName: string;
  expiresAt: number;
}

function hmac(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data).digest("base64url");
}

function payloadOf(s: SelkiesSession): string {
  return [s.instanceId, s.userId, s.containerName, String(s.expiresAt)]
    .map((p) => Buffer.from(p).toString("base64url"))
    .join(".");
}

export function signSession(key: Buffer, session: SelkiesSession): string {
  const payload = payloadOf(session);
  return `${payload}.${hmac(key, payload)}`;
}

// Returns the session only if the signature matches, it hasn't expired, and it
// was issued for this instance (a cookie is path-scoped, but a client can send
// any cookie it likes to any path).
export function verifySession(
  key: Buffer,
  value: string | undefined,
  instanceId: string,
  now = Date.now(),
): SelkiesSession | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 5) return null;
  const payload = parts.slice(0, 4).join(".");
  const expected = Buffer.from(hmac(key, payload));
  const given = Buffer.from(parts[4]!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  const [id, userId, containerName, exp] = parts.slice(0, 4).map((p) => Buffer.from(p, "base64url").toString());
  const expiresAt = Number(exp);
  if (id !== instanceId || !Number.isFinite(expiresAt) || expiresAt < now) return null;
  return { instanceId: id, userId: userId!, containerName: containerName!, expiresAt };
}

// Derived from the node's own NODE_API_KEY: a secret only this node holds,
// stable across restarts (so open viewers survive a manager restart), and
// needing no extra config. Derived rather than reused raw, so a cookie key
// can never be turned back into the API key. The node has no
// TOKEN_ENCRYPTION_KEY anymore, and must never get it back for this.
export function sessionKeyFrom(nodeSecret: string): Buffer {
  if (!nodeSecret) throw new Error("sessionKeyFrom: empty node secret");
  return createHmac("sha256", nodeSecret).update("selkies-session-v1").digest();
}
