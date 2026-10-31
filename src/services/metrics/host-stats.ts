// Host-level CPU, RAM, network and disk sampled from /proc and statfs.

async function readProcStatCpuLine(): Promise<{ idle: number; total: number }> {
  const text = await Bun.file("/proc/stat").text();
  const cpuLine = text.split("\n").find((line) => line.startsWith("cpu "));
  if (!cpuLine) throw new Error("Could not read cpu line from /proc/stat");

  const parts = cpuLine.trim().split(/\s+/).slice(1).map(Number);
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = parts;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { idle: idle + iowait, total };
}

export async function getHostCpuPercent(): Promise<number> {
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

export async function getHostBandwidth(): Promise<{ rxBytesPerSec: number; txBytesPerSec: number }> {
  const first = await readNetDevTotals();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await readNetDevTotals();

  return {
    rxBytesPerSec: Math.max(0, (second.rxBytes - first.rxBytes) / 0.1),
    txBytesPerSec: Math.max(0, (second.txBytes - first.txBytes) / 0.1),
  };
}

export async function getHostMemMb(): Promise<{ usedMb: number; totalMb: number }> {
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

// Root filesystem usage the way df computes it: used / (used + available),
// with "available" being the non-root-reserved blocks.
export async function getDiskUsedPct(): Promise<number | undefined> {
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
