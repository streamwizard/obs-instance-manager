const CADVISOR_URL = process.env.CADVISOR_URL ?? "http://localhost:8080";

interface CadvisorCpuStats {
  usage: {
    total: number;
    per_cpu_usage?: number[];
  };
}

interface CadvisorMemoryStats {
  usage: number;
  working_set: number;
}

interface CadvisorStatsSample {
  timestamp: string;
  cpu: CadvisorCpuStats;
  memory: CadvisorMemoryStats;
}

interface CadvisorContainerInfo {
  stats: CadvisorStatsSample[];
}

export interface CadvisorCpuRam {
  cpu_pct: number;
  ram_used_mb: number;
}

export async function getContainerCpuRam(containerId: string): Promise<CadvisorCpuRam> {
  const res = await fetch(`${CADVISOR_URL}/api/v1.3/docker/${containerId}`);
  if (!res.ok) {
    throw new Error(`cAdvisor request failed for ${containerId}: ${res.status}`);
  }

  const body = (await res.json()) as Record<string, CadvisorContainerInfo>;
  const containerInfo = Object.values(body)[0];
  if (!containerInfo || containerInfo.stats.length < 2) {
    return { cpu_pct: 0, ram_used_mb: 0 };
  }

  const stats = containerInfo.stats;
  const prev = stats[stats.length - 2]!;
  const curr = stats[stats.length - 1]!;

  const cpuDeltaNs = curr.cpu.usage.total - prev.cpu.usage.total;
  const timeDeltaNs =
    (new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime()) * 1_000_000;

  const cpu_pct = timeDeltaNs > 0 ? Math.max(0, (cpuDeltaNs / timeDeltaNs) * 100) : 0;
  const ram_used_mb = Math.round(curr.memory.working_set / 1024 / 1024);

  return { cpu_pct, ram_used_mb };
}
