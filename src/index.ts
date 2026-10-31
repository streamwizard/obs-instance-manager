import { websocket } from "hono/bun";
import app from "@/app";
import { registerShutdownHandlers } from "@/shutdown";
import { checkS3 } from "@/clients/s3";
import { reconcileContainers } from "@/services/docker/reconcile";
import { startEventListener } from "@/services/docker/event-listener";
import { startSceneListenerSync } from "@/services/obs/obs-event-listener";
import { startMetricsPersistence } from "@/services/metrics/metrics-persist";
import { loadCommandKeyHash, startCommandKeyRefresh } from "@/services/auth/command-key";
import { startConfigAutosave } from "@/services/storage/config-autosave";
import { startPlanSweep } from "@/services/instances/plan-sweep";
import { NODE_ID } from "@/utils/node";
import { log } from "@/utils/logger";

const port = Number(process.env.PORT) || 3000;

await checkS3();

await reconcileContainers(NODE_ID).catch((err) =>
  log("error", "boot-time container reconciliation failed", { error: (err as Error).message }),
);

startEventListener();
startSceneListenerSync();
startMetricsPersistence(NODE_ID);

// Load this node's obs_command key hash so the /obs route can authenticate the
// obs-auto-switcher. The retry loop only fires while no hash is held (failed
// boot fetch); rotations propagate through verifyCommandKey's mismatch path,
// not polling.
await loadCommandKeyHash();
startCommandKeyRefresh();

startConfigAutosave();
startPlanSweep(NODE_ID);

const server = Bun.serve({
  port,
  fetch: app.fetch,
  websocket,
});

log("info", `OBS Panel API listening on port ${port}`);

registerShutdownHandlers(server);
