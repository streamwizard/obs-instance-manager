import { getContainerCpuRam } from "@/services/metrics/cadvisor";
import { getDiskUsedPct, getHostBandwidth, getHostCpuPercent, getHostMemMb } from "@/services/metrics/host-stats";
import { queryNvidiaSmiComputeApps, queryNvidiaSmiGpu } from "@/services/metrics/nvidia-smi";
import type { ContainerMetrics, HostMetrics, Instance, MetricsPayload } from "@/types";
import { docker } from "@/clients/docker";

export async function getHostMetrics(): Promise<HostMetrics> {
  const [gpu, cpuPct, mem, bandwidth, diskUsedPct] = await Promise.all([
    queryNvidiaSmiGpu(),
    getHostCpuPercent(),
    getHostMemMb(),
    getHostBandwidth(),
    getDiskUsedPct(),
  ]);

  return {
    gpu_name: gpu.name,
    vram_used_mb: gpu.vram_used_mb,
    vram_total_mb: gpu.vram_total_mb,
    gpu_util_pct: gpu.gpu_util_pct,
    mem_controller_util_pct: gpu.mem_controller_util_pct,
    nvenc_avg_fps: gpu.nvenc_avg_fps,
    nvenc_sessions: gpu.nvenc_sessions,
    gpu_temp_c: gpu.gpu_temp_c,
    cpu_pct: cpuPct,
    ram_used_mb: mem.usedMb,
    ram_total_mb: mem.totalMb,
    rx_bytes_per_sec: bandwidth.rxBytesPerSec,
    tx_bytes_per_sec: bandwidth.txBytesPerSec,
    ...(diskUsedPct !== undefined ? { disk_used_pct: diskUsedPct } : {}),
    ...(gpu.encoder_util_pct !== undefined ? { encoder_util_pct: gpu.encoder_util_pct } : {}),
    ...(gpu.power_draw_w !== undefined ? { power_draw_w: gpu.power_draw_w } : {}),
    ...(gpu.sm_clock_mhz !== undefined ? { sm_clock_mhz: gpu.sm_clock_mhz } : {}),
  };
}

export async function getContainerMetrics(
  containerId: string,
  computeApps: Map<number, number>,
  ramLimitMb: number
): Promise<ContainerMetrics> {
  const container = docker.getContainer(containerId);

  const [cpuRam, topResult] = await Promise.all([
    getContainerCpuRam(containerId),
    container.top({}).catch(() => null),
  ]);

  const { cpu_pct, ram_used_mb, rx_bytes_per_sec, tx_bytes_per_sec } = cpuRam;
  const ram_limit_mb = ramLimitMb;

  let vram_used_mb = 0;
  if (topResult?.Processes) {
    const pidIndex = topResult.Titles.indexOf("PID");
    const containerPids = topResult.Processes.map((p: string[]) => Number(p[pidIndex])).filter(
      (pid: number) => !Number.isNaN(pid)
    );
    for (const pid of containerPids) {
      const vram = computeApps.get(pid);
      if (vram) vram_used_mb += vram;
    }
  }

  return { cpu_pct, ram_used_mb, ram_limit_mb, vram_used_mb, rx_bytes_per_sec, tx_bytes_per_sec };
}

// A container sample failure (usually cAdvisor unreachable) silently drops
// that instance's obs_instance point every 10s tick; without a log trail this
// looks like the pipeline was never implemented. Log per instance, throttled.
const CONTAINER_METRICS_LOG_INTERVAL_MS = 5 * 60 * 1000;
const containerMetricsLastLoggedAt = new Map<string, number>();

function logContainerMetricsFailure(instanceId: string, err: unknown): void {
  const now = Date.now();
  const lastLogged = containerMetricsLastLoggedAt.get(instanceId) ?? 0;
  if (now - lastLogged < CONTAINER_METRICS_LOG_INTERVAL_MS) return;
  containerMetricsLastLoggedAt.set(instanceId, now);
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `[metrics] container sample failed for instance ${instanceId} (no obs_instance point written; next log in ${CONTAINER_METRICS_LOG_INTERVAL_MS / 60000}m): ${message}`
  );
}

export async function getAllMetrics(instances: Instance[]): Promise<MetricsPayload> {
  const runningInstances = instances.filter((i) => i.status === "running" && i.container_id);

  const [host, computeApps] = await Promise.all([getHostMetrics(), queryNvidiaSmiComputeApps()]);

  const containerMetricsList = await Promise.all(
    runningInstances.map(async (instance) => {
      // The container's own cgroup limit (plan-driven, set as HostConfig.Memory
      // in createContainer), not the node's total RAM -- ram_used_mb is a
      // per-container number, so the limit it's charted against has to be too.
      // This used to read obs_nodes.memory_mb, a column migration
      // 20260704000000 dropped: it resolved to undefined and Influx rejected
      // every point, taking the whole persistence pass down with it.
      const ramLimitMb = instance.memory_mb;
      try {
        const metrics = await getContainerMetrics(
          instance.container_id as string,
          computeApps,
          ramLimitMb
        );
        return [instance.id, metrics] as const;
      } catch (err) {
        logContainerMetricsFailure(instance.id, err);
        return null;
      }
    })
  );

  const containers: Record<string, ContainerMetrics> = {};
  for (const entry of containerMetricsList) {
    if (!entry) continue;
    const [id, metrics] = entry;
    containers[id] = metrics;
  }

  return {
    timestamp: new Date().toISOString(),
    host,
    containers,
  };
}
