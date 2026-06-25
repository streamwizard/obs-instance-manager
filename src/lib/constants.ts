// Shared between the user-facing /metrics/stream SSE endpoint and the
// admin /metrics/stream websocket so both poll cAdvisor/nvidia-smi on the
// same cadence.
export const STREAM_INTERVAL_MS = 3000;

export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
