// Fixed-window message limiter for the per-instance websocket proxy, modeled
// on Wings' WS throttle (10 messages / 200ms) to stop a flood of input events
// from one client from hammering an instance container.
export class MessageRateLimiter {
  private windowStart = 0;
  private count = 0;

  constructor(
    private readonly limit: number = 10,
    private readonly windowMs: number = 200
  ) {}

  allow(): boolean {
    const now = Date.now();
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.limit;
  }
}

// Sliding-window limiter keyed by an arbitrary string (e.g. user id), for
// throttling HTTP routes per-caller rather than per-connection. Used for
// expensive routes like instance creation where MessageRateLimiter's
// single shared window doesn't fit.
export class KeyedRateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const timestamps = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);

    if (timestamps.length >= this.limit) {
      this.hits.set(key, timestamps);
      return false;
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    return true;
  }
}
