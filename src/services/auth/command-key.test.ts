import { createHash } from "crypto";
import { describe, expect, it, mock } from "bun:test";
import type { Node } from "../types";

process.env.S3_ENDPOINT ??= "http://127.0.0.1:1";
process.env.S3_ACCESS_KEY ??= "test";
process.env.S3_SECRET_KEY ??= "test";
process.env.TOKEN_ENCRYPTION_KEY ??= "0".repeat(64);
process.env.NODE_ID ??= "test-node";
process.env.REST_API_URL ??= "http://127.0.0.1:1";
process.env.NODE_API_KEY ??= "test";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const KEY_A = "command-key-a";
const KEY_B = "command-key-b";

function makeNode(commandKeyHash: string | null): Node {
  return {
    id: "test-node",
    name: "obs-node-1",
    max_instances: 4,
    total_vram_mb: 24_000,
    ram_total_mb: 32_000,
    cpu_cores: 8,
    storage_total_mb: 250_000,
    gpu_model: "NVIDIA GeForce RTX 2070",
    hostname: "obs-node-1",
    gpu_bus_id: "00000000:01:00.0",
    max_encoder_sessions: 5,
    command_key_hash: commandKeyHash,
    created_at: "2026-07-21T00:00:00Z",
  } as Node;
}

let refreshCalls = 0;
let cachedCalls = 0;
let nextNode: Node = makeNode(sha(KEY_A));
let failWith: Error | null = null;

// Mock the cache, not the client — the point of these tests is WHICH cache
// entry point command-key reaches for.
mock.module("./node-cache", () => ({
  refreshNode: async () => {
    refreshCalls++;
    if (failWith) throw failWith;
    return nextNode;
  },
  getCachedNode: async () => {
    cachedCalls++;
    return nextNode;
  },
  peekCachedNode: () => nextNode,
  resetNodeCache: () => {},
}));

const { loadCommandKeyHash, verifyCommandKey, hasCommandKey, retryCommandKeyLoadIfMissing } =
  await import("./command-key");

/**
 * These tests share module state (`commandKeyHash`, `lastFetchAt`) and run in
 * declaration order, which is load-bearing: the mismatch-refresh path is gated
 * on a 30s cooldown measured from the last SUCCESSFUL fetch, so the only way to
 * exercise it without sleeping 30s is to go first, while `lastFetchAt` is still
 * 0 from a failed load. Do not reorder these blocks.
 */

describe("command-key, before any successful load", () => {
  it("reports no key and rejects everything", async () => {
    expect(hasCommandKey()).toBe(false);
  });

  it("a failed load leaves lastFetchAt untouched, so the cooldown stays open", async () => {
    failWith = new Error("rest-api down");
    await loadCommandKeyHash();

    expect(refreshCalls).toBe(1);
    expect(hasCommandKey()).toBe(false);
  });

  it("picks up a rotated key through the mismatch path", async () => {
    // lastFetchAt is still 0 (the load above failed), so the cooldown has
    // elapsed by definition and a mismatch is allowed to re-fetch.
    failWith = null;
    nextNode = makeNode(sha(KEY_B));
    const before = refreshCalls;

    const ok = await verifyCommandKey(KEY_B);

    expect(ok).toBe(true);
    expect(refreshCalls).toBe(before + 1);
    expect(hasCommandKey()).toBe(true);
  });
});

describe("command-key, with a warm hash", () => {
  it("accepts the matching key without touching the network", async () => {
    nextNode = makeNode(sha(KEY_B));
    await loadCommandKeyHash();
    const before = refreshCalls;

    expect(await verifyCommandKey(KEY_B)).toBe(true);
    expect(refreshCalls).toBe(before);
  });

  it("rejects a wrong key", async () => {
    expect(await verifyCommandKey("nope")).toBe(false);
  });

  it("does not re-fetch on repeated mismatches inside the cooldown", async () => {
    // The /obs route is public, so unauthenticated callers can reach this path.
    // The cooldown is what stops them amplifying into rest-api load.
    await loadCommandKeyHash();
    const before = refreshCalls;

    await verifyCommandKey("bad-1");
    await verifyCommandKey("bad-2");
    await verifyCommandKey("bad-3");

    expect(refreshCalls).toBe(before);
  });
});

describe("the rotation invariant", () => {
  it("loadCommandKeyHash forces a live read and never accepts a cached one", async () => {
    const refreshBefore = refreshCalls;
    const cachedBefore = cachedCalls;

    await loadCommandKeyHash();

    // If this ever flips to getCachedNode, a rotated obs_command key can never
    // reach this node and /obs fails closed permanently.
    expect(refreshCalls).toBe(refreshBefore + 1);
    expect(cachedCalls).toBe(cachedBefore);
  });

  it("survives a node with no command key provisioned", async () => {
    nextNode = makeNode(null);
    await loadCommandKeyHash();

    expect(hasCommandKey()).toBe(false);
    expect(await verifyCommandKey(KEY_B)).toBe(false);
  });
});

describe("the retry loop", () => {
  it("keeps fetching while no hash is held", async () => {
    // Carries state from the block above: the last load found no key, so the
    // loop must still be trying — this is the failed-boot-fetch self-heal.
    nextNode = makeNode(sha(KEY_A));
    const before = refreshCalls;

    await retryCommandKeyLoadIfMissing();

    expect(refreshCalls).toBe(before + 1);
    expect(hasCommandKey()).toBe(true);
  });

  it("goes quiet once a hash is held — rotation rides the mismatch path, not polling", async () => {
    const before = refreshCalls;

    await retryCommandKeyLoadIfMissing();

    expect(refreshCalls).toBe(before);
    expect(hasCommandKey()).toBe(true);
  });
});
