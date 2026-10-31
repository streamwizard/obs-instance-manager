import { createMiddleware } from "hono/factory";
import type { KeyedRateLimiter } from "@/utils/rate-limit";
import type { AppVariables } from "@/types";

// Per-user HTTP throttle. Must run after authMiddleware (keys on userId).
// Each call site passes its own limiter instance, so routes keep separate
// budgets.
export function rateLimitByUser(limiter: KeyedRateLimiter, message: string) {
  return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    const userId = c.get("userId") as string;
    if (!limiter.allow(userId)) {
      return c.json({ error: message }, 429);
    }
    await next();
  });
}
