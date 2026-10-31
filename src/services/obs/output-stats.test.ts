import { test, expect, describe } from "bun:test";
import type { Point } from "@influxdata/influxdb-client";
import { OutputStatsRecorder, outputStatsToPoint, type OutputStatsEvent } from "./output-stats";

const target = { nodeId: "node-1", instanceId: "inst-1", userId: "user-1" };

// Shape copied from streamwizard-obs-stats-plugin's WEBSOCKET.md example.
function streamingEvent(overrides: Partial<NonNullable<OutputStatsEvent["streaming"]>> = {}): OutputStatsEvent {
  return {
    streaming: {
      active: true,
      reconnecting: false,
      kbps: 5980.4,
      totalBytes: 734003200,
      droppedFrames: 12,
      totalFrames: 54000,
      dropPercent: 0.022,
      congestion: 0.04,
      encodeSkippedFrames: 3,
      encodeTotalFrames: 54010,
      encodeLagPercent: 0.0056,
      videoEncoder: { bitrate: 6000 },
      ...overrides,
    },
    recording: { active: false },
    render: {
      activeFps: 60,
      targetFps: 60,
      avgFrameRenderMs: 2.1,
      totalFrames: 120345,
      laggedFrames: 4,
      renderLagPercent: 0.0033,
    },
    system: { cpuPercent: 18.7, memoryRssBytes: 612368384 },
  };
}

// Parses a line-protocol line into { tags, fields } for readable assertions.
function parse(point: Point) {
  const line = point.toLineProtocol();
  if (!line) throw new Error("point has no line protocol");
  const [head, fieldPart] = line.split(" ");
  const [measurement, ...tagPairs] = head!.split(",");
  const tags = Object.fromEntries(tagPairs.map((p) => p.split("=")));
  const fields = Object.fromEntries(fieldPart!.split(",").map((p) => p.split("=")));
  return { measurement, tags, fields };
}

describe("outputStatsToPoint", () => {
  test("maps a live-stream event to obs_output fields", () => {
    const point = outputStatsToPoint(target, { latest: streamingEvent(), congestionMax: 0.3, kbpsMin: 4200, reconnects: 1 });
    const { measurement, tags, fields } = parse(point!);

    expect(measurement).toBe("obs_output");
    expect(tags).toEqual({ instance_id: "inst-1", node_id: "node-1", user_id: "user-1" });
    expect(fields).toMatchObject({
      streaming_active: "T",
      reconnecting: "F",
      kbps: "5980.4",
      kbps_min: "4200",
      dropped_frames: "12i",
      total_frames: "54000i",
      drop_pct: "0.022",
      congestion: "0.04",
      congestion_max: "0.3",
      encode_skipped_frames: "3i",
      encode_lag_pct: "0.0056",
      video_bitrate_target_kbps: "6000i",
      reconnects: "1i",
      recording_active: "F",
      render_active_fps: "60",
      render_lagged_frames: "4i",
      obs_cpu_pct: "18.7",
      obs_memory_rss_bytes: "612368384i",
    });
  });

  test("offline: writes streaming_active=false and render/system fields, no stream counters", () => {
    const event: OutputStatsEvent = { ...streamingEvent(), streaming: { active: false } };
    const { fields } = parse(outputStatsToPoint(target, { latest: event, reconnects: 0 })!);

    expect(fields.streaming_active).toBe("F");
    expect(fields.reconnects).toBe("0i");
    expect(fields.render_active_fps).toBe("60");
    for (const key of ["kbps", "dropped_frames", "congestion", "reconnecting"]) {
      expect(fields[key]).toBeUndefined();
    }
  });

  test("skips missing and non-numeric fields instead of writing NaN", () => {
    const event = { render: { activeFps: "60", targetFps: Number.NaN, avgFrameRenderMs: 3 } } as unknown as OutputStatsEvent;
    const { fields } = parse(outputStatsToPoint(target, { latest: event, reconnects: 0 })!);

    expect(fields).toEqual({ render_avg_frame_ms: "3" });
  });

  test("returns null when the event has no usable field", () => {
    expect(outputStatsToPoint(target, { latest: {}, reconnects: 0 })).toBeNull();
  });
});

describe("OutputStatsRecorder", () => {
  function setup() {
    let clock = 0;
    const written: Point[] = [];
    const recorder = new OutputStatsRecorder(target, (p) => written.push(p), () => clock, 10_000);
    const tick = (event: unknown) => {
      recorder.record(event);
      clock += 1000;
    };
    return { recorder, written, tick };
  }

  test("writes one point per 10s window of 1s events", () => {
    const { written, tick } = setup();
    for (let i = 0; i < 25; i++) tick(streamingEvent());
    // Windows close at t=10s and t=20s; t=20..24 is still open.
    expect(written).toHaveLength(2);
  });

  test("carries the worst congestion and lowest bitrate of the window, not just the last sample", () => {
    const { recorder, written, tick } = setup();
    tick(streamingEvent({ congestion: 0.1, kbps: 6000 }));
    tick(streamingEvent({ congestion: 0.9, kbps: 1200 }));
    tick(streamingEvent({ congestion: 0.05, kbps: 5900 }));
    recorder.flush();

    const { fields } = parse(written[0]!);
    expect(fields.congestion).toBe("0.05");
    expect(fields.congestion_max).toBe("0.9");
    expect(fields.kbps).toBe("5900");
    expect(fields.kbps_min).toBe("1200");
  });

  test("counts each reconnect once (false -> true transitions)", () => {
    const { recorder, written, tick } = setup();
    for (const reconnecting of [false, true, true, false, true, false]) tick(streamingEvent({ reconnecting }));
    recorder.flush();

    expect(parse(written[0]!).fields.reconnects).toBe("2i");
  });

  test("a reconnect that spans a window boundary is not counted twice", () => {
    const { recorder, written, tick } = setup();
    for (let i = 0; i < 9; i++) tick(streamingEvent());
    tick(streamingEvent({ reconnecting: true })); // t=9s, window closes on the next tick
    tick(streamingEvent({ reconnecting: true })); // t=10s: flushes window 1
    tick(streamingEvent({ reconnecting: true }));
    recorder.flush();

    expect(parse(written[0]!).fields.reconnects).toBe("1i");
    expect(parse(written[1]!).fields.reconnects).toBe("0i");
  });

  test("ignores non-object payloads", () => {
    const { recorder, written, tick } = setup();
    tick(null);
    tick("garbage");
    recorder.flush();
    expect(written).toHaveLength(0);
  });

  test("flush with no events writes nothing", () => {
    const { recorder, written } = setup();
    recorder.flush();
    expect(written).toHaveLength(0);
  });
});
