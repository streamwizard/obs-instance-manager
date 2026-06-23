import { Hono } from "hono";
import instances from "./routes/instances";
import metrics from "./routes/metrics";
import type { AppVariables } from "./types";

const app = new Hono<{ Variables: AppVariables }>();

app.get("/health", (c) => c.json({ ok: true, timestamp: new Date().toISOString() }));

app.route("/instances", instances);
app.route("/metrics", metrics);

const port = Number(process.env.PORT) || 3000;

export default {
  port,
  fetch: app.fetch,
};

console.log(`OBS Panel API listening on port ${port}`);
