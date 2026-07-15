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

interface CadvisorNetworkInterfaceStats {
  name: string;
  rx_bytes: number;
  tx_bytes: number;
}

interface CadvisorNetworkStats {
  interfaces?: CadvisorNetworkInterfaceStats[];
}

interface CadvisorStatsSample {
  timestamp: string;
  cpu: CadvisorCpuStats;
  memory: CadvisorMemoryStats;
  network?: CadvisorNetworkStats;
}

interface CadvisorContainerInfo {
  stats: CadvisorStatsSample[];
}

export interface CadvisorCpuRam {
  cpu_pct: number;
  ram_used_mb: number;
  rx_bytes_per_sec: number;
  tx_bytes_per_sec: number;
}

function sumNetworkBytes(network: CadvisorNetworkStats | undefined): { rx: number; tx: number } {
  const interfaces = network?.interfaces ?? [];
  return interfaces.reduce(
    (acc, iface) => ({ rx: acc.rx + iface.rx_bytes, tx: acc.tx + iface.tx_bytes }),
    { rx: 0, tx: 0 },
  );
}

export async function getContainerCpuRam(containerId: string): Promise<CadvisorCpuRam> {
  const res = await fetch(`${CADVISOR_URL}/api/v1.3/docker/${containerId}`);
  if (!res.ok) {
    throw new Error(`cAdvisor request failed for ${containerId}: ${res.status}`);
  }

  const body = (await res.json()) as Record<string, CadvisorContainerInfo>;
  const containerInfo = Object.values(body)[0];
  if (!containerInfo || containerInfo.stats.length < 2) {
    return { cpu_pct: 0, ram_used_mb: 0, rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 };
  }

  const stats = containerInfo.stats;
  const prev = stats[stats.length - 2]!;
  const curr = stats[stats.length - 1]!;

  const cpuDeltaNs = curr.cpu.usage.total - prev.cpu.usage.total;
  const timeDeltaMs = new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime();
  const timeDeltaNs = timeDeltaMs * 1_000_000;

  const cpu_pct = timeDeltaNs > 0 ? Math.max(0, (cpuDeltaNs / timeDeltaNs) * 100) : 0;
  const ram_used_mb = Math.round(curr.memory.working_set / 1024 / 1024);

  const prevNet = sumNetworkBytes(prev.network);
  const currNet = sumNetworkBytes(curr.network);
  const timeDeltaSec = timeDeltaMs / 1000;
  const rx_bytes_per_sec = timeDeltaSec > 0 ? Math.max(0, (currNet.rx - prevNet.rx) / timeDeltaSec) : 0;
  const tx_bytes_per_sec = timeDeltaSec > 0 ? Math.max(0, (currNet.tx - prevNet.tx) / timeDeltaSec) : 0;

  return { cpu_pct, ram_used_mb, rx_bytes_per_sec, tx_bytes_per_sec };
}
