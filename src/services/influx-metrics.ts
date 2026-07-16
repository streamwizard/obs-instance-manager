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
    .intField("max_instances", node.max_instances)
    .intField("total_vram_mb", node.total_vram_mb);

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
