import { listNodeInstances } from "../clients/supabase";
import { NODE_ID } from "../utils/node";
import { log } from "../utils/logger";
import type { Instance } from "../types";

// This node's instance list, held in memory.
//
// Every consumer used to fetch it over HTTP: the 10s metrics pass, every 3s
// dashboard tick, the 5m config autosave, and the 60s OBS-watcher sync —
// ~10,400 rest-api calls/day (each one a Supabase read) for a list this
// process itself mutates a handful of times a day.
//
// The cache is correct, not approximate, because every mutation of this
// node's instances funnels through the wrappers in clients/supabase.ts
// (provision, start/stop, crash watchdog, delete), and each one calls
// invalidateInstanceCache() on success — the next reader refetches. The one
// thing this process CANNOT see is an out-of-band change (an external DB
// edit, a docker event the stream dropped): that is exactly why
// syncInstances() keeps calling refreshNodeInstances() — a live read, never
// the cache — every 60s, unchanged from the staleness guarantee the system
// had when every reader polled. That sync doubles as this cache's refresh,
// so the TTL below is a failsafe for a dead sync loop, not the design.
//
// A single value, not a Map: listNodeInstances ignores its nodeId argument
// because the rest-api route is identity-scoped by NODE_API_KEY, so one
// process only ever sees one list.

/** Failsafe bound only — the 60s syncInstances live read is what actually
 *  keeps this fresh. Anything comfortably above that interval works. */
const TTL_MS = Number(process.env.INSTANCE_CACHE_TTL_MS) || 90_000;

/** After a failed refresh, keep serving the stale list without re-attempting
 *  for this long — same reasoning as node-cache.ts: the 3s dashboard ticks
 *  must not turn a rest-api outage into a retry storm. */
const ERROR_BACKOFF_MS = Number(process.env.INSTANCE_CACHE_ERROR_BACKOFF_MS) || 10_000;

const ERROR_LOG_INTERVAL_MS = 60_000;

let cached: Instance[] | null = null;
let cachedAt = 0;
let failedAt = 0;
let lastErrorLoggedAt = 0;
let inFlight: Promise<Instance[]> | null = null;

function fetchInstances(): Promise<Instance[]> {
  // Concurrent callers share one request: an invalidation with a dashboard
  // attached means the 3s tick, the 10s metrics pass, and the autosave can
  // all observe the empty cache in the same instant.
  if (inFlight) return inFlight;

  inFlight = listNodeInstances(NODE_ID)
    .then((instances) => {
      cached = instances;
      cachedAt = Date.now();
      failedAt = 0;
      return instances;
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
  log("warn", "instance list refresh failed; serving cached copy", {
    error: (err as Error).message,
    cachedAgeMs: now - cachedAt,
  });
}

/**
 * The instance list, from memory when it's warm.
 *
 * Fails open on a warm cache (serve stale rather than throw) and closed on a
 * cold one, exactly like node-cache.ts: a rest-api blip should degrade
 * freshness, not blank the dashboard or drop an Influx sample.
 */
export async function getCachedNodeInstances(): Promise<Instance[]> {
  const now = Date.now();

  if (cached && now - cachedAt < TTL_MS) return cached;
  if (cached && failedAt && now - failedAt < ERROR_BACKOFF_MS) return cached;

  try {
    return await fetchInstances();
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
 * Forces a live read, bypassing the TTL and the error backoff, and warms the
 * cache with the result. This is what syncInstances() and boot reconcile
 * call: their whole purpose is catching changes this process did not make,
 * so serving them from memory would be checking our memory against itself.
 */
export async function refreshNodeInstances(): Promise<Instance[]> {
  return fetchInstances();
}

/**
 * Drops the cached list so the next reader refetches. Called by every
 * instance mutation wrapper in clients/supabase.ts — lazy on purpose: the
 * mutation path shouldn't pay for (or fail on) the refetch, and with no
 * dashboard attached the next natural reader is at most 10s away.
 */
export function invalidateNodeInstances(): void {
  cached = null;
  cachedAt = 0;
  failedAt = 0;
}

/** Synchronous peek — never fetches. For health output and assertions. */
export function peekCachedNodeInstances(): Instance[] | null {
  return cached;
}

/** Test-only: module state survives across tests in a file otherwise. */
export function resetInstanceCache(): void {
  cached = null;
  cachedAt = 0;
  failedAt = 0;
  lastErrorLoggedAt = 0;
  inFlight = null;
}
