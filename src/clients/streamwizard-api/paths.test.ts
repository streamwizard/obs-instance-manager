import { test, expect, beforeEach, afterAll } from "bun:test";

// The real client against a stub rest-api that records every path it is
// asked for. Ids reach the client from route params, which Hono
// percent-decodes, so a "/" or ".." in one must never change which rest-api
// route gets called with this node's API key.
const seen: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch(req) {
    seen.push(new URL(req.url).pathname);
    return Response.json({ id: "x", obs_ws_password: null, vnc_password: "v", is_admin: false, can_interact: false });
  },
});

process.env.REST_API_URL = `http://127.0.0.1:${server.port}`;
process.env.NODE_API_KEY ??= "test";

const { getInstanceById, getInstanceByIdAdmin } = await import("./instances");
const { apiGetInstanceSecrets } = await import("./secrets");
const { isAdmin, canInteractCloudObs } = await import("./users");
const { pathSegment } = await import("./client");

const VALID = "6953f34f-371a-4f0d-8377-f975c6f100a8";

beforeEach(() => {
  seen.length = 0;
});

afterAll(() => {
  server.stop();
});

test("instance lookups refuse a non-UUID id without calling rest-api", async () => {
  for (const id of [`${VALID}/secrets`, "../../users/u1/stream-key", "..", "", "not-a-uuid"]) {
    expect(await getInstanceById(id, VALID)).toBeNull();
    expect(await getInstanceByIdAdmin(id)).toBeNull();
  }
  expect(seen).toEqual([]);
});

test("a valid instance id still reaches its own route", async () => {
  await getInstanceById(VALID, VALID);
  expect(seen).toEqual([`/api/obs-nodes/instances/${VALID}`]);
});

test("a slash inside an id is encoded, so it stays one path segment", async () => {
  await apiGetInstanceSecrets("abc/../../users/u1/stream-key").catch(() => {});
  await isAdmin("u1/../../instances/x").catch(() => {});

  expect(seen).toEqual([
    "/api/obs-nodes/instances/abc%2F..%2F..%2Fusers%2Fu1%2Fstream-key/secrets",
    "/api/obs-nodes/users/u1%2F..%2F..%2Finstances%2Fx/is-admin",
  ]);
});

test("dot segments and empty ids are refused before any request", async () => {
  for (const bad of ["", ".", ".."]) {
    expect(() => pathSegment(bad)).toThrow();
    await expect(apiGetInstanceSecrets(bad)).rejects.toThrow();
    await expect(canInteractCloudObs(bad)).rejects.toThrow();
  }
  expect(seen).toEqual([]);
});
