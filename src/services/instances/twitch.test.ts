import { beforeEach, expect, mock, test } from "bun:test";
import type { StreamKeyLookup } from "../clients/streamwizard-api";

let lookup: StreamKeyLookup;
const warnings: string[] = [];

mock.module("../clients/streamwizard-api", () => ({
  apiGetStreamKey: async () => lookup,
}));
mock.module("../utils/logger", () => ({
  log: (_level: string, message: string) => {
    warnings.push(message);
  },
  debug: () => {},
}));

const { requireStreamKey, StreamKeyNotGrantedError } = await import("./twitch");

beforeEach(() => {
  warnings.length = 0;
});

test("returns the key when Twitch granted it", async () => {
  lookup = { key: "live_1", reason: "granted" };
  expect(await requireStreamKey("u")).toBe("live_1");
  expect(warnings).toEqual([]);
});

test("refuses when the user never granted the stream key scope", async () => {
  lookup = { key: null, reason: "scope_missing" };
  await expect(requireStreamKey("u")).rejects.toBeInstanceOf(StreamKeyNotGrantedError);
});

test("refuses when the user has no Twitch integration", async () => {
  lookup = { key: null, reason: "no_integration" };
  await expect(requireStreamKey("u")).rejects.toBeInstanceOf(StreamKeyNotGrantedError);
});

test("boots keyless with a warning when rest-api could not look the key up", async () => {
  lookup = { key: null, reason: "error" };
  expect(await requireStreamKey("u")).toBeNull();
  expect(warnings).toEqual(["stream key unavailable, booting without one"]);
});
