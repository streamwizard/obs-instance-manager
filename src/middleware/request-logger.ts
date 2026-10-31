import type { Context, Next } from "hono";
import { debug } from "@/utils/logger";

export async function requestLogger(c: Context, next: Next) {
  const start = performance.now();
  debug("http", `--> ${c.req.method} ${c.req.path}`);
  await next();
  const durationMs = (performance.now() - start).toFixed(1);
  debug("http", `<-- ${c.req.method} ${c.req.path} ${c.res.status} (${durationMs}ms)`);
}
