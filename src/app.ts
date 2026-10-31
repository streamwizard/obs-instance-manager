import { Hono } from "hono";
import { corsMiddleware } from "@/middleware/cors";
import { bodyLimit } from "@/middleware/body-limit";
import { requestLogger } from "@/middleware/request-logger";
import admin from "@/routes/admin";
import instances from "@/routes/instances";
import files from "@/routes/files";
import obs from "@/routes/obs";
import metrics from "@/routes/metrics";
import type { AppVariables } from "@/types";

const app = new Hono<{ Variables: AppVariables }>();

app.use("*", corsMiddleware);
app.use("*", bodyLimit);
app.use("*", requestLogger);

app.get("/health", (c) => c.json({ ok: true, timestamp: new Date().toISOString() }));

app.route("/instances", instances);
app.route("/instances", files);
app.route("/metrics", metrics);
app.route("/admin", admin);
app.route("/obs", obs);

export default app;
