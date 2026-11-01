import { test, expect, mock, beforeEach } from "bun:test";

// The password comes from rest-api now; these cover the paths where it can't
// be had. Both must fail as a 502 before any obs-websocket connection.
let connects = 0;
let secretsError: Error | null = null;
let obsWsPassword: string | null = "secret";

mock.module("obs-websocket-js", () => ({
  default: class {
    async connect() {
      connects++;
    }
  },
}));
mock.module("@/clients/docker", () => ({
  instanceTarget: (containerName: string, port: number) => `${containerName}:${port}`,
  OBS_WS_PORT_INTERNAL: 4455,
}));
mock.module("@/services/cache/instance-secrets-cache", () => ({
  getInstanceSecrets: async () => {
    if (secretsError) throw secretsError;
    return { obs_ws_password: obsWsPassword, vnc_password: "vnc" };
  },
}));

const { executeObsCommands, ObsCommandError } = await import("./obs-command");

const instance = { id: "inst-1", container_name: "obs-instance-inst-1", status: "running" } as never;
const commands = [{ request: "GetCurrentProgramScene" }];

beforeEach(() => {
  connects = 0;
  secretsError = null;
  obsWsPassword = "secret";
});

test("secrets call fails: 502 ObsCommandError, no connection", async () => {
  secretsError = new Error("Request failed with status code 503");

  const err = await executeObsCommands(instance, commands).catch((e) => e);

  expect(err).toBeInstanceOf(ObsCommandError);
  expect(err.status).toBe(502);
  expect(connects).toBe(0);
});

test("no OBS WebSocket password: 502 ObsCommandError, no connection", async () => {
  obsWsPassword = null;

  const err = await executeObsCommands(instance, commands).catch((e) => e);

  expect(err).toBeInstanceOf(ObsCommandError);
  expect(err.message).toContain("missing OBS WebSocket password");
  expect(err.status).toBe(502);
  expect(connects).toBe(0);
});
