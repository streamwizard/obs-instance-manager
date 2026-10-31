import type { Context, Next } from "hono";
import { isAdmin } from "@/clients/supabase";
import { debug } from "@/utils/logger";
import type { AppVariables } from "@/types";

// Same auth every end-user route uses (authMiddleware) -- the only
// difference here is the authorization check is "has the admin role"
// instead of "owns this instance". A node token must also say role "admin",
// which only web-admin signs, after its own strong-session check.
// Must run after authMiddleware.
export async function requireAdmin(c: Context<{ Variables: AppVariables }>, next: Next) {
  const userId = c.get("userId");
  const nodeToken = c.get("nodeToken");
  if (nodeToken && nodeToken.role !== "admin") {
    debug("auth", `node token for ${userId} is not an admin token, rejecting ${c.req.path}`);
    return c.json({ error: "Forbidden" }, 403);
  }
  if (!(await isAdmin(userId))) {
    debug("auth", `user ${userId} is not an admin, rejecting ${c.req.path}`);
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
}
