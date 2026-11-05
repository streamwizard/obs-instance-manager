import { test, expect } from "bun:test";
import { mintInstanceTicket } from "./instance-ticket";
import { consumeTicket } from "./ws-tickets";

// Ticket minting for the per-instance proxies. No password rides along: the
// Selkies proxy adds the instance's basic auth upstream itself.
const instance = { id: "inst-1" } as never;

test("a selkies ticket is bound to its scope and instance, and carries no password", () => {
  const res = mintInstanceTicket("user-1", instance, "selkies");
  expect(Object.keys(res).sort()).toEqual(["expires_in", "ticket"]);
  // Longer than other tickets: the viewer page may wait on "OBS is starting".
  expect(res.expires_in).toBe(120);
  expect(mintInstanceTicket("user-1", instance, "obsws").expires_in).toBe(30);
  expect(consumeTicket(res.ticket, "obsws", "inst-1")).toBeNull();
});

test("a ticket is spent once", () => {
  const { ticket } = mintInstanceTicket("user-1", instance, "selkies");
  expect(consumeTicket(ticket, "selkies", "inst-1")?.userId).toBe("user-1");
  expect(consumeTicket(ticket, "selkies", "inst-1")).toBeNull();
});
