import { test, expect, mock, beforeEach } from "bun:test";

// The plan sweep stops exactly what rest-api lists, skips anything mid-start
// or mid-stop, and stops nothing when rest-api can't answer (SW-478).
let unentitled: string[] = [];
let listFails = false;
const rows: Record<string, { id: string; user_id: string; status: string; container_id: string | null }> = {};
const stopped: string[] = [];
const locked = new Set<string>();

mock.module("@/clients/supabase", () => ({
  listUnentitledInstanceIds: async () => {
    if (listFails) throw new Error("rest-api down");
    return unentitled;
  },
  getInstanceByIdAdmin: async (id: string) => rows[id] ?? null,
}));
mock.module("@/utils/instance-lock", () => ({
  isInstanceLocked: (id: string) => locked.has(id),
}));
mock.module("@/services/instances/stop-instance", () => ({
  stopInstance: async (instance: { id: string }) => {
    if (instance.id === "i-boom") throw new Error("docker said no");
    stopped.push(instance.id);
    return instance;
  },
}));

const { sweepUnentitledInstances } = await import("./plan-sweep");

function running(id: string) {
  rows[id] = { id, user_id: `owner-${id}`, status: "running", container_id: `c-${id}` };
}

beforeEach(() => {
  unentitled = [];
  listFails = false;
  stopped.length = 0;
  locked.clear();
  for (const id of Object.keys(rows)) delete rows[id];
});

test("stops every listed running instance", async () => {
  running("i-1");
  running("i-2");
  unentitled = ["i-1", "i-2"];
  expect(await sweepUnentitledInstances("node-1")).toEqual(["i-1", "i-2"]);
  expect(stopped).toEqual(["i-1", "i-2"]);
});

test("skips locked instances and rows that are no longer running", async () => {
  running("i-1");
  running("i-2");
  rows["i-3"] = { id: "i-3", user_id: "u", status: "stopped", container_id: null };
  locked.add("i-1");
  unentitled = ["i-1", "i-2", "i-3", "i-gone"];
  expect(await sweepUnentitledInstances("node-1")).toEqual(["i-2"]);
});

test("one failed stop doesn't skip the rest", async () => {
  running("i-boom");
  running("i-2");
  unentitled = ["i-boom", "i-2"];
  expect(await sweepUnentitledInstances("node-1")).toEqual(["i-2"]);
});

test("stops nothing when rest-api can't answer", async () => {
  running("i-1");
  listFails = true;
  await expect(sweepUnentitledInstances("node-1")).rejects.toThrow("rest-api down");
  expect(stopped).toEqual([]);
});
