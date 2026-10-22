import { describe, expect, test } from "bun:test";
import { mapLimit } from "./concurrency";

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("mapLimit", () => {
  test("never runs more than limit at once", async () => {
    let active = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
    });
    expect(peak).toBe(3);
  });

  test("keeps input order", async () => {
    const out = await mapLimit([30, 10, 20], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 2;
    });
    expect(out).toEqual([60, 20, 40]);
  });

  test("propagates the first error", async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  test("handles empty input", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});
