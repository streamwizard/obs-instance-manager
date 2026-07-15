import { InfluxDB, Point, type WriteApi } from "@influxdata/influxdb-client";
import { log } from "../utils/logger";

// Time-series sink for node/instance metrics (CPU/RAM/GPU/bandwidth). Copied
// from ingest-server's packages/metrics/src/influx-client.ts — this repo
// isn't part of that monorepo, so the pattern is duplicated rather than
// shared: lazy singleton, all four env vars required to enable, and metrics
// must never throw into a request or polling loop.

let writeApi: WriteApi | null = null;
let isConfigured = false;

function init(): void {
  if (isConfigured) return;
  isConfigured = true;

  const { INFLUXDB_URL, INFLUXDB_TOKEN, INFLUXDB_ORG, INFLUXDB_BUCKET } = process.env;
  if (!INFLUXDB_URL || !INFLUXDB_TOKEN || !INFLUXDB_ORG || !INFLUXDB_BUCKET) {
    log("info", "InfluxDB metrics disabled — set INFLUXDB_* env vars to enable");
    return;
  }

  try {
    const client = new InfluxDB({ url: INFLUXDB_URL, token: INFLUXDB_TOKEN });
    writeApi = client.getWriteApi(INFLUXDB_ORG, INFLUXDB_BUCKET, "ms", {
      batchSize: 50,
      flushInterval: 2000,
      maxRetries: 3,
      retryJitter: 200,
    });
    log("info", "InfluxDB metrics active", { url: INFLUXDB_URL, bucket: INFLUXDB_BUCKET });
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
  const { INFLUXDB_URL, INFLUXDB_TOKEN, INFLUXDB_ORG, INFLUXDB_BUCKET } = process.env;
  return !!(INFLUXDB_URL && INFLUXDB_TOKEN && INFLUXDB_ORG && INFLUXDB_BUCKET);
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
