import type { Context, Next } from "hono";
import type { AppVariables } from "@/types";
import { debug } from "@/utils/logger";
import { isNodeToken, verifyNodeToken } from "@/services/auth/node-token";

// The only credential this API accepts is a node token
// (services/auth/node-token.ts): 60 seconds, bound to this node, one scope
// and usually one instance, signed by the web apps for each call. Routes
// check the scope with requireScope (middleware/scope.ts).
//
// The caller's Supabase session JWT used to be accepted too while the web
// apps switched over (SW-481). It carried no scope and no instance, so it is
// refused now like any other token.
//
// The token only ever arrives in the Authorization header. WebSocket upgrades
// (which can't set headers) authenticate with single-use ws-tickets instead --
// see services/auth/ws-tickets.ts -- so there's deliberately no query-param token path.
function extractToken(c: Context<{ Variables: AppVariables }>): string | null {
  const header = c.req.header("Authorization");
  if (header?.startsWith("Bearer ")) {
    return header.slice("Bearer ".length);
  }
  return null;
}

export async function authMiddleware(c: Context<{ Variables: AppVariables }>, next: Next) {
  const token = extractToken(c);
  if (!token) {
    debug("auth", `missing token on ${c.req.method} ${c.req.path}`);
    return c.json({ error: "Missing authentication token" }, 401);
  }

  if (!isNodeToken(token)) {
    debug("auth", `not a node token on ${c.req.path}`);
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  try {
    const claims = await verifyNodeToken(token);
    debug("auth", `verified node token for sub=${claims.userId} scope=${claims.scope} on ${c.req.path}`);
    c.set("userId", claims.userId);
    c.set("nodeToken", claims);
    c.set("nodeTokenRaw", token);
  } catch (err) {
    debug("auth", `node token rejected on ${c.req.path}`, err instanceof Error ? err.message : err);
    return c.json({ error: "Invalid or expired token" }, 401);
  }
  await next();
}
