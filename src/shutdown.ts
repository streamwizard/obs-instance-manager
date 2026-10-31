import type { Server } from "bun";
import { notifyMetricsDrain } from "@/services/metrics/metrics-stream";
import { detachAll } from "@/services/obs/obs-event-listener";
import { closeInflux } from "@/clients/influx";
import { log } from "@/utils/logger";

// Grace window between telling metrics clients to reconnect and actually
// tearing the server down, so they can re-dial (to this or a replacement node)
// before their current socket dies -- Twitch EventSub-style graceful drain.
const DRAIN_GRACE_MS = 5000;

// Cap on flushing buffered Influx points, so an unreachable Influx (close()
// retries) can't outlast Docker's stop timeout.
const INFLUX_FLUSH_TIMEOUT_MS = 2000;

export function registerShutdownHandlers(server: Server<unknown>): void {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", `received ${signal}, draining metrics clients then shutting down`);
    // Close the OBS scene sockets deliberately rather than letting them be ripped
    // down with the process, and stop their retry loops from firing mid-drain.
    detachAll();
    notifyMetricsDrain("/admin/metrics/stream");
    await new Promise((resolve) => setTimeout(resolve, DRAIN_GRACE_MS));
    await Promise.race([closeInflux(), new Promise((resolve) => setTimeout(resolve, INFLUX_FLUSH_TIMEOUT_MS))]);
    server.stop(true);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
