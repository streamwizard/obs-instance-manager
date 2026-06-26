import { createBunWebSocket } from "hono/bun";

// Shared across every route file that upgrades a connection — Bun.serve
// only accepts one `websocket` dispatch handler, so every upgradeWebSocket()
// call in the app must come from this same instance.
export const { upgradeWebSocket, websocket } = createBunWebSocket();
