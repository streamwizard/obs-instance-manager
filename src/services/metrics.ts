import { getContainerCpuRam } from "./cadvisor";
import type { ContainerMetrics, HostMetrics, Instance, MetricsPayload } from "../types";
import { docker } from "../clients/docker";
import { getNode } from "../clients/supabase";

async function readProcStatCpuLine(): Promise<{ idle: number; total: number }> {
  const text = await Bun.file("/proc/stat").text();
  const cpuLine = text.split("\n").find((line) => line.startsWith("cpu "));
  if (!cpuLine) throw new Error("Could not read cpu line from /proc/stat");

  const parts = cpuLine.trim().split(/\s+/).slice(1).map(Number);
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = parts;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { idle: idle + iowait, total };
}

async function getHostCpuPercent(): Promise<number> {
  const first = await readProcStatCpuLine();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await readProcStatCpuLine();

  const idleDelta = second.idle - first.idle;
  const totalDelta = second.total - first.total;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

const IGNORED_INTERFACE_PREFIXES = ["lo", "docker", "veth", "br-"];

async function readNetDevTotals(): Promise<{ rxBytes: number; txBytes: number }> {
  const text = await Bun.file("/proc/net/dev").text();
  let rxBytes = 0;
  let txBytes = 0;

  for (const line of text.split("\n").slice(2)) {
    const [ifaceRaw, statsRaw] = line.split(":");
    if (!ifaceRaw || !statsRaw) continue;
    const iface = ifaceRaw.trim();
    if (IGNORED_INTERFACE_PREFIXES.some((prefix) => iface.startsWith(prefix))) continue;

    const fields = statsRaw.trim().split(/\s+/).map(Number);
    const [rx = 0, , , , , , , , tx = 0] = fields;
    rxBytes += rx;
    txBytes += tx;
  }

  return { rxBytes, txBytes };
}

async function getHostBandwidth(): Promise<{ rxBytesPerSec: number; txBytesPerSec: number }> {
  const first = await readNetDevTotals();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await readNetDevTotals();

  return {
    rxBytesPerSec: Math.max(0, (second.rxBytes - first.rxBytes) / 0.1),
    txBytesPerSec: Math.max(0, (second.txBytes - first.txBytes) / 0.1),
  };
}

async function getHostMemMb(): Promise<{ usedMb: number; totalMb: number }> {
  const text = await Bun.file("/proc/meminfo").text();
  const lines = Object.fromEntries(
    text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [key, value] = line.split(":") as [string, string];
        return [key.trim(), parseInt(value.trim(), 10)];
      })
  );

  const totalKb = lines["MemTotal"] ?? 0;
  const availableKb = lines["MemAvailable"] ?? 0;
  return {
    usedMb: Math.round((totalKb - availableKb) / 1024),
    totalMb: Math.round(totalKb / 1024),
  };
}

interface NvidiaSmiGpuRow {
  name: string;
  vram_used_mb: number;
  vram_total_mb: number;
  gpu_util_pct: number;
  mem_controller_util_pct: number;
  nvenc_avg_fps: number;
  nvenc_sessions: number;
  gpu_temp_c: number;
}

async function queryNvidiaSmiGpu(): Promise<NvidiaSmiGpuRow> {
  const output = await Bun.$`nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,utilization.memory,encoder.stats.averageFps,encoder.stats.sessionCount,temperature.gpu --format=csv,noheader,nounits`.text();

  const firstLine = output.trim().split("\n")[0] ?? "";
  const fields = firstLine.split(",").map((f) => f.trim());
  const [name = "", vramUsed, vramTotal, gpuUtil, memUtil, nvencFps, nvencSessions, temp] = fields;

  return {
    name,
    vram_used_mb: Number(vramUsed),
    vram_total_mb: Number(vramTotal),
    gpu_util_pct: Number(gpuUtil),
    mem_controller_util_pct: Number(memUtil),
    nvenc_avg_fps: Number(nvencFps) || 0,
    nvenc_sessions: Number(nvencSessions) || 0,
    gpu_temp_c: Number(temp),
  };
}

async function queryNvidiaSmiComputeApps(): Promise<Map<number, number>> {
  const output = await Bun.$`nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits`.text();

  const map = new Map<number, number>();
  for (const line of output.trim().split("\n")) {
    if (!line.trim()) continue;
    const [pidStr, vramStr] = line.split(",").map((f) => f.trim());
    const pid = Number(pidStr);
    const vram = Number(vramStr);
    if (!Number.isNaN(pid) && !Number.isNaN(vram)) map.set(pid, vram);
  }
  return map;
}

// Root filesystem usage the way df computes it: used / (used + available),
// with "available" being the non-root-reserved blocks.
async function getDiskUsedPct(): Promise<number | undefined> {
  try {
    const { statfs } = await import("node:fs/promises");
    const stats = await statfs("/");
    const used = stats.blocks - stats.bfree;
    const denominator = used + stats.bavail;
    if (denominator <= 0) return undefined;
    return (used / denominator) * 100;
  } catch {
    return undefined;
  }
}

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

export async function getAllMetrics(instances: Instance[]): Promise<MetricsPayload> {
  const runningInstances = instances.filter((i) => i.status === "running" && i.container_id);

  const [host, computeApps] = await Promise.all([getHostMetrics(), queryNvidiaSmiComputeApps()]);

  const nodeMemoryCache = new Map<string, number>();
  async function getNodeMemoryMb(nodeId: string): Promise<number> {
    const cached = nodeMemoryCache.get(nodeId);
    if (cached !== undefined) return cached;
    const node = await getNode(nodeId);
    nodeMemoryCache.set(nodeId, node.memory_mb);
    return node.memory_mb;
  }

  const containerMetricsList = await Promise.all(
    runningInstances.map(async (instance) => {
      const ramLimitMb = await getNodeMemoryMb(instance.node_id);
      try {
        const metrics = await getContainerMetrics(
          instance.container_id as string,
          computeApps,
          ramLimitMb
        );
        return [instance.id, metrics] as const;
      } catch {
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
