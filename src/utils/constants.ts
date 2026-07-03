// Shared between the user-facing /metrics/stream SSE endpoint and the
// admin /metrics/stream websocket so both poll cAdvisor/nvidia-smi on the
// same cadence.
export const STREAM_INTERVAL_MS = 3000;

export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

// S3 config push only otherwise happens on a clean /stop, /delete, or a
// die event -- a hard crash of the manager process or the host itself loses
// any config changes since the last one of those. This periodic push bounds
// that loss window for running instances.
export const CONFIG_AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000;
