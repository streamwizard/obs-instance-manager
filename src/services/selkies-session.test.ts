import { test, expect } from "bun:test";
import { sessionKeyFrom, signSession, verifySession } from "./selkies-session";

const key = sessionKeyFrom("11".repeat(32));
const session = { instanceId: "inst-1", userId: "user-1", containerName: "obs-instance-inst-1", expiresAt: 2_000 };

test("round-trips for the instance it was issued for", () => {
  expect(verifySession(key, signSession(key, session), "inst-1", 1_000)).toEqual(session);
});

test("rejects another instance, expiry, tampering and a foreign key", () => {
  const value = signSession(key, session);
  expect(verifySession(key, value, "inst-2", 1_000)).toBeNull();
  expect(verifySession(key, value, "inst-1", 2_001)).toBeNull();

  const forged = signSession(key, { ...session, containerName: "obs-instance-other" }).split(".");
  const mixed = [...value.split(".").slice(0, 2), forged[2], ...value.split(".").slice(3)].join(".");
  expect(verifySession(key, mixed, "inst-1", 1_000)).toBeNull();

  expect(verifySession(sessionKeyFrom("22".repeat(32)), value, "inst-1", 1_000)).toBeNull();
  expect(verifySession(key, undefined, "inst-1", 1_000)).toBeNull();
  expect(verifySession(key, "garbage", "inst-1", 1_000)).toBeNull();
});
