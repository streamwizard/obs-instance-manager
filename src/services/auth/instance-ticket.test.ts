import { test, expect, mock } from "bun:test";

// The noVNC password on a ticket comes from rest-api (the node can't decrypt).
mock.module("@/services/cache/instance-secrets-cache", () => ({
  getInstanceSecrets: async () => ({ obs_ws_password: "obs-pw", vnc_password: "vnc-from-rest-api" }),
}));

const { mintInstanceTicket } = await import("./instance-ticket");

const instance = { id: "inst-1" } as never;

test("a novnc ticket carries the VNC password from rest-api", async () => {
  const res = await mintInstanceTicket("user-1", instance, "novnc");
  expect(res.vnc_password).toBe("vnc-from-rest-api");
  expect(typeof res.ticket).toBe("string");
});

test("an obsws ticket carries no password", async () => {
  const res = await mintInstanceTicket("user-1", instance, "obsws");
  expect(res.vnc_password).toBeUndefined();
});
