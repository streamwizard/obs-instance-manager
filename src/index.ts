import { Hono } from "hono";
import admin from "./routes/admin";
import instances from "./routes/instances";
import metrics from "./routes/metrics";
import { websocket } from "./lib/ws";
import type { AppVariables } from "./types";

const app = new Hono<{ Variables: AppVariables }>();

app.get("/health", (c) => c.json({ ok: true, timestamp: new Date().toISOString() }));

app.route("/instances", instances);
app.route("/metrics", metrics);
app.route("/admin", admin);

const port = Number(process.env.PORT) || 3000;

export default {
  port,
  fetch: app.fetch,
  websocket,
};

console.log(`OBS Panel API listening on port ${port}`);
