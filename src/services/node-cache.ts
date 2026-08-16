import { getNode } from "../clients/supabase";
import { NODE_ID } from "../utils/node";
import { log } from "../utils/logger";
import type { Node } from "../types";

// This node's own row, held in memory.
//
// Every consumer used to fetch it over HTTP: the 10s metrics pass fetched it
// twice (once for the Influx tags, once more inside getAllMetrics for
// memory_mb), and each connected dashboard re-fetched it every 3s. That was
// ~732 GET /api/nodes/me per hour on an idle node, and each one costs the
// rest-api three Supabase reads. The row itself had not changed in 25 days.
//
// Nothing on it is operational: id/memory_mb/gpu_bus_id are hardware facts,
// max_instances/max_encoder_sessions are admin-set capacity, and the only
// field that legitimately changes is command_key_hash — which is exactly why
// refreshNode() exists. Read that comment before touching the TTL.
//
// A single value, not a Map: getNode ignores its nodeId argument because
// /api/nodes/me is identity-scoped by NODE_API_KEY, so one process can only
// ever see one row.

/** An hour, and that is not casual: the row is write-once in practice (25 days
 *  without an UPDATE across ~440k reads, verified via its updated_at trigger),
 *  and every path that needs a *correct* row rather than a recent one — the
 *  capacity gate in routes/instances.ts and command-key rotation — goes through
 *  refreshNode(), which bypasses this TTL entirely. The only thing the TTL
 *  bounds is how long an admin's capacity edit takes to reach Influx tags, a
 *  human-rare event where an hour of lag is invisible. */
const TTL_MS = Number(process.env.NODE_CACHE_TTL_MS) || 60 * 60_000;

/** After a failed refresh, keep serving the stale row without re-attempting for
 *  this long. Without it an outage would turn the 3s dashboard ticks into a
 *  retry storm against a rest-api that is already struggling. */
const ERROR_BACKOFF_MS = Number(process.env.NODE_CACHE_ERROR_BACKOFF_MS) || 10_000;

/** The 3s stream ticks would otherwise log on every failure. */
const ERROR_LOG_INTERVAL_MS = 60_000;

let cached: Node | null = null;
let cachedAt = 0;
let failedAt = 0;
let lastErrorLoggedAt = 0;
let inFlight: Promise<Node> | null = null;

function fetchNode(): Promise<Node> {
  // Concurrent callers share one request. Both the 10s persist loop and every
  // 3s dashboard tick observe the same expiry, so a cold or just-expired cache
  // is a stampede, not a theoretical race.
  if (inFlight) return inFlight;

  inFlight = getNode(NODE_ID)
    .then((node) => {
      cached = node;
      cachedAt = Date.now();
      failedAt = 0;
      return node;
    })
    .finally(() => {
      // Cleared unconditionally so a rejection can't poison later callers.
      inFlight = null;
    });

  return inFlight;
}

function logRefreshFailure(err: unknown): void {
  const now = Date.now();
  if (now - lastErrorLoggedAt < ERROR_LOG_INTERVAL_MS) return;
  lastErrorLoggedAt = now;
  log("warn", "node row refresh failed; serving cached copy", {
    error: (err as Error).message,
    cachedAgeMs: now - cachedAt,
  });
}

/**
 * The node row, from memory when it's warm.
 *
 * Fails open on a warm cache: if the refresh fails we keep serving the last
 * known row rather than throwing. The agent cannot compute metrics or gate
 * capacity without it, the fields are immutable specs, and a rest-api blip
 * should degrade freshness rather than blank out InfluxDB history.
 *
 * Fails closed on a cold one — there is nothing to serve, so it rethrows and
 * lets the caller's existing error handling take over.
 */
export async function getCachedNode(): Promise<Node> {
  const now = Date.now();

  if (cached && now - cachedAt < TTL_MS) return cached;
  if (cached && failedAt && now - failedAt < ERROR_BACKOFF_MS) return cached;

  try {
    return await fetchNode();
  } catch (err) {
    failedAt = Date.now();
    if (cached) {
      logRefreshFailure(err);
      return cached;
    }
    throw err;
  }
}

/**
 * Forces a live read, bypassing both the TTL and the error backoff.
 *
 * This is load-bearing, not a convenience. command-key.ts calls it on a hash
 * mismatch, and that is the ONLY path by which a rotated obs_command key ever
 * reaches this node — if a warm cache could satisfy it, rotation would never
 * propagate and /obs would fail closed permanently.
 *
 * It joins an in-flight fetch rather than issuing a second request, which is
 * safe: that fetch is itself a live read. Rate limiting stays with the caller
 * (command-key.ts's 30s cooldown), so this must not add backoff of its own.
 */
export async function refreshNode(): Promise<Node> {
  return fetchNode();
}

/** Synchronous peek — never fetches. For health output and assertions. */
export function peekCachedNode(): Node | null {
  return cached;
}

/** Test-only: module state survives across tests in a file otherwise. */
export function resetNodeCache(): void {
  cached = null;
  cachedAt = 0;
  failedAt = 0;
  lastErrorLoggedAt = 0;
  inFlight = null;
}
