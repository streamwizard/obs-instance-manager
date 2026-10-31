// GPU, NVENC and per-process VRAM stats from nvidia-smi.

export interface NvidiaSmiGpuRow {
  name: string;
  vram_used_mb: number;
  vram_total_mb: number;
  gpu_util_pct: number;
  mem_controller_util_pct: number;
  nvenc_avg_fps: number;
  nvenc_sessions: number;
  gpu_temp_c: number;
  /** NVENC ASIC busy % — the saturation signal for a streaming box.
   *  utilization.gpu is time-occupancy and does NOT include the encoder. */
  encoder_util_pct?: number;
  power_draw_w?: number;
  sm_clock_mhz?: number;
}

/** Boards without a given sensor report "[N/A]"; that must become undefined,
 *  not NaN — NaN would poison the Influx line protocol downstream. */
function finiteOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Parses one CSV row from the --query-gpu call below;
 *  field order must match the query string exactly. */
export function parseNvidiaSmiGpuRow(line: string): NvidiaSmiGpuRow {
  const fields = line.split(",").map((f) => f.trim());
  const [name = "", vramUsed, vramTotal, gpuUtil, memUtil, nvencFps, nvencSessions, temp, encoderUtil, powerDraw, smClock] = fields;

  return {
    name,
    vram_used_mb: Number(vramUsed),
    vram_total_mb: Number(vramTotal),
    gpu_util_pct: Number(gpuUtil),
    mem_controller_util_pct: Number(memUtil),
    nvenc_avg_fps: Number(nvencFps) || 0,
    nvenc_sessions: Number(nvencSessions) || 0,
    gpu_temp_c: Number(temp),
    encoder_util_pct: finiteOrUndefined(encoderUtil),
    power_draw_w: finiteOrUndefined(powerDraw),
    sm_clock_mhz: finiteOrUndefined(smClock),
  };
}

export async function queryNvidiaSmiGpu(): Promise<NvidiaSmiGpuRow> {
  const output = await Bun.$`nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,utilization.memory,encoder.stats.averageFps,encoder.stats.sessionCount,temperature.gpu,utilization.encoder,power.draw,clocks.sm --format=csv,noheader,nounits`.text();

  return parseNvidiaSmiGpuRow(output.trim().split("\n")[0] ?? "");
}

export async function queryNvidiaSmiComputeApps(): Promise<Map<number, number>> {
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
