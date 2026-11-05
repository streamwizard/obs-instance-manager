import { afterAll, beforeEach, expect, test } from "bun:test";

// The real client against a stub rest-api that records every request.
const seen: { path: string; auth: string | null; body: Record<string, unknown> }[] = [];
let status = 202;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    seen.push({
      path: new URL(req.url).pathname,
      auth: req.headers.get("authorization"),
      body: (await req.json()) as Record<string, unknown>,
    });
    return Response.json({ ok: status < 400 }, { status });
  },
});

process.env.REST_API_URL = `http://127.0.0.1:${server.port}`;
process.env.NODE_API_KEY ??= "test";

const { broadcastLifecycle, broadcastSceneChanged } = await import("./events");

const ID = "6953f34f-371a-4f0d-8377-f975c6f100a8";
async function waitForRequests(n: number) {
  for (let i = 0; i < 50 && seen.length < n; i++) await Bun.sleep(5);
}

beforeEach(() => {
  seen.length = 0;
  status = 202;
});
afterAll(() => server.stop(true));

test("a lifecycle event goes to rest-api with the node key, and names no user", async () => {
  broadcastLifecycle(ID, "started");
  await waitForRequests(1);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.path).toBe(`/api/obs-nodes/instances/${ID}/events`);
  expect(seen[0]!.auth).toBe(`Bearer ${process.env.NODE_API_KEY}`);
  expect(seen[0]!.body).toMatchObject({ type: "lifecycle", action: "started" });
  expect(seen[0]!.body).not.toHaveProperty("userId");
});

test("a scene change goes to the same route", async () => {
  broadcastSceneChanged(ID, "BRB", "uuid-1");
  await waitForRequests(1);
  expect(seen[0]!.body).toMatchObject({ type: "scene_changed", sceneName: "BRB", sceneUuid: "uuid-1" });
});

test("a refused event never throws into the caller", async () => {
  status = 404;
  expect(() => broadcastLifecycle(ID, "error")).not.toThrow();
  await waitForRequests(1);
  await Bun.sleep(10);
  expect(seen).toHaveLength(1);
});
