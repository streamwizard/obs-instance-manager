import { Hono } from "hono";
import { cors } from "hono/cors";
import admin, { notifyMetricsDrain } from "./routes/admin";
import instances from "./routes/instances";
import metrics from "./routes/metrics";
import { websocket } from "./utils/ws";
import { debug, log } from "./utils/logger";
import { ensureGpuXServer, reconcileContainers, registerConfigHandlers, startEventListener } from "./clients/docker";
import { pushObsConfig, removeLocalConfig } from "./services/obs-config";
import { checkS3 } from "./clients/s3";
import { getNode } from "./clients/supabase";
import { NODE_ID } from "./utils/node";
import { MAX_REQUEST_BODY_BYTES } from "./utils/constants";
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
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  }),
);

app.use("*", async (c, next) => {
  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (contentLength > MAX_REQUEST_BODY_BYTES) {
    return c.json({ error: "Request body too large" }, 413);
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
app.route("/metrics", metrics);
app.route("/admin", admin);

const port = Number(process.env.PORT) || 3000;

await checkS3();

registerConfigHandlers(pushObsConfig, removeLocalConfig);

await getNode(NODE_ID)
  .then((node) => ensureGpuXServer(node))
  .catch((err) =>
    log("error", "boot-time gpu-xserver provisioning failed", { error: (err as Error).message }),
  );

await reconcileContainers(NODE_ID).catch((err) =>
  log("error", "boot-time container reconciliation failed", { error: (err as Error).message }),
);

startEventListener();

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
  notifyMetricsDrain("/admin/metrics/stream");
  await new Promise((resolve) => setTimeout(resolve, DRAIN_GRACE_MS));
  server.stop(true);
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
