// Shared between the user-facing /metrics/stream SSE endpoint and the
// admin /metrics/stream websocket so both poll cAdvisor/nvidia-smi on the
// same cadence.
export const STREAM_INTERVAL_MS = 3000;

export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

// Media uploads bypass MAX_REQUEST_BODY_BYTES (see index.ts) -- real assets
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
