import { describe, expect, test } from "bun:test";
import { KeyedRateLimiter, MessageRateLimiter } from "./rate-limit";

describe("MessageRateLimiter", () => {
  test("allows exactly `limit` messages within a window", () => {
    const limiter = new MessageRateLimiter(3, 1000);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
  });

  test("rejects the message one past the limit", () => {
    const limiter = new MessageRateLimiter(3, 1000);
    limiter.allow();
    limiter.allow();
    limiter.allow();
    expect(limiter.allow()).toBe(false);
  });

  test("resets the count once the window elapses", async () => {
    const limiter = new MessageRateLimiter(1, 20);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(limiter.allow()).toBe(true);
  });
});

describe("KeyedRateLimiter", () => {
  test("allows exactly `limit` calls per key within the window", () => {
    const limiter = new KeyedRateLimiter(2, 1000);
    expect(limiter.allow("user-1")).toBe(true);
    expect(limiter.allow("user-1")).toBe(true);
    expect(limiter.allow("user-1")).toBe(false);
  });

  test("tracks separate keys independently", () => {
    const limiter = new KeyedRateLimiter(1, 1000);
    expect(limiter.allow("user-1")).toBe(true);
    expect(limiter.allow("user-2")).toBe(true);
    expect(limiter.allow("user-1")).toBe(false);
    expect(limiter.allow("user-2")).toBe(false);
  });

  test("expires old hits out of the sliding window", async () => {
    const limiter = new KeyedRateLimiter(1, 20);
    expect(limiter.allow("user-1")).toBe(true);
    expect(limiter.allow("user-1")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(limiter.allow("user-1")).toBe(true);
  });
});
