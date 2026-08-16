import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Node } from "../types";

// Import-time env, before anything pulls in the module graph.
process.env.S3_ENDPOINT ??= "http://127.0.0.1:1";
process.env.S3_ACCESS_KEY ??= "test";
process.env.S3_SECRET_KEY ??= "test";
process.env.TOKEN_ENCRYPTION_KEY ??= "0".repeat(64);
process.env.NODE_ID ??= "test-node";
process.env.REST_API_URL ??= "http://127.0.0.1:1";
process.env.NODE_API_KEY ??= "test";
// Short enough to exercise expiry without sleeping for minutes.
process.env.NODE_CACHE_TTL_MS ??= "50";
process.env.NODE_CACHE_ERROR_BACKOFF_MS ??= "50";

const unused = () => {
  throw new Error("not stubbed");
};

function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    id: "test-node",
    name: "obs-node-1",
    max_instances: 4,
    memory_mb: 32_000,
    cpu_quota: 4,
    vram_mb: 8_000,
    total_vram_mb: 24_000,
    shm_size: "2g",
    gpu_bus_id: "00000000:01:00.0",
    max_encoder_sessions: 5,
    command_key_hash: "hash-a",
    created_at: "2026-07-21T00:00:00Z",
    ...overrides,
  } as Node;
}

let calls = 0;
let nextNode: Node = makeNode();
let failWith: Error | null = null;
let delayMs = 0;

mock.module("../clients/supabase", () => ({
  getNode: async () => {
    calls++;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (failWith) throw failWith;
    return nextNode;
  },
  isAdmin: unused,
  listUserInstances: unused,
  listNodeInstances: unused,
  getInstanceById: unused,
  getInstanceByIdAdmin: unused,
  insertInstance: unused,
  updateInstance: unused,
  updateInstanceByContainerId: unused,
  deleteInstance: unused,
  countActiveInstances: unused,
  getSubscriptionLimits: unused,
}));

const { getCachedNode, refreshNode, peekCachedNode, resetNodeCache } = await import("./node-cache");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetNodeCache();
  calls = 0;
  nextNode = makeNode();
  failWith = null;
  delayMs = 0;
});

describe("getCachedNode", () => {
  it("fetches once and serves the rest from memory", async () => {
    const a = await getCachedNode();
    const b = await getCachedNode();

    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(a.id).toBe("test-node");
  });

  it("collapses a concurrent cold-start burst into one fetch", async () => {
    delayMs = 5;
    const results = await Promise.all(Array.from({ length: 5 }, () => getCachedNode()));

    expect(calls).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it("refetches once the TTL has elapsed", async () => {
    await getCachedNode();
    await sleep(60);
    await getCachedNode();

    expect(calls).toBe(2);
  });

  it("rejects when the very first fetch fails and there is nothing cached", async () => {
    failWith = new Error("rest-api down");

    await expect(getCachedNode()).rejects.toThrow("rest-api down");
    expect(peekCachedNode()).toBeNull();
  });
});

describe("failure handling", () => {
  it("serves the stale row rather than throwing once the cache is warm", async () => {
    const warm = await getCachedNode();
    await sleep(60);
    failWith = new Error("rest-api down");

    const stale = await getCachedNode();

    expect(stale).toBe(warm);
    expect(calls).toBe(2);
  });

  it("backs off after a failure instead of retrying on every call", async () => {
    await getCachedNode();
    await sleep(60);
    failWith = new Error("rest-api down");
    await getCachedNode();
    const afterFirstFailure = calls;

    // Inside the backoff window: no further attempts.
    await getCachedNode();
    await getCachedNode();

    expect(calls).toBe(afterFirstFailure);
  });

  it("resumes fetching once the backoff expires", async () => {
    await getCachedNode();
    await sleep(60);
    failWith = new Error("rest-api down");
    await getCachedNode();
    const afterFailure = calls;

    await sleep(60);
    failWith = null;
    nextNode = makeNode({ command_key_hash: "hash-b" });
    const recovered = await getCachedNode();

    expect(calls).toBe(afterFailure + 1);
    expect(recovered.command_key_hash).toBe("hash-b");
  });
});

describe("refreshNode", () => {
  // The rotation invariant: a warm cache must never satisfy a forced refresh,
  // or a rotated obs_command key could never reach this node.
  it("fetches even when the cache is warm and unexpired", async () => {
    await getCachedNode();
    expect(calls).toBe(1);

    nextNode = makeNode({ command_key_hash: "hash-b" });
    const fresh = await refreshNode();

    expect(calls).toBe(2);
    expect(fresh.command_key_hash).toBe("hash-b");
  });

  it("writes through, so the next cached read sees the new value without fetching", async () => {
    await getCachedNode();
    nextNode = makeNode({ command_key_hash: "hash-b" });
    await refreshNode();
    const after = await getCachedNode();

    expect(after.command_key_hash).toBe("hash-b");
    expect(calls).toBe(2);
  });

  it("ignores the error backoff", async () => {
    await getCachedNode();
    await sleep(60);
    failWith = new Error("rest-api down");
    await getCachedNode();
    const afterFailure = calls;

    failWith = null;
    await refreshNode();

    expect(calls).toBe(afterFailure + 1);
  });

  it("joins an in-flight cached read rather than issuing a second request", async () => {
    delayMs = 10;
    const [cachedRead, forced] = await Promise.all([getCachedNode(), refreshNode()]);

    expect(calls).toBe(1);
    expect(cachedRead).toBe(forced);
  });

  it("propagates the error on failure", async () => {
    failWith = new Error("rest-api down");
    await expect(refreshNode()).rejects.toThrow("rest-api down");
  });

  it("does not leave a poisoned in-flight promise behind after a rejection", async () => {
    failWith = new Error("rest-api down");
    await expect(refreshNode()).rejects.toThrow();

    failWith = null;
    const recovered = await refreshNode();

    expect(recovered.id).toBe("test-node");
    expect(calls).toBe(2);
  });
});
