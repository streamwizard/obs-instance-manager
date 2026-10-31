import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { debug, log } from "@/utils/logger";
import { localConfigDir, PROFILE_NAME } from "./paths";

// Secrets written into the instance's local OBS config right before the
// container starts (and cleared after it stops). None of these files are
// pushed to S3 (see obs-sync-policy.ts).

function serviceJsonPath(instanceId: string): string {
  return join(localConfigDir(instanceId), "basic", "profiles", PROFILE_NAME, "service.json");
}

function obsWsConfigPath(instanceId: string): string {
  return join(localConfigDir(instanceId), "plugin_config", "obs-websocket", "config.json");
}

// Writes our generated password into the obs-websocket config.json after
// pullObsConfig runs. The entrypoint only seeds that file when it doesn't
// exist; if one is already there (template, or a leftover dir) with a
// different password the entrypoint would silently ignore
// OBS_WEBSOCKET_PASSWORD. Patching here ensures the password we stored in the
// DB is always the one OBS actually uses. The file is never pushed to S3
// (see obs-sync-policy.ts).
export async function injectObsWsPassword(instanceId: string, password: string): Promise<void> {
  const path = obsWsConfigPath(instanceId);
  await mkdir(path.substring(0, path.lastIndexOf("/")), { recursive: true });

  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await Bun.file(path).text());
  } catch {
    // no existing config — start fresh
  }

  cfg.server_enabled = true;
  cfg.auth_required = true;
  cfg.server_password = password;
  cfg.first_load = false;
  cfg.alerts_enabled = cfg.alerts_enabled ?? false;
  cfg.server_port = cfg.server_port ?? Number(process.env.OBS_WEBSOCKET_PORT ?? 4455);

  await Bun.write(path, JSON.stringify(cfg, null, 4));
  debug("obs-config", `obs-websocket password injected for instance ${instanceId}`);
}

// Writes the Twitch stream key into the instance's service.json so OBS starts
// with it pre-populated. Called after pullObsConfig so the file exists on disk.
// Non-fatal: if the file is missing or malformed we skip silently.
export async function injectStreamKey(instanceId: string, key: string): Promise<void> {
  const path = serviceJsonPath(instanceId);
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    log("warn", "service.json not found after config pull, skipping stream key injection", { instanceId });
    return;
  }

  let cfg: any;
  try {
    cfg = JSON.parse(raw);
  } catch {
    log("warn", "service.json is not valid JSON, skipping stream key injection", { instanceId });
    return;
  }

  cfg.settings ??= {};
  cfg.settings.key = key;

  await Bun.write(path, JSON.stringify(cfg, null, 4));
  debug("obs-config", `stream key injected into service.json for instance ${instanceId}`);
}

// Clears the stream key from service.json after a stop. service.json lives in
// basic/profiles/, which the sync policy never pushes, so this is defence in
// depth for the local dir that may outlive a failed push, not what keeps the
// key out of S3.
export async function clearStreamKey(instanceId: string): Promise<void> {
  const path = serviceJsonPath(instanceId);
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    return; // file may not exist if the container never wrote it back
  }

  let cfg: any;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return;
  }

  if (cfg.settings) cfg.settings.key = "";

  await Bun.write(path, JSON.stringify(cfg, null, 4));
  debug("obs-config", `stream key cleared from service.json for instance ${instanceId}`);
}
