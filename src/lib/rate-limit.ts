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
