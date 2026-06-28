import { describe, expect, test } from "bun:test";
import { consumeTicket, issueTicket } from "./ws-tickets";

describe("ws-tickets", () => {
  test("issue then consume succeeds once with matching scope/instance", () => {
    const token = issueTicket({ userId: "u1", scope: "obsws", instanceId: "i1" });
    const ticket = consumeTicket(token, "obsws", "i1");
    expect(ticket).not.toBeNull();
    expect(ticket?.userId).toBe("u1");
  });

  test("second consume of the same token fails (single-use)", () => {
    const token = issueTicket({ userId: "u1", scope: "novnc", instanceId: "i1" });
    expect(consumeTicket(token, "novnc", "i1")).not.toBeNull();
    expect(consumeTicket(token, "novnc", "i1")).toBeNull();
  });

  test("scope mismatch fails", () => {
    const token = issueTicket({ userId: "u1", scope: "novnc", instanceId: "i1" });
    expect(consumeTicket(token, "obsws", "i1")).toBeNull();
  });

  test("instance mismatch fails", () => {
    const token = issueTicket({ userId: "u1", scope: "obsws", instanceId: "i1" });
    expect(consumeTicket(token, "obsws", "i2")).toBeNull();
  });

  test("node-wide scope uses null instance", () => {
    const token = issueTicket({ userId: "u1", scope: "metrics" });
    expect(consumeTicket(token, "metrics")).not.toBeNull();
  });

  test("metrics ticket rejected when an instance id is required", () => {
    const token = issueTicket({ userId: "u1", scope: "metrics" });
    expect(consumeTicket(token, "metrics", "i1")).toBeNull();
  });

  test("missing/unknown token returns null", () => {
    expect(consumeTicket(undefined, "metrics")).toBeNull();
    expect(consumeTicket("nope", "metrics")).toBeNull();
  });
});
