import type { Context, Next } from "hono";
import type { AppVariables } from "../types";
import { debug } from "../utils/logger";
import { hasCommandKey, verifyCommandKey } from "../services/command-key";

// Per-node command-key auth for the public /obs route (obs-auto-switcher). The
// switcher presents this node's obs_command key as a Bearer; we compare its
// SHA-256 against the hash fetched from GET /api/nodes/me. Unlike the old
// shared INTERNAL_SERVICE_KEY, this key is unique per node — a leak can only
// drive OBS scenes on this one node, never authenticate as the node elsewhere.
// The plaintext key never lives here; we only ever hold its hash.
export async function commandAuthMiddleware(c: Context<{ Variables: AppVariables }>, next: Next) {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const valid = await verifyCommandKey(token);
  if (!valid) {
    // Distinguish "we have no key to compare against yet" from a real mismatch.
    if (!hasCommandKey()) {
      return c.json({ error: "Command key not ready" }, 503);
    }
    debug("command-auth", `invalid command key on ${c.req.method} ${c.req.path}`);
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
}
