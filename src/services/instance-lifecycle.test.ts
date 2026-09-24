import { test, expect, mock, beforeEach } from "bun:test";

// Import-time env requirements of the transitive module graph.
process.env.S3_ENDPOINT ??= "http://127.0.0.1:1";
process.env.S3_ACCESS_KEY ??= "test";
process.env.S3_SECRET_KEY ??= "test";
process.env.TOKEN_ENCRYPTION_KEY ??= "0".repeat(64);
process.env.NODE_ID ??= "test-node";
process.env.REST_API_URL ??= "http://127.0.0.1:1";
process.env.NODE_API_KEY ??= "test";

// Docker is the only thing the start flow consults to decide between
// adopting an existing container and creating a new one, so it's the
// observable surface here. Everything that would touch S3/the panel/the
// config dir is stubbed and counted.
type Existing = { id: string; running: boolean } | null;
let existing: Existing = null;
// When non-empty, successive findContainerByName calls consume this queue
// before falling back to `existing` -- lets a test change Docker's answer
// between the pre-create probe and the post-failure probe.
let probeQueue: Existing[] = [];
let createError: Error | null = null;
const calls = {
  createContainer: 0,
  startContainer: 0,
  removeContainer: [] as string[],
  pullObsConfig: 0,
  injectObsWsPassword: 0,
  updates: [] as Record<string, unknown>[],
  lifecycle: [] as string[],
};

mock.module("../clients/docker", () => ({
  findContainerByName: async () => (probeQueue.length ? probeQueue.shift()! : existing),
  createContainer: async () => {
    calls.createContainer++;
    if (createError) throw createError;
    return "new-container";
  },
  startContainer: async () => {
    calls.startContainer++;
  },
  removeContainer: async (id: string) => {
    calls.removeContainer.push(id);
  },
}));
mock.module("../clients/supabase", () => ({
  updateInstance: async (_id: string, patch: Record<string, unknown>) => {
    calls.updates.push(patch);
    return { ...instance, ...patch };
  },
}));
mock.module("../clients/ws-server", () => ({
  broadcastLifecycle: (_u: string, _i: string, action: string) => {
    calls.lifecycle.push(action);
  },
}));
mock.module("../utils/crypto", () => ({
  decryptPassword: () => "obs-pw",
  encryptPassword: () => ({ ciphertext: "c", iv: "i", tag: "t" }),
  generateVncPassword: () => "vnc-pw",
}));
mock.module("./obs-config", () => ({
  pullObsConfig: async () => {
    calls.pullObsConfig++;
  },
  injectObsWsPassword: async () => {
    calls.injectObsWsPassword++;
  },
  injectStreamKey: async () => {},
}));
mock.module("./plugins", () => ({ syncPlugins: async () => {} }));
// Both names so the stub matches main (getStreamKey) and the stream-key-scope
// branch (requireStreamKey) without a rebase-time edit.
let streamKeyError: Error | null = null;
mock.module("./twitch", () => ({
  getStreamKey: async () => "live_key",
  requireStreamKey: async () => {
    if (streamKeyError) throw streamKeyError;
    return "live_key";
  },
  StreamKeyNotGrantedError: class extends Error {},
}));

const { restartInstance } = await import("./instance-lifecycle");
const { isInstanceLocked } = await import("../utils/instance-lock");

const instance = {
  id: "inst-1",
  user_id: "user-1",
  node_id: "node-1",
  container_id: "old-container",
  container_name: "obs-instance-inst-1",
  resolution: "1920x1080",
  status: "error",
  vram_allocated_mb: 4096,
  memory_mb: 4096,
  cpu_quota: 2,
  shm_size: "2g",
  config_template: null,
  subscription_id: "sub-1",
  obs_ws_password_ciphertext: "c",
  obs_ws_password_iv: "i",
  obs_ws_password_tag: "t",
  vnc_password_ciphertext: "c",
  vnc_password_iv: "i",
  vnc_password_tag: "t",
} as any;

