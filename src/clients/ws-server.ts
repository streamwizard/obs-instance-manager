import { debug, log } from "../utils/logger";

// Lifecycle transitions we push to the owning user's browser clients via the
// main ws-server's /internal/broadcast fan-out. "starting"/"stopping" are
// transitional (fired at the leading edge so other devices show an honest
// "Starting…"/"Stopping…" instead of guessing at the socket drop); they map to
// no DB status. "deleted" is an action, not a DB status -- the row is removed on
// delete. Kept as a local literal (this repo is standalone and doesn't import
// @repo/types); the string contract must stay in sync with
// packages/types/src/overlay-ws.ts in the monorepo.
export type LifecycleAction = "starting" | "started" | "stopping" | "stopped" | "error" | "deleted";

const LIFECYCLE_EVENT_TYPE = "streamwizard.obs_instance_lifecycle";
// Emitted by services/obs-event-listener.ts for every program-scene change the
// container makes, whatever the source (auto-switcher, browser panel, the
// streamer clicking around in OBS over VNC, a hotkey, a transition). Same
// sync-with-@repo/types caveat as the lifecycle type above.
const SCENE_EVENT_TYPE = "streamwizard.obs_scene_changed";
const BROADCAST_TIMEOUT_MS = 3_000;

// Optional/skip-if-unset (like reportReconcile in docker.ts): read at module
// top without throwing so local dev and the test suite -- which don't set these
// -- never break on import. Normalize a ws(s):// value to http(s):// the same
// way the web app's config push does.
const rawUrl = process.env.WS_SERVER_URL;
const wsServerHttpBase = rawUrl
  ? rawUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:")
  : null;
const consumerSecret = process.env.CONSUMER_SECRET;

// Fire-and-forget: pushes a bot-shaped message to the owning user's ws-server
// room (and, via routeBotBroadcast, the consumer firehose). Never awaited and
// never throws into a caller -- a ws-server outage (or unset config) must not
// fail or slow a container start/stop/delete, nor kill a scene listener. The
// DB / OBS itself remains the source of truth; a dropped push just means a
// browser learns the new state on its next fetch instead of instantly.
function postBroadcast(userId: string, type: string, payload: Record<string, unknown>, meta: Record<string, unknown>): void {
  if (!wsServerHttpBase || !consumerSecret) {
    debug("ws-broadcast", `WS_SERVER_URL/CONSUMER_SECRET not set, skipping ${type} broadcast`);
    return;
  }

  fetch(`${wsServerHttpBase}/internal/broadcast`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${consumerSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ userId, type, payload }),
    signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS),
  }).catch((error) =>
    log("warn", `${type} broadcast failed`, {
      ...meta,
      error: (error as Error).message,
    })
  );
}

export function broadcastLifecycle(userId: string, instanceId: string, action: LifecycleAction): void {
  postBroadcast(
    userId,
    LIFECYCLE_EVENT_TYPE,
    { instanceId, action, at: new Date().toISOString() },
    { instanceId, action },
  );
}

// The instance's program scene actually changed (observed, not commanded).
// Callers dedupe on sceneUuid before calling -- OBS re-emits during transitions.
export function broadcastSceneChanged(
  userId: string,
  instanceId: string,
  sceneName: string,
  sceneUuid: string,
): void {
  postBroadcast(
    userId,
    SCENE_EVENT_TYPE,
    { instanceId, sceneName, sceneUuid, at: new Date().toISOString() },
    { instanceId, sceneName },
  );
}
