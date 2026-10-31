import { Point } from "@influxdata/influxdb-client";
import { pushPoint } from "@/clients/influx";

// Consumes the streamwizard-obs-stats plugin's `OutputStats` vendor event
// (see that repo's WEBSOCKET.md) and persists it to InfluxDB as `obs_output`.
// The events arrive on the always-on scene-listener socket
// (services/obs/obs-event-listener.ts), so they keep flowing with no browser,
// panel or VNC session open.

export const STATS_VENDOR_NAME = "streamwizard-stats";
export const OUTPUT_STATS_EVENT = "OutputStats";

// The plugin emits once a second. Writing every event would be 6x the rate of
// every other measurement in the bucket, so one point is written per window,
// matching the 10s metrics persistence tick (services/metrics/metrics-persist.ts).
export const OUTPUT_STATS_WRITE_INTERVAL_MS = 10_000;

// Only the fields this module reads. Every block and field is optional: the
// plugin omits a block (or part of one) when the handle behind it doesn't
// exist, e.g. the encoder fields only exist while streaming.
export interface OutputStatsEvent {
  streaming?: {
    active?: boolean;
    reconnecting?: boolean;
    kbps?: number;
    totalBytes?: number;
    droppedFrames?: number;
    totalFrames?: number;
    dropPercent?: number;
    congestion?: number;
    encodeSkippedFrames?: number;
    encodeTotalFrames?: number;
    encodeLagPercent?: number;
    videoEncoder?: { bitrate?: number };
  };
  recording?: { active?: boolean };
  render?: {
    activeFps?: number;
    targetFps?: number;
    avgFrameRenderMs?: number;
    totalFrames?: number;
    laggedFrames?: number;
    renderLagPercent?: number;
  };
  system?: { cpuPercent?: number; memoryRssBytes?: number };
}

export interface OutputStatsTarget {
  nodeId: string;
  instanceId: string;
  userId: string;
}

// Gauges that move every second (bitrate, congestion) would hide short
// spikes if only the last sample of a window were written, so the worst value
// seen in the window rides along. Reconnects are counted as false -> true
// transitions of `streaming.reconnecting`.
export interface OutputStatsWindow {
  latest: OutputStatsEvent;
  congestionMax?: number;
  kbpsMin?: number;
  reconnects: number;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

/** Builds the `obs_output` point for one window. Returns null when the event
 * carries no usable field at all (e.g. a malformed payload). Pure, for tests. */
export function outputStatsToPoint(target: OutputStatsTarget, window: OutputStatsWindow): Point | null {
  const { latest } = window;
  const point = new Point("obs_output")
    .tag("node_id", target.nodeId)
    .tag("instance_id", target.instanceId)
    .tag("user_id", target.userId);

  let fields = 0;
  const float = (name: string, v: unknown) => {
    if (isNum(v)) {
      point.floatField(name, v);
      fields++;
    }
  };
  const int = (name: string, v: unknown) => {
    if (isNum(v)) {
      point.intField(name, Math.trunc(v));
      fields++;
    }
  };
  const bool = (name: string, v: unknown) => {
    if (isBool(v)) {
      point.booleanField(name, v);
      fields++;
    }
  };

  const s = latest.streaming;
  if (s) {
    bool("streaming_active", s.active);
    // Only meaningful while a stream output exists; the plugin omits the rest
    // of the block otherwise.
    if (s.active) {
      bool("reconnecting", s.reconnecting);
      float("kbps", s.kbps);
      float("kbps_min", window.kbpsMin);
      int("total_bytes", s.totalBytes);
      // Cumulative counters: Flux derives per-window deltas with difference().
      int("dropped_frames", s.droppedFrames);
      int("total_frames", s.totalFrames);
      float("drop_pct", s.dropPercent);
      float("congestion", s.congestion);
      float("congestion_max", window.congestionMax);
      int("encode_skipped_frames", s.encodeSkippedFrames);
      int("encode_total_frames", s.encodeTotalFrames);
      float("encode_lag_pct", s.encodeLagPercent);
      int("video_bitrate_target_kbps", s.videoEncoder?.bitrate);
    }
  }
  if (s || window.reconnects > 0) int("reconnects", window.reconnects);

  bool("recording_active", latest.recording?.active);

  const r = latest.render;
  if (r) {
    float("render_active_fps", r.activeFps);
    float("render_target_fps", r.targetFps);
    float("render_avg_frame_ms", r.avgFrameRenderMs);
    int("render_total_frames", r.totalFrames);
    int("render_lagged_frames", r.laggedFrames);
    float("render_lag_pct", r.renderLagPercent);
  }

  float("obs_cpu_pct", latest.system?.cpuPercent);
  int("obs_memory_rss_bytes", latest.system?.memoryRssBytes);

  return fields > 0 ? point : null;
}

/** Per-instance window state: folds 1s events into one point per
 * OUTPUT_STATS_WRITE_INTERVAL_MS and writes it. One instance per listener
 * session; drop it when the session detaches. */
export class OutputStatsRecorder {
  private window: OutputStatsWindow | null = null;
  private windowStart = 0;
  private wasReconnecting = false;

  constructor(
    private readonly target: OutputStatsTarget,
    private readonly write: (point: Point) => void = pushPoint,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = OUTPUT_STATS_WRITE_INTERVAL_MS,
  ) {}

  record(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const event = raw as OutputStatsEvent;
    const t = this.now();

    if (!this.window) {
      this.window = { latest: event, reconnects: 0 };
      this.windowStart = t;
    }
    const w = this.window;
    w.latest = event;

    const s = event.streaming;
    const reconnecting = s?.active === true && s.reconnecting === true;
    if (reconnecting && !this.wasReconnecting) w.reconnects++;
    this.wasReconnecting = reconnecting;

    if (s?.active) {
      if (isNum(s.congestion)) w.congestionMax = Math.max(w.congestionMax ?? s.congestion, s.congestion);
      if (isNum(s.kbps)) w.kbpsMin = Math.min(w.kbpsMin ?? s.kbps, s.kbps);
    }

    if (t - this.windowStart >= this.intervalMs) this.flush();
  }

  /** Writes the current window (if any) and starts a new one. */
  flush(): void {
    if (!this.window) return;
    const point = outputStatsToPoint(this.target, this.window);
    this.window = null;
    if (point) this.write(point);
  }
}
