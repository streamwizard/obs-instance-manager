import { createMiddleware } from "hono/factory";
import type { AppVariables } from "@/types";
import type { NodeTokenScope } from "@/services/auth/node-token";
import { debug } from "@/utils/logger";

// Per-route check for node tokens (see middleware/auth.ts): the token must
// carry exactly this route's scope, and on any route with an :id param it
// must name that instance. A token for "start i-42" can't stop i-77, delete
// i-42 or open its files.
//
// No node token at all (a route mounted without authMiddleware, or a bug)
// is refused rather than let through.
export function requireScope(scope: NodeTokenScope) {
  return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    const token = c.get("nodeToken");
    if (!token) {
      debug("auth", `no node token on ${c.req.method} ${c.req.path}`);
      return c.json({ error: "Unauthorized" }, 401);
    }

    if (token.scope !== scope) {
      debug("auth", `node token scope ${token.scope} not allowed on ${c.req.method} ${c.req.path}`);
      return c.json({ error: "Forbidden" }, 403);
    }
    const instanceId = c.req.param("id");
    if (instanceId !== undefined && token.instanceId !== instanceId) {
      debug("auth", `node token for instance ${token.instanceId} used on ${c.req.path}`);
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  });
}
