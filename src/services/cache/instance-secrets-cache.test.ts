import { test, expect, mock, beforeEach, setSystemTime, afterEach } from "bun:test";

// Import-time env requirements of the transitive module graph.
process.env.REST_API_URL ??= "http://127.0.0.1:1";
process.env.NODE_API_KEY ??= "test";

let calls: string[] = [];
let fail = false;
/** When true, the next request waits until release() is called. */
let pause = false;
let release: (() => void) | null = null;

mock.module("@/clients/streamwizard-api/secrets", () => ({
  apiGetInstanceSecrets: async (instanceId: string) => {
    calls.push(instanceId);
    if (pause && release === null) await new Promise<void>((resolve) => (release = resolve));
    if (fail) throw new Error("Request failed with status code 503");
    return { obs_ws_password: `obs-${instanceId}-${calls.length}`, vnc_password: `vnc-${instanceId}` };
  },
}));

const { getInstanceSecrets, forgetInstanceSecrets, clearInstanceSecretsCache } = await import(
  "./instance-secrets-cache"
);

beforeEach(() => {
  clearInstanceSecretsCache();
  calls = [];
  fail = false;
  pause = false;
  release = null;
});

afterEach(() => {
  setSystemTime();
});

test("a second read within the TTL comes from memory", async () => {
  const first = await getInstanceSecrets("i1");
  const second = await getInstanceSecrets("i1");

  expect(second).toEqual(first);
  expect(calls).toEqual(["i1"]);
});

test("entries are per instance", async () => {
  await getInstanceSecrets("i1");
  await getInstanceSecrets("i2");

  expect(calls).toEqual(["i1", "i2"]);
});

test("an entry expires after 5 minutes", async () => {
  const start = new Date("2026-11-01T12:00:00Z");
  setSystemTime(start);
  await getInstanceSecrets("i1");

  setSystemTime(new Date(start.getTime() + 4 * 60_000));
  await getInstanceSecrets("i1");
  expect(calls).toHaveLength(1);

  setSystemTime(new Date(start.getTime() + 5 * 60_000 + 1));
  await getInstanceSecrets("i1");
  expect(calls).toHaveLength(2);
});

test("forgetInstanceSecrets drops the entry, so the next read refetches", async () => {
  await getInstanceSecrets("i1");
  forgetInstanceSecrets("i1");
  await getInstanceSecrets("i1");

  expect(calls).toEqual(["i1", "i1"]);
});

test("a failure is not cached", async () => {
  fail = true;
  await expect(getInstanceSecrets("i1")).rejects.toThrow("503");

  fail = false;
  await getInstanceSecrets("i1");
  expect(calls).toEqual(["i1", "i1"]);
});

test("concurrent reads share one request", async () => {
  pause = true;
  const reads = [getInstanceSecrets("i1"), getInstanceSecrets("i1"), getInstanceSecrets("i1")];
  await Promise.resolve();
  release!();
  const results = await Promise.all(reads);

  expect(calls).toEqual(["i1"]);
  expect(new Set(results.map((r) => r.obs_ws_password)).size).toBe(1);
});

test("a delete during an in-flight read doesn't leave the result cached", async () => {
  pause = true;
  const read = getInstanceSecrets("i1");
  await Promise.resolve();
  forgetInstanceSecrets("i1");
  release!();
  await read;

  pause = false;
  await getInstanceSecrets("i1");
  expect(calls).toEqual(["i1", "i1"]);
});
