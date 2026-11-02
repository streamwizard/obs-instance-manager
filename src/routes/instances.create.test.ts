import { test, expect, mock, beforeEach } from "bun:test";
import { Hono } from "hono";

// Import-time env requirements of the transitive module graph.
process.env.S3_ENDPOINT ??= "http://127.0.0.1:1";
process.env.S3_ACCESS_KEY ??= "test";
process.env.S3_SECRET_KEY ??= "test";
process.env.NODE_ID ??= "test-node";
process.env.REST_API_URL ??= "http://127.0.0.1:1";
process.env.NODE_API_KEY ??= "test";

// POST /instances ordering test: rest-api only releases a stream key to a
// node that already hosts a row for the user, so the key lookup must come
// after insertInstance, and a refusal must remove the row again.
const calls = {
  insert: [] as Record<string, unknown>[],
  insertToken: [] as (string | null)[],
  delete: [] as string[],
  createContainer: 0,
  containerPasswords: [] as { obsWsPassword?: string; vncPassword?: string }[],
  updates: [] as Record<string, unknown>[],
  lifecycle: [] as string[],
};
let keyRefused = false;
let testUser = 0;
let secretsError: Error | null = null;

class StreamKeyNotGrantedError extends Error {
  readonly code = "stream_key_not_granted";
}

mock.module("@/middleware/auth", () => ({
  authMiddleware: async (c: any, next: any) => {
    // Own user per test: the create route rate-limits 5 per user per minute.
    c.set("userId", `user-${testUser}`);
    c.set("nodeToken", { userId: `user-${testUser}`, scope: "instances:create", instanceId: null, role: "user" });
    c.set("nodeTokenRaw", "node-token-for-user-1");
    await next();
  },
}));
mock.module("@/clients/streamwizard-api/instances", () => ({
  countActiveInstances: async () => 0,
  insertInstance: async (row: Record<string, unknown>, nodeToken: string | null) => {
    calls.insert.push(row);
    calls.insertToken.push(nodeToken);
    return row;
  },
  deleteInstance: async (id: string) => {
    calls.delete.push(id);
  },
  updateInstance: async (_id: string, patch: Record<string, unknown>) => {
    calls.updates.push(patch);
    return { ...calls.insert[0], ...patch };
  },
  getInstanceById: async () => null,
  listUserInstances: async () => [],
}));
mock.module("@/clients/streamwizard-api/users", () => ({
  canInteractCloudObs: async () => true,
}));
mock.module("@/clients/streamwizard-api/subscriptions", () => ({
  getSubscriptionLimits: async () => ({
    resolution: "1920x1080",
    vram_mb: 4096,
    memory_mb: 4096,
    cpu_quota: 2,
    shm_size: "2g",
    config_template: "1080p30",
  }),
}));
mock.module("@/services/cache/node-cache", () => ({
  refreshNode: async () => ({ id: "node-1", max_instances: 10, max_encoder_sessions: null }),
  getCachedNode: async () => ({ id: "node-1", max_instances: 10, max_encoder_sessions: null }),
}));
mock.module("@/services/instances/twitch", () => ({
  StreamKeyNotGrantedError,
  requireStreamKey: async () => {
    if (keyRefused) throw new StreamKeyNotGrantedError("Connect Twitch first");
    return "live_key";
  },
}));
mock.module("@/clients/docker", () => ({
  createContainer: async (opts: { obsWsPassword?: string; vncPassword?: string }) => {
    calls.createContainer++;
    calls.containerPasswords.push({ obsWsPassword: opts.obsWsPassword, vncPassword: opts.vncPassword });
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
mock.module("@/clients/streamwizard-api/events", () => ({
  broadcastLifecycle: (_i: string, action: string) => {
    calls.lifecycle.push(action);
  },
}));
mock.module("@/services/storage/obs-config", () => ({
  pullObsConfig: async () => {},
  pushObsConfig: async () => {},
  persistAndRemoveLocalConfig: async () => true,
  removeLocalConfig: async () => {},
  removeS3Config: async () => {},
  injectStreamKey: async () => {},
  clearStreamKey: async () => {},
  injectObsWsPassword: async () => {},
}));
mock.module("@/services/storage/plugins", () => ({ syncPlugins: async () => {} }));
mock.module("@/services/instances/instance-lifecycle", () => ({
  restartInstance: async () => {
    throw new Error("not stubbed");
  },
  stopInstance: async () => {
    throw new Error("not stubbed");
  },
}));

// rest-api generates the VNC password at insert; the node reads it back.
mock.module("@/services/cache/instance-secrets-cache", () => ({
  getInstanceSecrets: async () => {
    if (secretsError) throw secretsError;
    return { obs_ws_password: "pw", vnc_password: "vnc-from-rest-api" };
  },
}));

const { default: instances } = await import("./instances");

function makeApp() {
  const app = new Hono();
  app.route("/instances", instances);
  return app;
}

function createRequest(extra: Record<string, unknown> = {}) {
  return new Request("http://node/instances", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer x" },
    body: JSON.stringify({
      subscription_id: "8dcfd602-c494-44bf-8a6b-2da84607cfa2",
      obs_ws_password: "pw",
      ...extra,
    }),
  });
}

beforeEach(() => {
  calls.insert = [];
  calls.insertToken = [];
  calls.delete = [];
  calls.createContainer = 0;
  calls.containerPasswords = [];
  calls.updates = [];
  calls.lifecycle = [];
  keyRefused = false;
  secretsError = null;
  testUser++;
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
  expect(calls.delete).toEqual([calls.insert[0]?.id as string]);
  expect(calls.createContainer).toBe(0);
  expect(calls.lifecycle).toEqual([]);
});

test("the user's node token is forwarded with the insert", async () => {
  const res = await makeApp().request(createRequest());
  expect(res.status).toBe(201);
  expect(calls.insertToken).toEqual(["node-token-for-user-1"]);
});

test("sends the plaintext OBS password to rest-api and never any ciphertext", async () => {
  // Older web apps still send these; the node must not pass them on.
  const res = await makeApp().request(
    createRequest({ obs_ws_password_ciphertext: "c", obs_ws_password_iv: "i", obs_ws_password_tag: "t" }),
  );
  expect(res.status).toBe(201);
  const row = calls.insert[0]!;
  expect(row.obs_ws_password).toBe("pw");
  expect(Object.keys(row).filter((k) => k.includes("ciphertext") || k.endsWith("_iv") || k.endsWith("_tag"))).toEqual([]);
});

test("boots the container with the VNC password rest-api generated", async () => {
  await makeApp().request(createRequest());
  expect(calls.containerPasswords).toEqual([{ obsWsPassword: "pw", vncPassword: "vnc-from-rest-api" }]);
});

test("secrets call fails: 500, the instance is marked error, nothing boots", async () => {
  secretsError = new Error("Request failed with status code 503");
  const res = await makeApp().request(createRequest());
  expect(res.status).toBe(500);
  expect(calls.createContainer).toBe(0);
  expect(calls.updates).toContainEqual({ status: "error" });
  expect(calls.lifecycle).toEqual(["starting", "error"]);
});
