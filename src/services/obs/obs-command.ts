import OBSWebSocket from "obs-websocket-js";
import { instanceTarget, OBS_WS_PORT_INTERNAL } from "../clients/docker";
import { decryptPassword } from "../utils/crypto";
import { debug, log } from "../utils/logger";
import type { Instance } from "../types";

// Only the requests the auto-switcher needs. Everything else is rejected
// even though the caller is trusted — the blast radius of a leaked service
// key stays "can switch scenes", not "can reconfigure OBS".
const ALLOWED_REQUESTS = new Set([
  "SetCurrentProgramScene",
  "GetCurrentProgramScene",
  "GetSceneList",
  "GetSceneItemList",
  "SetSceneItemEnabled",
  "GetStreamStatus",
  "StopStream",
]);

const CONNECT_TIMEOUT_MS = 5_000;

export interface ObsCommand {
  request: string;
  params?: Record<string, unknown>;
}

export interface ObsCommandResult {
  ok: boolean;
  response?: unknown;
  error?: string;
}

export class ObsCommandError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 409 | 502,
  ) {
    super(message);
  }
}

// One in-flight execution per instance: two rapid switch decisions must not
// race two obs-websocket handshakes against the same container. Later calls
// chain behind the earlier one regardless of its outcome.
const inFlight = new Map<string, Promise<unknown>>();

function serialize<T>(instanceId: string, task: () => Promise<T>): Promise<T> {
  const prev = inFlight.get(instanceId) ?? Promise.resolve();
  const run = prev.then(task, task);
  const guard = run.then(
    () => undefined,
    () => undefined,
  );
  inFlight.set(instanceId, guard);
  guard.then(() => {
    if (inFlight.get(instanceId) === guard) inFlight.delete(instanceId);
  });
  return run;
}

export function validateObsCommands(commands: unknown): ObsCommand[] {
  if (!Array.isArray(commands) || commands.length === 0 || commands.length > 10) {
    throw new ObsCommandError("commands must be a non-empty array (max 10)", 400);
  }
  return commands.map((cmd) => {
    if (typeof cmd?.request !== "string" || !ALLOWED_REQUESTS.has(cmd.request)) {
      throw new ObsCommandError(`request not allowed: ${String(cmd?.request)}`, 400);
    }
    if (cmd.params !== undefined && (typeof cmd.params !== "object" || cmd.params === null || Array.isArray(cmd.params))) {
      throw new ObsCommandError(`params must be an object on ${cmd.request}`, 400);
    }
    return { request: cmd.request, params: cmd.params as Record<string, unknown> | undefined };
  });
}

// Connect-per-call on purpose: switches are rare (a few per stream) and the
// handshake is <50ms on obs-net, while a pooled socket would need container
// restart/stop lifecycle handling for no measurable win. All commands in one
// batch ride a single connection so "switch scene + toggle warning source"
// stays atomic-ish.
export async function executeObsCommands(instance: Instance, commands: ObsCommand[]): Promise<ObsCommandResult[]> {
  if (instance.status !== "running") {
    throw new ObsCommandError(`Instance is not running (status: ${instance.status})`, 409);
  }
  if (!instance.obs_ws_password_ciphertext || !instance.obs_ws_password_iv || !instance.obs_ws_password_tag) {
    throw new ObsCommandError("Instance is missing OBS WebSocket password", 502);
  }

  const password = decryptPassword(
    instance.obs_ws_password_ciphertext,
    instance.obs_ws_password_iv,
    instance.obs_ws_password_tag,
  );
  const url = `ws://${instanceTarget(instance.container_name, OBS_WS_PORT_INTERNAL)}`;

  return serialize(instance.id, async () => {
    const obs = new OBSWebSocket();
    try {
      await Promise.race([
        obs.connect(url, password, { rpcVersion: 1 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("obs-websocket connect timeout")), CONNECT_TIMEOUT_MS)),
      ]);
    } catch (err) {
      throw new ObsCommandError(`obs-websocket connect failed: ${(err as Error).message}`, 502);
    }

    try {
      const results: ObsCommandResult[] = [];
      for (const cmd of commands) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const response = await obs.call(cmd.request as any, cmd.params as any);
          results.push({ ok: true, response: response ?? {} });
        } catch (err) {
          results.push({ ok: false, error: (err as Error).message });
        }
      }
      debug("obs-command", `executed ${commands.length} command(s) on ${instance.container_name}`);
      return results;
    } finally {
      await obs.disconnect().catch((err) => {
        log("warn", "obs-websocket disconnect failed", { instanceId: instance.id, error: (err as Error).message });
      });
    }
  });
}
