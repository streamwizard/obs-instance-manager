import { afterEach, describe, expect, test } from "bun:test";
import { getContainerCpuRam } from "./cadvisor";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(body: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("getContainerCpuRam", () => {
  test("returns zeroed metrics when fewer than two samples are available", async () => {
    mockFetch({ abc123: { stats: [{ timestamp: new Date().toISOString(), cpu: { usage: { total: 0 } }, memory: { usage: 0, working_set: 0 } }] } });
    const result = await getContainerCpuRam("abc123");
    expect(result).toEqual({ cpu_pct: 0, ram_used_mb: 0 });
  });

  test("computes cpu percent and ram from consecutive samples", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const t1 = new Date("2026-01-01T00:00:01.000Z"); // 1s later
    mockFetch({
      abc123: {
        stats: [
          { timestamp: t0.toISOString(), cpu: { usage: { total: 0 } }, memory: { usage: 0, working_set: 0 } },
          {
            timestamp: t1.toISOString(),
            cpu: { usage: { total: 500_000_000 } }, // 0.5s of CPU time used in 1s wall time => 50%
            memory: { usage: 0, working_set: 100 * 1024 * 1024 },
          },
        ],
      },
    });

    const result = await getContainerCpuRam("abc123");
    expect(result.cpu_pct).toBeCloseTo(50, 0);
    expect(result.ram_used_mb).toBe(100);
  });

  test("throws when the cAdvisor request fails", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(getContainerCpuRam("abc123")).rejects.toThrow();
  });
});
