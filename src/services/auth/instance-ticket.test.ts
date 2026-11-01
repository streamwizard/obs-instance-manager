import { test, expect, mock } from "bun:test";

// Ticket minting for the per-instance proxies: which viewer scope a node
// serves, and where the noVNC password comes from (rest-api, not the node).
// One object, changed in place: bun snapshots a mock's exports once.
const runtime: { viewer: "novnc" | "selkies" } = { viewer: "novnc" };

mock.module("@/clients/docker", () => ({ instanceRuntime: runtime }));
mock.module("@/services/cache/instance-secrets-cache", () => ({
  getInstanceSecrets: async () => ({ obs_ws_password: "obs-pw", vnc_password: "vnc-from-rest-api" }),
}));

const { isServedTicketScope, mintInstanceTicket } = await import("./instance-ticket");

const instance = { id: "inst-1" } as never;

test("a noVNC node serves novnc and obsws tickets, not selkies", () => {
  runtime.viewer = "novnc";
  expect(isServedTicketScope("novnc")).toBe(true);
  expect(isServedTicketScope("obsws")).toBe(true);
  expect(isServedTicketScope("selkies")).toBe(false);
});

test("a Selkies node serves selkies and obsws tickets, not novnc", () => {
  runtime.viewer = "selkies";
  expect(isServedTicketScope("selkies")).toBe(true);
  expect(isServedTicketScope("obsws")).toBe(true);
  expect(isServedTicketScope("novnc")).toBe(false);
});

test("a novnc ticket carries the VNC password from rest-api and the viewer", async () => {
  runtime.viewer = "novnc";
  const res = await mintInstanceTicket("user-1", instance, "novnc");
  expect(res.vnc_password).toBe("vnc-from-rest-api");
  expect(res.viewer).toBe("novnc");
  expect(typeof res.ticket).toBe("string");
});

test("other scopes carry no password", async () => {
  runtime.viewer = "selkies";
  const res = await mintInstanceTicket("user-1", instance, "selkies");
  expect(res.vnc_password).toBeUndefined();
  expect(res.viewer).toBe("selkies");
});
