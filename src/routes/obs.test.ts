import { test, expect, mock, beforeEach } from "bun:test";
import { Hono } from "hono";

// Import-time env requirements of the transitive module graph
// (s3/crypto/node clients validate on import).
process.env.S3_ENDPOINT ??= "http://127.0.0.1:1";
process.env.S3_ACCESS_KEY ??= "test";
process.env.S3_SECRET_KEY ??= "test";
process.env.TOKEN_ENCRYPTION_KEY ??= "0".repeat(64);
process.env.NODE_ID ??= "test-node";
process.env.REST_API_URL ??= "http://127.0.0.1:1";
process.env.NODE_API_KEY ??= "test";

// The route pulls in clients/supabase -> streamwizard-api, which needs
// REST_API_URL/NODE_API_KEY at import time; stub the client module so the
// tests exercise auth + validation + lookup wiring without a panel.
let mockInstance: Record<string, unknown> | null = null;
const unused = () => {
  throw new Error("not stubbed");
};
mock.module("../clients/supabase", () => ({
  getInstanceByIdAdmin: async () => mockInstance,
  isAdmin: unused,
  getNode: unused,
  listUserInstances: unused,
  listNodeInstances: unused,
  getInstanceById: unused,
  insertInstance: unused,
  updateInstance: unused,
  updateInstanceByContainerId: unused,
  deleteInstance: unused,
  sumAllocatedVram: unused,
  countActiveInstances: unused,
  getSubscriptionLimits: unused,
}));

// Command-key auth is exercised through its two observable states here; the
// hash-loading/refresh logic itself lives in services/command-key.ts.
let keyLoaded = true;
const COMMAND_KEY = "good-command-key";
mock.module("../services/command-key", () => ({
  verifyCommandKey: async (token: string) => keyLoaded && token === COMMAND_KEY,
  hasCommandKey: () => keyLoaded,
  loadCommandKeyHash: async () => {},
  startCommandKeyRefresh: () => {},
}));

const { default: obs } = await import("./obs");
const { validateObsCommands, ObsCommandError } = await import("../services/obs-command");

function makeApp() {
  const app = new Hono();
  app.route("/obs", obs);
  return app;
}

function commandRequest(auth: string | null, body: unknown) {
  return new Request("http://node/obs/instances/inst-1/command", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });
}

const validBody = { commands: [{ request: "GetSceneList" }] };

beforeEach(() => {
  keyLoaded = true;
  mockInstance = null;
});

test("503 when the command key hasn't loaded yet", async () => {
  keyLoaded = false;
  const res = await makeApp().fetch(commandRequest(`Bearer ${COMMAND_KEY}`, validBody));
  expect(res.status).toBe(503);
});

test("401 on wrong or missing key", async () => {
  const app = makeApp();
  expect((await app.fetch(commandRequest("Bearer nope", validBody))).status).toBe(401);
  expect((await app.fetch(commandRequest(null, validBody))).status).toBe(401);
});

test("400 on non-whitelisted request", async () => {
  const res = await makeApp().fetch(
    commandRequest(`Bearer ${COMMAND_KEY}`, { commands: [{ request: "SetProfileParameter" }] }),
  );
  expect(res.status).toBe(400);
});

test("400 on empty or malformed commands", async () => {
  const app = makeApp();
  expect((await app.fetch(commandRequest(`Bearer ${COMMAND_KEY}`, { commands: [] }))).status).toBe(400);
  expect((await app.fetch(commandRequest(`Bearer ${COMMAND_KEY}`, {}))).status).toBe(400);
});

test("404 on unknown instance", async () => {
  mockInstance = null;
  const res = await makeApp().fetch(commandRequest(`Bearer ${COMMAND_KEY}`, validBody));
  expect(res.status).toBe(404);
});

test("409 when instance is not running", async () => {
  mockInstance = { id: "inst-1", status: "stopped", container_name: "obs-x" };
  const res = await makeApp().fetch(commandRequest(`Bearer ${COMMAND_KEY}`, validBody));
  expect(res.status).toBe(409);
});

test("502 when running instance is missing the obs-ws password", async () => {
  mockInstance = { id: "inst-1", status: "running", container_name: "obs-x" };
  const res = await makeApp().fetch(commandRequest(`Bearer ${COMMAND_KEY}`, validBody));
  expect(res.status).toBe(502);
});

test("validateObsCommands accepts the full whitelist and passes params through", () => {
  const cmds = validateObsCommands([
    { request: "SetCurrentProgramScene", params: { sceneUuid: "u-1" } },
    { request: "GetCurrentProgramScene" },
    { request: "GetSceneList" },
    { request: "GetSceneItemList", params: { sceneUuid: "u-1" } },
    { request: "SetSceneItemEnabled", params: { sceneUuid: "u-1", sceneItemId: 3, sceneItemEnabled: false } },
    { request: "GetStreamStatus" },
    { request: "StopStream" },
  ]);
  expect(cmds).toHaveLength(7);
  expect(cmds[0]!.params).toEqual({ sceneUuid: "u-1" });
});

test("validateObsCommands rejects >10 commands and array params", () => {
  expect(() => validateObsCommands(Array(11).fill({ request: "GetSceneList" }))).toThrow(ObsCommandError);
  expect(() => validateObsCommands([{ request: "GetSceneList", params: [] }])).toThrow(ObsCommandError);
});
