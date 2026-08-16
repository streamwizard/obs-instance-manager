import { createHash, timingSafeEqual } from "crypto";
import { refreshNode } from "./node-cache";
import { debug, log } from "../utils/logger";

// The obs-auto-switcher authenticates to the public /obs route with this node's
// per-node command key. The rest-api hands us only its SHA-256 hash (via
// GET /api/nodes/me); the plaintext never lives on the node. We cache the hash
// in memory and re-fetch (rate-limited) on a mismatch, so a DB rotation
// propagates without a restart.
//
// There is deliberately no periodic refresh while a hash is held: the mismatch
// path in verifyCommandKey already picks up a rotation on first use, within
// MISMATCH_REFRESH_COOLDOWN_MS — faster than any sane polling interval — so a
// poll would only re-download a value that has no other way to change. The
// interval below exists solely to retry while we have NO hash (failed boot
// fetch, or a node claimed before command keys were provisioned).

const RETRY_INTERVAL_MS = 5 * 60_000;
// A public route means unauthenticated callers can trigger the mismatch path;
// cap how often a bad key can force a rest-api fetch so it can't be amplified
// into load. A legitimate rotation still propagates within this window.
const MISMATCH_REFRESH_COOLDOWN_MS = 30_000;

let commandKeyHash: string | null = null;
let lastFetchAt = 0;

export async function loadCommandKeyHash(): Promise<void> {
  try {
    // refreshNode, never getCachedNode: a cached row would defeat the whole
    // point of this function, and a rotated key would never propagate.
    const node = await refreshNode();
    lastFetchAt = Date.now();
    commandKeyHash = node.command_key_hash ?? null;
    if (!commandKeyHash) {
      log("warn", "no obs_command key provisioned for this node; /obs will reject all requests until one exists");
    } else {
      debug("command-key", "loaded obs_command key hash");
    }
  } catch (err) {
    log("error", "failed to load obs_command key hash", { error: (err as Error).message });
  }
}

/** One retry-loop tick, exported so tests can drive it without timers:
 *  fetch only while no hash is held; a warm hash makes this a no-op. */
export function retryCommandKeyLoadIfMissing(): Promise<void> {
  if (hasCommandKey()) return Promise.resolve();
  return loadCommandKeyHash();
}

export function startCommandKeyRefresh(): void {
  setInterval(() => void retryCommandKeyLoadIfMissing(), RETRY_INTERVAL_MS);
}

/** True once a command key hash has been loaded — lets the middleware answer
 *  503 (not ready) distinctly from 401 (wrong key). */
export function hasCommandKey(): boolean {
  return commandKeyHash !== null;
}

/** Validates the switcher's Bearer against the node's command key hash. On a
 *  mismatch it re-fetches at most once per cooldown, so a rotated key is picked
 *  up without a restart while a flood of bad keys can't hammer the rest-api. */
export async function verifyCommandKey(token: string): Promise<boolean> {
  if (matches(token)) return true;
  if (Date.now() - lastFetchAt >= MISMATCH_REFRESH_COOLDOWN_MS) {
    await loadCommandKeyHash();
    return matches(token);
  }
  return false;
}

function matches(token: string): boolean {
  if (!commandKeyHash) return false;
  const incoming = createHash("sha256").update(token).digest("hex");
  const a = Buffer.from(incoming);
  const b = Buffer.from(commandKeyHash);
  return a.length === b.length && timingSafeEqual(a, b);
}
