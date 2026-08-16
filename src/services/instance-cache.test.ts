import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Instance } from "../types";

process.env.S3_ENDPOINT ??= "http://127.0.0.1:1";
process.env.S3_ACCESS_KEY ??= "test";
process.env.S3_SECRET_KEY ??= "test";
process.env.TOKEN_ENCRYPTION_KEY ??= "0".repeat(64);
process.env.NODE_ID ??= "test-node";
process.env.REST_API_URL ??= "http://127.0.0.1:1";
process.env.NODE_API_KEY ??= "test";
// Short TTL so expiry is testable without sleeping the real 90s failsafe.
process.env.INSTANCE_CACHE_TTL_MS = "50";
process.env.INSTANCE_CACHE_ERROR_BACKOFF_MS = "50";

function makeInstance(id: string, status = "running"): Instance {
  return {
    id,
    user_id: "user-1",
    node_id: "test-node",
    container_id: `container-${id}`,
    container_name: `obs-instance-${id}`,
    resolution: "1920x1080",
    status,
    vram_allocated_mb: 2048,
    memory_mb: 4096,
    cpu_quota: 2,
    shm_size: "2g",
  } as Instance;
}

let listCalls = 0;
let nextList: Instance[] = [makeInstance("a")];
let failWith: Error | null = null;

mock.module("../clients/supabase", () => ({
  listNodeInstances: async () => {
    listCalls++;
    if (failWith) throw failWith;
    return nextList;
  },
}));

const {
  getCachedNodeInstances,
  refreshNodeInstances,
  invalidateNodeInstances,
  peekCachedNodeInstances,
  resetInstanceCache,
} = await import("./instance-cache");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetInstanceCache();
  listCalls = 0;
  nextList = [makeInstance("a")];
  failWith = null;
});

describe("instance-cache", () => {
  it("fetches once and serves from memory within the TTL", async () => {
    const first = await getCachedNodeInstances();
    const second = await getCachedNodeInstances();

    expect(first).toEqual(nextList);
    expect(second).toBe(first);
    expect(listCalls).toBe(1);
  });

  it("single-flights concurrent cold reads", async () => {
    const [a, b, c] = await Promise.all([
      getCachedNodeInstances(),
      getCachedNodeInstances(),
      getCachedNodeInstances(),
    ]);

    expect(listCalls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("refetches once the TTL has elapsed", async () => {
    await getCachedNodeInstances();
    nextList = [makeInstance("a"), makeInstance("b")];
    await sleep(60);

    const refreshed = await getCachedNodeInstances();

    expect(listCalls).toBe(2);
    expect(refreshed).toHaveLength(2);
  });

  it("invalidation makes the next read fetch live — this is what the mutation wrappers call", async () => {
    await getCachedNodeInstances();
    nextList = [makeInstance("a", "stopped")];

    invalidateNodeInstances();
    const after = await getCachedNodeInstances();

    expect(listCalls).toBe(2);
    expect(after[0]?.status).toBe("stopped");
  });

  it("refreshNodeInstances bypasses a warm TTL and rewarms the cache — the sync backstop's live read", async () => {
    await getCachedNodeInstances();
    nextList = [makeInstance("external")];

    const fresh = await refreshNodeInstances();

    expect(listCalls).toBe(2);
    expect(fresh[0]?.id).toBe("external");
    // The live read warms the cache for the poll readers:
    expect(await getCachedNodeInstances()).toBe(fresh);
    expect(listCalls).toBe(2);
  });

  it("serves the stale list when a refresh fails, and backs off before retrying", async () => {
    const warm = await getCachedNodeInstances();
    await sleep(60); // expire the TTL
    failWith = new Error("rest-api down");

    const duringOutage = await getCachedNodeInstances();
    const withinBackoff = await getCachedNodeInstances();

    expect(duringOutage).toBe(warm);
    expect(withinBackoff).toBe(warm);
    expect(listCalls).toBe(2); // one warm fetch + one failed refresh, backoff absorbed the third call

    failWith = null;
    nextList = [makeInstance("recovered")];
    await sleep(60); // past the error backoff

    const recovered = await getCachedNodeInstances();
    expect(recovered[0]?.id).toBe("recovered");
  });

  it("throws on a cold cache when the fetch fails — nothing sane to serve", async () => {
    failWith = new Error("rest-api down");

    expect(getCachedNodeInstances()).rejects.toThrow("rest-api down");
    expect(peekCachedNodeInstances()).toBeNull();
  });

  it("a failed fetch does not poison the in-flight slot", async () => {
    failWith = new Error("boom");
    await getCachedNodeInstances().catch(() => {});

    failWith = null;
    const ok = await getCachedNodeInstances();

    expect(ok).toEqual(nextList);
  });
});
