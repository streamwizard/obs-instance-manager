import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { authMiddleware } from "../middleware/auth";
import { listUserInstances } from "../clients/supabase";
import { getAllMetrics } from "../services/metrics";
import { STREAM_INTERVAL_MS } from "../utils/constants";
import { debug } from "../utils/logger";
import type { AppVariables } from "../types";

const metrics = new Hono<{ Variables: AppVariables }>();

metrics.use("*", authMiddleware);

metrics.get("/snapshot", async (c) => {
  const userId = c.get("userId");
  const userInstances = await listUserInstances(userId);
  const runningInstances = userInstances.filter((i) => i.status === "running");

  const payload = await getAllMetrics(runningInstances);
  return c.json(payload);
});

metrics.get("/stream", async (c) => {
  const userId = c.get("userId");

  return streamSSE(c, async (stream) => {
    let closed = false;
    stream.onAbort(() => {
      closed = true;
    });

    const sendMetrics = async () => {
      try {
        const userInstances = await listUserInstances(userId);
        const runningInstances = userInstances.filter((i) => i.status === "running");
        const payload = await getAllMetrics(runningInstances);

        await stream.writeSSE({
          event: "metrics",
          data: JSON.stringify(payload),
        });
      } catch (err) {
        debug("metrics", `stream failed for user ${userId}: ${(err as Error).message}`);
        await stream
          .writeSSE({
            event: "error",
            data: JSON.stringify({ error: "Metrics collection failed" }),
          })
          .catch(() => {});
        closed = true;
      }
    };

    await sendMetrics();

    while (!closed) {
      await stream.sleep(STREAM_INTERVAL_MS);
      if (closed) break;
      await sendMetrics();
    }
  });
});

export default metrics;
