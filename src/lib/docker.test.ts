import { describe, expect, test } from "bun:test";

// docker.ts transitively imports supabase.ts, which throws at module load
// if these aren't set -- stub them before the dynamic import below so this
// test file doesn't need a real Supabase project.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

const { parseShmSize, instanceTarget } = await import("./docker");

describe("parseShmSize", () => {
  test.each([
    ["512m", 512 * 1024 ** 2],
    ["1g", 1024 ** 3],
    ["64k", 64 * 1024],
    ["100", 100],
    ["2G", 2 * 1024 ** 3],
    ["256mb", 256 * 1024 ** 2],
  ])("parses %s as %d bytes", (input, expected) => {
    expect(parseShmSize(input)).toBe(expected);
  });

  test.each(["", "abc", "-1m", "1.5g"])("throws on invalid input %s", (input) => {
    expect(() => parseShmSize(input)).toThrow();
  });
});

describe("instanceTarget", () => {
  test("formats container name and port as a host:port string", () => {
    expect(instanceTarget("obs-instance-abc123", 6080)).toBe("obs-instance-abc123:6080");
  });
});
