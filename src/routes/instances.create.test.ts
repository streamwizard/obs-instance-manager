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

// POST /instances ordering test: rest-api only releases a stream key to a
// node that already hosts a row for the user, so the key lookup must come
// after insertInstance, and a refusal must remove the row again.
const calls = {
  insert: [] as Record<string, unknown>[],
  delete: [] as string[],
  createContainer: 0,
  lifecycle: [] as string[],
};
let keyRefused = false;

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
  getInstanceById: async () => null,
  listUserInstances: async () => [],
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
  removeLocalConfig: async () => {},
  removeS3Config: async () => {},
  injectStreamKey: async () => {},
  clearStreamKey: async () => {},
  injectObsWsPassword: async () => {},
}));
mock.module("../services/plugins", () => ({ syncPlugins: async () => {} }));
mock.module("../services/instance-lifecycle", () => ({
  restartInstance: async () => {
    throw new Error("not stubbed");
  },
  resolveVncPassword: async () => "vnc",
}));

const { default: instances } = await import("./instances");

function makeApp() {
  const app = new Hono();
  app.route("/instances", instances);
  return app;
}

function createRequest() {
  return new Request("http://node/instances", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer x" },
    body: JSON.stringify({
      subscription_id: "8dcfd602-c494-44bf-8a6b-2da84607cfa2",
      obs_ws_password: "pw",
    }),
  });
}

beforeEach(() => {
  calls.insert = [];
  calls.delete = [];
  calls.createContainer = 0;
  calls.lifecycle = [];
  keyRefused = false;
});

test("first-ever create: row is inserted before the stream key lookup, then the container boots", async () => {
  const res = await makeApp().request(createRequest());
  expect(res.status).toBe(201);
  expect(calls.insert).toHaveLength(1);
  expect(calls.insert[0]?.status).toBe("creating");
  expect(calls.delete).toEqual([]);
  expect(calls.createContainer).toBe(1);
  expect(calls.lifecycle).toEqual(["starting", "started"]);
});

test("stream key refused: 409, the just-inserted row is removed, nothing boots", async () => {
  keyRefused = true;
  const res = await makeApp().request(createRequest());
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: "stream_key_not_granted" });
  expect(calls.insert).toHaveLength(1);
  expect(calls.delete).toEqual([calls.insert[0]?.id]);
  expect(calls.createContainer).toBe(0);
  expect(calls.lifecycle).toEqual([]);
});
