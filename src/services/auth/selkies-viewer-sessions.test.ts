import { afterEach, expect, test } from "bun:test";
import { RECONNECT_GRACE_MS, SESSION_MAX_MS, ViewerSessions } from "./selkies-viewer-sessions";
import type { Ticket } from "./ws-tickets";

let clock = 1_000_000;
const sessions = new ViewerSessions(() => clock);
afterEach(() => {
  clock = 1_000_000;
  sessions.sweep();
});

const ticket: Ticket = { userId: "user-1", scope: "selkies", instanceId: "inst-1", expiresAt: 0 };

test("a session is bound to its instance", () => {
  sessions.start("tok-a", ticket, "obs-instance-inst-1");
  expect(sessions.get("tok-a", "inst-1")?.containerName).toBe("obs-instance-inst-1");
  expect(sessions.get("tok-a", "inst-2")).toBeNull();
  expect(sessions.get("unknown", "inst-1")).toBeNull();
});

test("an idle session dies after the reconnect grace", () => {
  sessions.start("tok-b", ticket, "c");
  clock += RECONNECT_GRACE_MS;
  expect(sessions.get("tok-b", "inst-1")).not.toBeNull();
  clock += 1;
  expect(sessions.get("tok-b", "inst-1")).toBeNull();
});

test("an open socket keeps it alive; the grace restarts when the last one closes", () => {
  const s = sessions.start("tok-c", ticket, "c");
  sessions.socketOpened(s);
  clock += RECONNECT_GRACE_MS * 10;
  expect(sessions.get("tok-c", "inst-1")).not.toBeNull();

  sessions.socketClosed(s);
  clock += RECONNECT_GRACE_MS - 1;
  expect(sessions.get("tok-c", "inst-1")).not.toBeNull();
  clock += 2;
  expect(sessions.get("tok-c", "inst-1")).toBeNull();
});

test("no session outlives the hard cap, even with a socket open", () => {
  const s = sessions.start("tok-d", ticket, "c");
  sessions.socketOpened(s);
  clock += SESSION_MAX_MS + 1;
  expect(sessions.get("tok-d", "inst-1")).toBeNull();
});

test("end() drops a session at once", () => {
  sessions.start("tok-e", ticket, "c");
  sessions.end("tok-e");
  expect(sessions.get("tok-e", "inst-1")).toBeNull();
});

test("sweep removes dead sessions", () => {
  const own = new ViewerSessions(() => clock);
  own.start("tok-f", ticket, "c");
  own.start("tok-g", ticket, "c");
  expect(own.size).toBe(2);
  clock += RECONNECT_GRACE_MS + 1;
  own.sweep();
  expect(own.size).toBe(0);
  own.dispose();
});
