import { Point } from "@influxdata/influxdb-client";
import { pushPoint } from "../clients/influx";
import type { ContainerMetrics, HostMetrics, Instance, Node } from "../types";

// Persists what getAllMetrics() already computes (see metrics.ts) into
// InfluxDB so there's history/dashboarding beyond the live SSE/WS push. Two
// measurements: one node-wide point per sample, one per running instance.

export function trackNodeMetrics(node: Node, host: HostMetrics, runningInstanceCount: number): void {
  const point = new Point("obs_node")
    .tag("node_id", node.id)
    .floatField("cpu_pct", host.cpu_pct)
    .floatField("ram_used_mb", host.ram_used_mb)
    .floatField("ram_total_mb", host.ram_total_mb)
    .floatField("gpu_util_pct", host.gpu_util_pct)
    .floatField("vram_used_mb", host.vram_used_mb)
    .floatField("vram_total_mb", host.vram_total_mb)
    .floatField("gpu_temp_c", host.gpu_temp_c)
    .floatField("nvenc_avg_fps", host.nvenc_avg_fps)
    .intField("nvenc_sessions", host.nvenc_sessions)
    .floatField("rx_bytes_per_sec", host.rx_bytes_per_sec)
    .floatField("tx_bytes_per_sec", host.tx_bytes_per_sec)
    .intField("running_instance_count", runningInstanceCount)
    // Capacity, not a measurement — but the alerting side reads it back out of
    // Influx (obs.capacity_full compares it against running_instance_count) and
    // the admin fleet view renders running/max from it, so it has to ride every
    // point. node.total_vram_mb used to be written here too and was dropped:
    // nothing ever read it, and the VRAM the dashboards actually chart is
    // host.vram_total_mb above.
    .intField("max_instances", node.max_instances);

  // null = pro card without a driver session cap — no capacity rule applies,
  // so the field is simply absent for those nodes.
  if (node.max_encoder_sessions !== null) {
    point.intField("max_encoder_sessions", node.max_encoder_sessions);
  }
  if (host.disk_used_pct !== undefined) {
    point.floatField("disk_used_pct", host.disk_used_pct);
  }
  if (host.encoder_util_pct !== undefined) {
    point.floatField("encoder_util_pct", host.encoder_util_pct);
  }
  if (host.power_draw_w !== undefined) {
    point.floatField("power_draw_w", host.power_draw_w);
  }
  if (host.sm_clock_mhz !== undefined) {
    point.floatField("sm_clock_mhz", host.sm_clock_mhz);
  }

  pushPoint(point);
}

/** Lifecycle events the watchdog acts on. "crash" = died with a non-clean
 * exit code (or found dead at reconcile); "stopped" = clean exit outside the
 * /stop route; the restart events record what the auto-heal did about it. */
export type InstanceLifecycleEvent = "crash" | "stopped" | "auto_restarted" | "restart_failed";

// The watchdog in clients/docker.ts recovers from these events silently —
// this point is what makes them observable: the alert engine reads the
// obs_instance_event measurement for crash / crash-loop / failed-restart
// rules, so every handler that reacts to a container death must write one.
export function trackInstanceEvent(
  nodeId: string,
  instanceId: string,
  userId: string | undefined,
  event: InstanceLifecycleEvent,
  meta?: { exitCode?: number; reason?: string }
): void {
  const point = new Point("obs_instance_event")
    .tag("node_id", nodeId)
    .tag("instance_id", instanceId)
    .tag("event", event)
    .intField("count", 1);
  if (userId) point.tag("user_id", userId);
  if (meta?.exitCode !== undefined) point.intField("exit_code", meta.exitCode);
  if (meta?.reason) point.tag("reason", meta.reason);
  pushPoint(point);
}

export function trackInstanceMetrics(nodeId: string, instance: Instance, metrics: ContainerMetrics): void {
  const point = new Point("obs_instance")
    .tag("node_id", nodeId)
    .tag("instance_id", instance.id)
    .tag("user_id", instance.user_id)
    .floatField("cpu_pct", metrics.cpu_pct)
    .floatField("ram_used_mb", metrics.ram_used_mb)
    .floatField("ram_limit_mb", metrics.ram_limit_mb)
    .floatField("vram_used_mb", metrics.vram_used_mb)
    .floatField("rx_bytes_per_sec", metrics.rx_bytes_per_sec)
    .floatField("tx_bytes_per_sec", metrics.tx_bytes_per_sec);

  pushPoint(point);
}
