import { InfluxDB, Point, type WriteApi } from "@influxdata/influxdb-client";
import { log } from "../utils/logger";

// Time-series sink for node/instance metrics (CPU/RAM/GPU/bandwidth). Copied
// from ingest-server's packages/metrics/src/influx-client.ts — this repo
// isn't part of that monorepo, so the pattern is duplicated rather than
// shared: lazy singleton, all three env vars required to enable, and metrics
// must never throw into a request or polling loop.

// Every OBS node writes into the "obs-nodes" bucket; the environment is picked
// by INFLUXDB_ORG (streamwizard-dev / -staging / -prod).
const BUCKET = "obs-nodes";

let writeApi: WriteApi | null = null;
let isConfigured = false;

function init(): void {
  if (isConfigured) return;
  isConfigured = true;

  const { INFLUXDB_URL, INFLUXDB_TOKEN, INFLUXDB_ORG } = process.env;
  if (!INFLUXDB_URL || !INFLUXDB_TOKEN || !INFLUXDB_ORG) {
    log("info", "InfluxDB metrics disabled — set INFLUXDB_* env vars to enable");
    return;
  }

  try {
    const client = new InfluxDB({ url: INFLUXDB_URL, token: INFLUXDB_TOKEN });
    writeApi = client.getWriteApi(INFLUXDB_ORG, BUCKET, "ms", {
      batchSize: 50,
      flushInterval: 2000,
      maxRetries: 3,
      retryJitter: 200,
    });
    log("info", "InfluxDB metrics active", { url: INFLUXDB_URL, org: INFLUXDB_ORG, bucket: BUCKET });
  } catch (err) {
    writeApi = null;
    log("error", "Failed to initialize InfluxDB client", { error: err instanceof Error ? err.message : String(err) });
  }
}

export function pushPoint(point: Point): void {
  try {
    init();
    if (!writeApi) return;
    writeApi.writePoint(point);
  } catch {
    // never throw from metrics code
  }
}

export function isMetricsEnabled(): boolean {
  const { INFLUXDB_URL, INFLUXDB_TOKEN, INFLUXDB_ORG } = process.env;
  return !!(INFLUXDB_URL && INFLUXDB_TOKEN && INFLUXDB_ORG);
}

export async function closeInflux(): Promise<void> {
  if (writeApi) {
    try {
      await writeApi.close();
    } catch {
      // ignore close errors
    }
    writeApi = null;
  }
}
