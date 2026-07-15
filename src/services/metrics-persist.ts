import { getAllMetrics } from "./metrics";
import { trackNodeMetrics, trackInstanceMetrics } from "./influx-metrics";
import { getNode, listNodeInstances } from "../clients/supabase";
import { log } from "../utils/logger";

// Independent persistence loop: decoupled from the live SSE/WS metrics push
// (routes/metrics.ts, routes/admin.ts) so history keeps recording in InfluxDB
// even when no admin/client happens to be connected right now.
export function startMetricsPersistence(nodeId: string, intervalMs = 10_000): void {
  setInterval(() => {
    persistOnce(nodeId).catch((err) =>
      log("error", "metrics persistence pass failed", { error: (err as Error).message }),
    );
  }, intervalMs);
}

async function persistOnce(nodeId: string): Promise<void> {
  const [node, nodeInstances] = await Promise.all([getNode(nodeId), listNodeInstances(nodeId)]);
  const runningInstances = nodeInstances.filter((i) => i.status === "running" && i.container_id);

  const payload = await getAllMetrics(runningInstances);

  trackNodeMetrics(node, payload.host, runningInstances.length);

  for (const instance of runningInstances) {
    const metrics = payload.containers[instance.id];
    if (metrics) trackInstanceMetrics(nodeId, instance, metrics);
  }
}
