import { test, expect } from "bun:test";

// Import-time env requirements of the transitive module graph
// (s3/crypto/node clients validate on import).
process.env.S3_ENDPOINT ??= "http://127.0.0.1:1";
process.env.S3_ACCESS_KEY ??= "test";
process.env.S3_SECRET_KEY ??= "test";
process.env.TOKEN_ENCRYPTION_KEY ??= "0".repeat(64);
process.env.NODE_ID ??= "test-node";
process.env.REST_API_URL ??= "http://127.0.0.1:1";
process.env.NODE_API_KEY ??= "test";

const { parseNvidiaSmiGpuRow } = await import("./metrics");

// Field order: name, memory.used, memory.total, utilization.gpu,
// utilization.memory, encoder.stats.averageFps, encoder.stats.sessionCount,
// temperature.gpu, utilization.encoder, power.draw, clocks.sm

test("parses a full row from a board with all sensors", () => {
  const row = parseNvidiaSmiGpuRow("NVIDIA GeForce RTX 4060, 2961, 8192, 23, 5, 30, 1, 47, 38, 95.53, 2475");

  expect(row.name).toBe("NVIDIA GeForce RTX 4060");
  expect(row.vram_used_mb).toBe(2961);
  expect(row.vram_total_mb).toBe(8192);
  expect(row.gpu_util_pct).toBe(23);
  expect(row.mem_controller_util_pct).toBe(5);
  expect(row.nvenc_avg_fps).toBe(30);
  expect(row.nvenc_sessions).toBe(1);
  expect(row.gpu_temp_c).toBe(47);
  expect(row.encoder_util_pct).toBe(38);
  expect(row.power_draw_w).toBe(95.53);
  expect(row.sm_clock_mhz).toBe(2475);
});

test("[N/A] sensors become undefined, never NaN", () => {
  const row = parseNvidiaSmiGpuRow("Quadro P400, 100, 2048, 10, 2, 0, 0, 40, [N/A], [N/A], [N/A]");

  expect(row.gpu_util_pct).toBe(10);
  expect(row.encoder_util_pct).toBeUndefined();
  expect(row.power_draw_w).toBeUndefined();
  expect(row.sm_clock_mhz).toBeUndefined();
});

test("short row from an older query string leaves new fields undefined", () => {
  const row = parseNvidiaSmiGpuRow("NVIDIA GeForce RTX 4060, 2961, 8192, 23, 5, 0, 0, 47");

  expect(row.gpu_temp_c).toBe(47);
  expect(row.encoder_util_pct).toBeUndefined();
  expect(row.power_draw_w).toBeUndefined();
  expect(row.sm_clock_mhz).toBeUndefined();
});
