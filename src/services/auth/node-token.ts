import { createLocalJWKSet, decodeJwt, errors, jwtVerify } from "jose";
import { getCachedNode, refreshNode } from "./node-cache";
import { debug } from "../utils/logger";
import type { Node } from "../types";

// Node tokens: the short-lived credential web-admin and web-streamwizard sign
// for each call to this node, in place of the user's Supabase session JWT. A
// token names one node (aud = this node's id), one action (scope) and, for
// per-instance routes, one instance (iid), and lives 60 seconds. It is signed
// with an Ed25519 key only the web apps hold; this node gets the public keys
// from GET /api/nodes/me, so it can check a token but never mint or alter one,
// and a token captured here is useless on any other node.

export const NODE_TOKEN_ISSUER = "streamwizard-node-token";

export const NODE_TOKEN_SCOPES = [
  "instances:create",
  "instances:read",
  "instances:control",
  "instances:delete",
  "files",
  "ws-ticket",
  "admin:instances",
  "admin:ws-ticket",
] as const;

export type NodeTokenScope = (typeof NODE_TOKEN_SCOPES)[number];

export interface NodeTokenClaims {
  userId: string;
  scope: NodeTokenScope;
  instanceId: string | null;
  role: "user" | "admin";
}

// Web apps sign with a 60s exp. maxTokenAge also caps tokens by iat, so even
// a token minted with a longer exp is refused once it is a minute old.
const MAX_TOKEN_AGE = "60s";
const CLOCK_TOLERANCE_SECONDS = 5;

// An unknown kid (a key rotation) forces a live /me read, but at most this
// often: unauthenticated callers can reach that path, so it must not turn into
// load on the rest-api. A rotation still lands within the window.
const UNKNOWN_KEY_REFRESH_COOLDOWN_MS = 30_000;
let lastKeyRefreshAt = 0;

/** True when the token claims to be a node token. Unverified -- only routes the
 *  token to the right verifier, which then checks everything. */
export function isNodeToken(token: string): boolean {
  try {
    return decodeJwt(token).iss === NODE_TOKEN_ISSUER;
  } catch {
    return false;
  }
}

/** Verifies a node token against this node's identity and the current public
 *  keys. Throws on anything short of a valid, unexpired token for this node. */
export async function verifyNodeToken(token: string): Promise<NodeTokenClaims> {
  const node = await getCachedNode();
  try {
    return await verifyWith(token, node);
  } catch (err) {
    const unknownKey = err instanceof errors.JWKSNoMatchingKey || !node.node_token_jwks?.keys?.length;
    if (!unknownKey || Date.now() - lastKeyRefreshAt < UNKNOWN_KEY_REFRESH_COOLDOWN_MS) throw err;
    lastKeyRefreshAt = Date.now();
    debug("node-token", "no matching key; refreshing node row");
    return verifyWith(token, await refreshNode());
  }
}

async function verifyWith(token: string, node: Node): Promise<NodeTokenClaims> {
  const keys = node.node_token_jwks?.keys;
  if (!keys?.length) throw new errors.JWKSNoMatchingKey("no node token keys provisioned");

  const { payload } = await jwtVerify(token, createLocalJWKSet({ keys }), {
    issuer: NODE_TOKEN_ISSUER,
    audience: node.id,
    algorithms: ["EdDSA"],
    maxTokenAge: MAX_TOKEN_AGE,
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
    requiredClaims: ["sub", "exp", "iat"],
  });

  const { sub, scope, role, iid } = payload as { sub?: unknown; scope?: unknown; role?: unknown; iid?: unknown };
  if (typeof sub !== "string" || !sub) throw new errors.JWTClaimValidationFailed("missing sub", payload, "sub");
  if (!(NODE_TOKEN_SCOPES as readonly unknown[]).includes(scope)) {
    throw new errors.JWTClaimValidationFailed("unknown scope", payload, "scope");
  }
  if (role !== "user" && role !== "admin") throw new errors.JWTClaimValidationFailed("unknown role", payload, "role");
  if (iid !== undefined && typeof iid !== "string") throw new errors.JWTClaimValidationFailed("bad iid", payload, "iid");

  return { userId: sub, scope: scope as NodeTokenScope, instanceId: iid ?? null, role };
}

/** Test-only: module state survives across tests in a file otherwise. */
export function resetNodeTokenState(): void {
  lastKeyRefreshAt = 0;
}
