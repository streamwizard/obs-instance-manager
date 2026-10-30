import { test, expect, mock, beforeEach } from "bun:test";
import { Hono } from "hono";

// Import-time env requirements of the transitive module graph.
process.env.S3_ENDPOINT ??= "http://127.0.0.1:1";
process.env.S3_ACCESS_KEY ??= "test";
process.env.S3_SECRET_KEY ??= "test";
process.env.TOKEN_ENCRYPTION_KEY ??= "0".repeat(64);
process.env.NODE_ID ??= "test-node";
process.env.REST_API_URL ??= "http://127.0.0.1:1";
process.env.NODE_API_KEY ??= "test";

// POST /instances/:id/start must ask rest-api for the owner's plan every
// time: the plan can be revoked after the instance exists, and the caller may
// hold a token minted before that (SW-478).
const calls = {
  insert: [] as Record<string, unknown>[],
  delete: [] as string[],
  createContainer: 0,
  lifecycle: [] as string[],
};
const restarted: string[] = [];
let keyRefused = false;
let planActive = true;
let planLookupFails = false;
const stoppedInstance = { id: "i-1", user_id: "user-1", status: "stopped", container_id: null };

class StreamKeyNotGrantedError extends Error {
  readonly code = "stream_key_not_granted";
}

mock.module("../middleware/auth", () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set("userId", "user-1");
    await next();
  },
}));
mock.module("../clients/supabase", () => ({
  countActiveInstances: async () => 0,
  getSubscriptionLimits: async () => ({
    resolution: "1920x1080",
    vram_mb: 4096,
    memory_mb: 4096,
    cpu_quota: 2,
    shm_size: "2g",
    config_template: "1080p30",
  }),
  insertInstance: async (row: Record<string, unknown>) => {
    calls.insert.push(row);
    return row;
  },
  deleteInstance: async (id: string) => {
    calls.delete.push(id);
  },
  updateInstance: async (_id: string, patch: Record<string, unknown>) => ({ ...calls.insert[0], ...patch }),
  getInstanceById: async (id: string) => (id === "i-1" ? { ...stoppedInstance } : null),
  listUserInstances: async () => [],
  canInteractCloudObs: async () => {
    if (planLookupFails) throw new Error("rest-api down");
    return planActive;
  },
}));
mock.module("../services/node-cache", () => ({
  refreshNode: async () => ({ id: "node-1", max_instances: 10, max_encoder_sessions: null }),
  getCachedNode: async () => ({ id: "node-1", max_instances: 10, max_encoder_sessions: null }),
}));
mock.module("../services/twitch", () => ({
  StreamKeyNotGrantedError,
  requireStreamKey: async () => {
    if (keyRefused) throw new StreamKeyNotGrantedError("Connect Twitch first");
    return "live_key";
  },
}));
mock.module("../clients/docker", () => ({
  createContainer: async () => {
    calls.createContainer++;
    return "container-1";
  },
  startContainer: async () => {},
  removeContainer: async () => {},
  getContainerStatus: async () => "running",
  instanceTarget: () => "",
  markApiStopping: () => {},
  clearApiStopping: () => {},
  stopContainer: async () => {},
  NOVNC_PORT_INTERNAL: 6080,
  OBS_WS_PORT_INTERNAL: 4455,
}));
mock.module("../clients/ws-server", () => ({
  broadcastLifecycle: (_u: string, _i: string, action: string) => {
    calls.lifecycle.push(action);
  },
}));
mock.module("../services/obs-config", () => ({
  pullObsConfig: async () => {},
  pushObsConfig: async () => {},
  persistAndRemoveLocalConfig: async () => true,
  removeLocalConfig: async () => {},
  removeS3Config: async () => {},
  injectStreamKey: async () => {},
  clearStreamKey: async () => {},
  injectObsWsPassword: async () => {},
}));
mock.module("../services/plugins", () => ({ syncPlugins: async () => {} }));
mock.module("../services/instance-lifecycle", () => ({
  restartInstance: async (instance: Record<string, unknown>) => {
    restarted.push(instance.id as string);
    return { ...instance, status: "running" };
  },
  resolveVncPassword: async () => "vnc",
  stopInstance: async () => {
    throw new Error("not stubbed");
  },
}));

const { default: instances } = await import("./instances");

function start(id = "i-1") {
  const app = new Hono();
  app.route("/instances", instances);
  return app.request(new Request(`http://node/instances/${id}/start`, { method: "POST", headers: { authorization: "Bearer x" } }));
}

beforeEach(() => {
  restarted.length = 0;
  planActive = true;
  planLookupFails = false;
});

test("starts the instance when the plan is active", async () => {
  const res = await start();
  expect(res.status).toBe(200);
  expect(restarted).toEqual(["i-1"]);
});

test("refuses with 403 plan_required once the plan is gone", async () => {
  planActive = false;
  const res = await start();
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ code: "plan_required" });
  expect(restarted).toEqual([]);
});

test("refuses with 503 when the plan can't be checked", async () => {
  planLookupFails = true;
  const res = await start();
  expect(res.status).toBe(503);
  expect(restarted).toEqual([]);
});

test("someone else's instance is still a 404, before any plan lookup", async () => {
  planLookupFails = true;
  const res = await start("i-other");
  expect(res.status).toBe(404);
});
