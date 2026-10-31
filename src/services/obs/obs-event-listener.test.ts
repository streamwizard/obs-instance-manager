import { test, expect, mock, beforeEach } from "bun:test";

// Import-time env requirements of the transitive module graph
// (crypto/node/streamwizard-api clients validate on import).
process.env.TOKEN_ENCRYPTION_KEY ??= "0".repeat(64);
process.env.NODE_ID ??= "test-node";
process.env.REST_API_URL ??= "http://127.0.0.1:1";
process.env.NODE_API_KEY ??= "test";
process.env.S3_ENDPOINT ??= "http://127.0.0.1:1";
process.env.S3_ACCESS_KEY ??= "test";
process.env.S3_SECRET_KEY ??= "test";

// --- fake obs-websocket -----------------------------------------------------
// One fake per connect() call, mirroring the real client: connect() resolves or
// rejects, call() answers GetCurrentProgramScene, and tests drive events by
// hand to simulate OBS switching scenes or the socket dropping.
type Listener = (payload?: unknown) => void;

class FakeObs {
  static instances: FakeObs[] = [];
  static connectBehaviour: "ok" | "fail" = "ok";
  static currentScene = { sceneName: "Live", sceneUuid: "uuid-live" };

  listeners = new Map<string, Listener[]>();
  connected = false;
  disconnected = false;
  connectUrl: string | null = null;

  constructor() {
    FakeObs.instances.push(this);
  }

  on(event: string, cb: Listener): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(cb);
    this.listeners.set(event, existing);
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  emit(event: string, payload?: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(payload);
  }

  async connect(url: string): Promise<void> {
    this.connectUrl = url;
    if (FakeObs.connectBehaviour === "fail") throw new Error("connection refused");
    this.connected = true;
  }

  async call(request: string): Promise<unknown> {
    if (request === "GetCurrentProgramScene") return FakeObs.currentScene;
    throw new Error(`unexpected request ${request}`);
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
    this.connected = false;
  }
}

mock.module("obs-websocket-js", () => ({
  default: FakeObs,
  EventSubscription: { Scenes: 4 },
}));

// --- other collaborators ----------------------------------------------------
const broadcasts: Array<{ userId: string; instanceId: string; sceneName: string; sceneUuid: string }> = [];
mock.module("../clients/ws-server", () => ({
  broadcastSceneChanged: (userId: string, instanceId: string, sceneName: string, sceneUuid: string) => {
    broadcasts.push({ userId, instanceId, sceneName, sceneUuid });
  },
  broadcastLifecycle: () => {},
}));

let nodeInstances: unknown[] = [];
const unused = () => {
  throw new Error("not stubbed");
};
mock.module("../clients/supabase", () => ({
  listNodeInstances: async () => nodeInstances,
  getInstanceByIdAdmin: unused,
  isAdmin: unused,
  getNode: unused,
  listUserInstances: unused,
  getInstanceById: unused,
  insertInstance: unused,
  updateInstance: unused,
  updateInstanceByContainerId: unused,
  deleteInstance: unused,
  countActiveInstances: unused,
  getSubscriptionLimits: unused,
}));

// Only instanceTarget/OBS_WS_PORT_INTERNAL are used, and importing the real
// module would construct a dockerode client against /var/run/docker.sock.
mock.module("../clients/docker", () => ({
  instanceTarget: (containerName: string, port: number) => `${containerName}:${port}`,
  OBS_WS_PORT_INTERNAL: 4455,
}));

// Encrypted-password fields are passed straight to decryptPassword; stub it so
// the tests don't need real AES material.
mock.module("../utils/crypto", () => ({
  decryptPassword: () => "secret",
}));

const { attachInstance, attachedInstanceIds, detachInstance, detachAll, syncInstances } = await import(
  "./obs-event-listener"
);

function makeInstance(overrides: Record<string, unknown> = {}) {
  return {
    id: "inst-1",
    user_id: "user-1",
    container_name: "obs-instance-inst-1",
    container_id: "container-1",
    status: "running",
    obs_ws_password_ciphertext: "ct",
    obs_ws_password_iv: "iv",
    obs_ws_password_tag: "tag",
    ...overrides,
  } as never;
}

// connect() runs in the background; let its microtasks settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  detachAll();
  FakeObs.instances = [];
  FakeObs.connectBehaviour = "ok";
  FakeObs.currentScene = { sceneName: "Live", sceneUuid: "uuid-live" };
  broadcasts.length = 0;
  nodeInstances = [];
});

