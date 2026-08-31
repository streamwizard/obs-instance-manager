import { test, expect } from "bun:test";
import { parseCpuset, pickLeastUsedCores } from "./cpuset";

test("parseCpuset expands ranges, lists and mixes", () => {
  expect(parseCpuset("0-3", 16)).toEqual([0, 1, 2, 3]);
  expect(parseCpuset("2,5,9", 16)).toEqual([2, 5, 9]);
  expect(parseCpuset("0-1,14-15", 16)).toEqual([0, 1, 14, 15]);
});

test("parseCpuset ignores empty, malformed and out-of-range cores", () => {
  expect(parseCpuset(undefined, 16)).toEqual([]);
  expect(parseCpuset("", 16)).toEqual([]);
  expect(parseCpuset("0-3,,x,-", 16)).toEqual([0, 1, 2, 3]);
  // A container pinned before a CPU was hot-unplugged must not index past the
  // usage array.
  expect(parseCpuset("6-9", 8)).toEqual([6, 7]);
});

test("pickLeastUsedCores takes the least-subscribed cores, ties by index", () => {
  expect(pickLeastUsedCores([0, 0, 0, 0], 2)).toEqual([0, 1]);
  expect(pickLeastUsedCores([2, 0, 1, 0], 2)).toEqual([1, 3]);
});

test("pickLeastUsedCores returns cores in ascending order", () => {
  expect(pickLeastUsedCores([3, 1, 3, 0, 2, 3], 3)).toEqual([1, 3, 4]);
});

test("two 4-core instances on a 16-core node land on disjoint windows", () => {
  const usage = new Array<number>(16).fill(0);
  const first = pickLeastUsedCores(usage, 4);
  for (const core of first) usage[core]!++;
  const second = pickLeastUsedCores(usage, 4);

  expect(first).toEqual([0, 1, 2, 3]);
  expect(second).toEqual([4, 5, 6, 7]);
  expect(first.some((c) => second.includes(c))).toBe(false);
});

test("a 5th 4-core instance overlaps rather than failing", () => {
  const usage = new Array<number>(16).fill(0);
  for (let i = 0; i < 4; i++) {
    for (const core of pickLeastUsedCores(usage, 4)) usage[core]!++;
  }
  // Every core is now taken exactly once, so the next window reuses the lowest.
  expect(usage.every((u) => u === 1)).toBe(true);
  expect(pickLeastUsedCores(usage, 4)).toEqual([0, 1, 2, 3]);
});
