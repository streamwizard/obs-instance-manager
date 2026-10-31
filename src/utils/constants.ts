// Shared between the user-facing /metrics/stream SSE endpoint and the
// admin /metrics/stream websocket so both poll cAdvisor/nvidia-smi on the
// same cadence.
export const STREAM_INTERVAL_MS = 3000;

export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

// Media uploads bypass MAX_REQUEST_BODY_BYTES (see middleware/body-limit.ts) -- real assets
// (video/audio) routinely exceed 10MB. These bound them instead: a per-file
// ceiling and a per-instance storage quota fallback used only when the
// instance row has no storage_quota_mb (should not happen post-migration).
export const OBS_MEDIA_MAX_FILE_BYTES = Number(process.env.OBS_MEDIA_MAX_FILE_BYTES) || 2 * 1024 * 1024 * 1024; // 2GB
export const OBS_MEDIA_QUOTA_MB_FALLBACK = Number(process.env.OBS_MEDIA_QUOTA_MB) || 500;

// S3 config push only otherwise happens on a clean /stop, /delete, or a
// die event -- a hard crash of the manager process or the host itself loses
// any config changes since the last one of those. This periodic push bounds
// that loss window for running instances.
export const CONFIG_AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000;

// How often the node stops running instances whose owner lost their Cloud OBS
// plan (services/plan-sweep.ts). web-admin stops them right away on a revoke;
// this catches a grant that simply expires, and any stop that didn't land.
export const PLAN_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Parallel S3 requests per sync (one instance's push/pull, or the plugin
// mirror), and how many instances one autosave pass pushes at once.
export const S3_SYNC_CONCURRENCY = 8;
export const AUTOSAVE_INSTANCE_CONCURRENCY = 2;

// Backstop cadence for services/obs/obs-event-listener.ts. The docker event stream
// attaches/detaches scene listeners live; this bounds how long a missed event
// (dropped stream, out-of-band status change) can leave an instance unwatched.
export const OBS_EVENT_RESYNC_INTERVAL_MS = 60 * 1000;

// Sequential delay between auto-restarts (boot reconcile, gpu-xserver
// recovery), so a node coming back after an outage doesn't slam the GPU/CPU
// with N simultaneous OBS launches.
export const RESTART_STAGGER_MS = 3000;
