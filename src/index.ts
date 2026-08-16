import { Hono } from "hono";
import { cors } from "hono/cors";
import admin, { notifyMetricsDrain } from "./routes/admin";
import instances from "./routes/instances";
import files from "./routes/files";
import obs from "./routes/obs";
import metrics from "./routes/metrics";
import { websocket } from "./utils/ws";
import { debug, log } from "./utils/logger";
import { reconcileContainers, registerConfigHandlers, registerInstanceLifecycleHandlers, registerObsEventHandlers, startEventListener } from "./clients/docker";
import { getCachedNodeInstances } from "./services/instance-cache";
import { pushObsConfig, removeLocalConfig } from "./services/obs-config";
import { restartInstance } from "./services/instance-lifecycle";
import { checkS3 } from "./clients/s3";
import { NODE_ID } from "./utils/node";
import { CONFIG_AUTOSAVE_INTERVAL_MS, MAX_REQUEST_BODY_BYTES, OBS_EVENT_RESYNC_INTERVAL_MS } from "./utils/constants";
import { startMetricsPersistence } from "./services/metrics-persist";
import { loadCommandKeyHash, startCommandKeyRefresh } from "./services/command-key";
import { attachInstance, detachAll, detachInstance, syncInstances } from "./services/obs-event-listener";
import type { AppVariables } from "./types";

const app = new Hono<{ Variables: AppVariables }>();

const allowedOrigins = (process.env.PANEL_ORIGIN ?? "*").split(",");

// REST routes (not the WebSocket upgrades) are called directly from the
// panel's browser with an Authorization header, which triggers a CORS
// preflight OPTIONS request -- without this, that preflight falls through
// to authMiddleware and gets rejected for having no token, before the
// browser ever sends the real request.
//
// origin as a function (vs a plain array) lets us log every cross-origin
// request's outcome -- otherwise a rejected origin just looks like a silent
// browser-side CORS failure with nothing in these logs to explain it.
app.use(
  "*",
  cors({
    origin: (requestOrigin) => {
      if (allowedOrigins.includes("*")) {
        debug("cors", `allowing origin ${requestOrigin} (PANEL_ORIGIN=*)`);
        return requestOrigin;
      }
      if (allowedOrigins.includes(requestOrigin)) {
        debug("cors", `allowing origin ${requestOrigin}`);
        return requestOrigin;
      }
      debug("cors", `rejecting origin ${requestOrigin}, allowed: ${allowedOrigins.join(", ")}`);
      return null;
    },
    allowHeaders: ["Authorization", "Content-Type", "X-File-Path"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }),
);

// Media uploads (POST /instances/:id/files) legitimately exceed the 10MB cap
// -- they stream large assets to disk and enforce their own per-file/quota
// limits in services/media.ts. Every other route stays bounded.
const MEDIA_UPLOAD_PATH = /^\/instances\/[^/]+\/files$/;

app.use("*", async (c, next) => {
  const isMediaUpload = c.req.method === "POST" && MEDIA_UPLOAD_PATH.test(c.req.path);
  if (!isMediaUpload) {
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (contentLength > MAX_REQUEST_BODY_BYTES) {
      return c.json({ error: "Request body too large" }, 413);
    }
  }
  await next();
});

app.use("*", async (c, next) => {
  const start = performance.now();
  debug("http", `--> ${c.req.method} ${c.req.path}`);
  await next();
  const durationMs = (performance.now() - start).toFixed(1);
  debug("http", `<-- ${c.req.method} ${c.req.path} ${c.res.status} (${durationMs}ms)`);
});

app.get("/health", (c) => c.json({ ok: true, timestamp: new Date().toISOString() }));

app.route("/instances", instances);
app.route("/instances", files);
app.route("/metrics", metrics);
app.route("/admin", admin);
app.route("/obs", obs);

const port = Number(process.env.PORT) || 3000;

await checkS3();

registerConfigHandlers(pushObsConfig, removeLocalConfig);
registerInstanceLifecycleHandlers(restartInstance);
registerObsEventHandlers(attachInstance, detachInstance);

await reconcileContainers(NODE_ID).catch((err) =>
  log("error", "boot-time container reconciliation failed", { error: (err as Error).message }),
);

startEventListener();

// Watch every already-running instance's OBS for scene changes, then keep that
// set honest on an interval -- the docker event stream drives attach/detach
// live, this is the backstop for anything it missed (dropped stream, a status
// flipped by reconcile rather than an event).
// Not awaited: the first pass staggers its attaches, and nothing downstream --
// least of all binding the HTTP port -- needs to wait on it.
void syncInstances().catch((err) =>
  log("error", "boot-time OBS scene listener sync failed", { error: (err as Error).message }),
);

setInterval(() => {
  syncInstances().catch((err) =>
    log("error", "OBS scene listener resync failed", { error: (err as Error).message }),
  );
}, OBS_EVENT_RESYNC_INTERVAL_MS);

startMetricsPersistence(NODE_ID);

// Load this node's obs_command key hash so the /obs route can authenticate the
// obs-auto-switcher. The retry loop only fires while no hash is held (failed
// boot fetch); rotations propagate through verifyCommandKey's mismatch path,
// not polling.
await loadCommandKeyHash();
startCommandKeyRefresh();

// Bounds config-loss exposure from a hard crash (see CONFIG_AUTOSAVE_INTERVAL_MS)
// by periodically pushing every running instance's config to S3, same as a
// clean /stop does. Failures are per-instance and non-fatal -- one bad push
// shouldn't skip the rest or crash the interval.
setInterval(() => {
  autosaveRunningInstanceConfigs().catch((err) =>
    log("error", "config autosave pass failed", { error: (err as Error).message }),
  );
}, CONFIG_AUTOSAVE_INTERVAL_MS);

async function autosaveRunningInstanceConfigs(): Promise<void> {
  const nodeInstances = await getCachedNodeInstances();
  const running = nodeInstances.filter((i) => i.status === "running" && i.container_id);

  await Promise.all(
    running.map((instance) =>
      pushObsConfig(instance.user_id, instance.id).catch((e) =>
        log("warn", "config autosave push failed", {
          instanceId: instance.id,
          error: (e as Error).message,
        }),
      ),
    ),
  );

  debug("autosave", `pushed config for ${running.length} running instance(s)`);
}

const server = Bun.serve({
  port,
  fetch: app.fetch,
  websocket,
});

log("info", `OBS Panel API listening on port ${port}`);

// Grace window between telling metrics clients to reconnect and actually
// tearing the server down, so they can re-dial (to this or a replacement node)
// before their current socket dies -- Twitch EventSub-style graceful drain.
const DRAIN_GRACE_MS = 5000;

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
  server.stop(true);
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