test("attach connects to the instance container and seeds the current scene", async () => {
  attachInstance(makeInstance());
  await settle();

  expect(FakeObs.instances.length).toBe(1);
  expect(FakeObs.instances[0]!.connectUrl).toBe("ws://obs-instance-inst-1:4455");
  expect(broadcasts).toEqual([
    { userId: "user-1", instanceId: "inst-1", sceneName: "Live", sceneUuid: "uuid-live" },
  ]);
});

test("attach is idempotent", async () => {
  attachInstance(makeInstance());
  attachInstance(makeInstance());
  await settle();

  expect(FakeObs.instances.length).toBe(1);
  expect(attachedInstanceIds()).toEqual(["inst-1"]);
});

test("attaches regardless of the DB status, since the docker start event beats the status write", async () => {
  attachInstance(makeInstance({ status: "starting" }));
  await settle();

  expect(attachedInstanceIds()).toEqual(["inst-1"]);
});

test("skips an instance with no stored websocket password", async () => {
  attachInstance(makeInstance({ obs_ws_password_ciphertext: null }));
  await settle();

  expect(FakeObs.instances.length).toBe(0);
  expect(attachedInstanceIds()).toEqual([]);
});

test("broadcasts scene changes and dedupes a repeat of the same uuid", async () => {
  attachInstance(makeInstance());
  await settle();
  broadcasts.length = 0;

  const obs = FakeObs.instances[0]!;
  obs.emit("CurrentProgramSceneChanged", { sceneName: "BRB", sceneUuid: "uuid-brb" });
  obs.emit("CurrentProgramSceneChanged", { sceneName: "BRB", sceneUuid: "uuid-brb" });
  obs.emit("CurrentProgramSceneChanged", { sceneName: "Live", sceneUuid: "uuid-live" });

  expect(broadcasts.map((b) => b.sceneName)).toEqual(["BRB", "Live"]);
});

test("a dropped connection reconnects and re-emits the current scene", async () => {
  attachInstance(makeInstance());
  await settle();
  broadcasts.length = 0;

  // Same scene as before the drop: it must still be broadcast, because an
  // overlay that reloaded while we were disconnected has nothing rendered.
  FakeObs.instances[0]!.emit("ConnectionClosed");
  await new Promise((resolve) => setTimeout(resolve, 2_100));

  expect(FakeObs.instances.length).toBe(2);
  expect(broadcasts.map((b) => b.sceneUuid)).toEqual(["uuid-live"]);
}, 10_000);

test("a failed connect schedules a retry instead of throwing", async () => {
  FakeObs.connectBehaviour = "fail";
  attachInstance(makeInstance());
  await settle();

  expect(FakeObs.instances.length).toBe(1);
  expect(broadcasts).toEqual([]);
  // Still attached -- the retry loop owns it.
  expect(attachedInstanceIds()).toEqual(["inst-1"]);

  FakeObs.connectBehaviour = "ok";
  await new Promise((resolve) => setTimeout(resolve, 2_100));

  expect(FakeObs.instances.length).toBe(2);
  expect(broadcasts.map((b) => b.sceneUuid)).toEqual(["uuid-live"]);
}, 10_000);

test("detach stops the retry loop", async () => {
  FakeObs.connectBehaviour = "fail";
  attachInstance(makeInstance());
  await settle();

  detachInstance("inst-1");
  expect(attachedInstanceIds()).toEqual([]);

  FakeObs.connectBehaviour = "ok";
  await new Promise((resolve) => setTimeout(resolve, 2_100));

  expect(FakeObs.instances.length).toBe(1);
  expect(broadcasts).toEqual([]);
}, 10_000);

test("detach is idempotent and closes the socket", async () => {
  attachInstance(makeInstance());
  await settle();
  const obs = FakeObs.instances[0]!;

  detachInstance("inst-1");
  detachInstance("inst-1");

  expect(obs.disconnected).toBe(true);
  expect(attachedInstanceIds()).toEqual([]);
});

test("sync attaches running instances and detaches ones that left running", async () => {
  nodeInstances = [makeInstance(), makeInstance({ id: "inst-2", container_name: "obs-instance-inst-2" })];
  await syncInstances();
  await settle();

  expect(attachedInstanceIds().sort()).toEqual(["inst-1", "inst-2"]);

  nodeInstances = [makeInstance({ id: "inst-2", container_name: "obs-instance-inst-2" })];
  await syncInstances();

  expect(attachedInstanceIds()).toEqual(["inst-2"]);
}, 10_000);

test("sync ignores instances that are not running or have no container", async () => {
  nodeInstances = [
    makeInstance({ id: "inst-stopped", status: "stopped" }),
    makeInstance({ id: "inst-no-container", container_id: null }),
  ];
  await syncInstances();
  await settle();

  expect(attachedInstanceIds()).toEqual([]);
});