beforeEach(() => {
  existing = null;
  probeQueue = [];
  createError = null;
  streamKeyError = null;
  calls.createContainer = 0;
  calls.startContainer = 0;
  calls.removeContainer = [];
  calls.pullObsConfig = 0;
  calls.injectObsWsPassword = 0;
  calls.updates = [];
  calls.lifecycle = [];
});

test("no existing container: creates, starts, marks running", async () => {
  const updated = await restartInstance(instance);
  expect(updated.status).toBe("running");
  expect(calls.createContainer).toBe(1);
  expect(calls.startContainer).toBe(1);
  expect(calls.updates).toEqual([{ container_id: "new-container", status: "running" }]);
  expect(calls.lifecycle).toEqual(["starting", "started"]);
});

test("running container already exists: adopts it without touching config", async () => {
  existing = { id: "live-container", running: true };
  const updated = await restartInstance(instance);
  expect(updated.status).toBe("running");
  expect(updated.container_id).toBe("live-container");
  expect(calls.createContainer).toBe(0);
  expect(calls.pullObsConfig).toBe(0);
  expect(calls.injectObsWsPassword).toBe(0);
  expect(calls.removeContainer).toEqual([]);
  expect(calls.updates).toEqual([{ container_id: "live-container", status: "running" }]);
  expect(calls.lifecycle).toEqual(["started"]);
});

test("stale exited container: removed, then a fresh one is created", async () => {
  existing = { id: "dead-container", running: false };
  const updated = await restartInstance(instance);
  expect(updated.status).toBe("running");
  expect(calls.removeContainer).toEqual(["dead-container"]);
  expect(calls.createContainer).toBe(1);
});

test("create fails and nothing is running: marks error and rethrows", async () => {
  createError = new Error("docker down");
  await expect(restartInstance(instance)).rejects.toThrow("docker down");
  expect(calls.updates).toEqual([{ status: "error" }]);
  expect(calls.lifecycle).toEqual(["starting", "error"]);
});

test("create fails but a running container appeared: adopts instead of marking error", async () => {
  createError = new Error("Conflict. The container name is already in use");
  // Docker says nothing exists at the pre-check, then a running one at the
  // post-failure check (the race the guard exists for).
  probeQueue = [null, { id: "winner", running: true }];
  const updated = await restartInstance(instance);
  expect(updated.status).toBe("running");
  expect(updated.container_id).toBe("winner");
  expect(calls.createContainer).toBe(1);
  expect(calls.updates).toEqual([{ container_id: "winner", status: "running" }]);
  expect(calls.lifecycle).not.toContain("error");
});

test("isInstanceLocked is true only while a start is in flight", async () => {
  expect(isInstanceLocked(instance.id)).toBe(false);
  const p = restartInstance(instance);
  expect(isInstanceLocked(instance.id)).toBe(true);
  await p;
  // The lock map entry is cleared on a microtask after settle.
  await new Promise((r) => setTimeout(r, 0));
  expect(isInstanceLocked(instance.id)).toBe(false);
});

test("stream key refused: rethrows before any broadcast, config write or status change", async () => {
  streamKeyError = new Error("Connect Twitch first");
  await expect(restartInstance(instance)).rejects.toThrow("Connect Twitch first");
  expect(calls.lifecycle).toEqual([]);
  expect(calls.pullObsConfig).toBe(0);
  expect(calls.injectObsWsPassword).toBe(0);
  expect(calls.createContainer).toBe(0);
  expect(calls.updates).toEqual([]);
});

test("missing websocket password: rethrows before any broadcast or side effect", async () => {
  await expect(restartInstance({ ...instance, obs_ws_password_ciphertext: null })).rejects.toThrow(
    "missing OBS WebSocket password"
  );
  expect(calls.lifecycle).toEqual([]);
  expect(calls.pullObsConfig).toBe(0);
  expect(calls.updates).toEqual([]);
});
