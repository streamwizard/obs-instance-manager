import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { s3, S3_BUCKET } from "../clients/s3";
import { debug, log } from "../utils/logger";

const PROFILE_NAME = "StreamWizard";

const CONFIG_BASE = process.env.OBS_CONFIG_BASE ?? "/data/obs-configs";
const TEMPLATES_BASE = process.env.OBS_TEMPLATES_PREFIX ?? "obs-templates/";
const DEFAULT_TEMPLATE = process.env.OBS_DEFAULT_TEMPLATE ?? "default";

function templatePrefix(template: string): string {
  return `${TEMPLATES_BASE}${template}/`;
}

function localConfigDir(instanceId: string): string {
  return join(CONFIG_BASE, instanceId, "obs-studio");
}

function s3Prefix(userId: string, instanceId: string): string {
  return `obs-configs/${userId}/${instanceId}/`;
}

async function listLocalFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await listLocalFiles(fullPath)));
      } else if (entry.isFile()) {
        // lstat confirms the path is a real file, not a symlink — a container
        // could plant a symlink to exfiltrate arbitrary host files on push.
        const st = await lstat(fullPath);
        if (st.isFile()) files.push(fullPath);
      }
    }
  } catch {
    // dir doesn't exist — nothing to push
  }
  return files;
}

async function listS3Objects(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  return keys;
}

async function downloadPrefix(prefix: string, localBase: string): Promise<void> {
  const keys = await listS3Objects(prefix);
  if (keys.length === 0) return;

  const baseResolved = resolve(localBase) + sep;

  await Promise.all(
    keys.map(async (key) => {
      const rel = key.slice(prefix.length);
      if (!rel || rel.includes("\0")) return;
      const localPath = resolve(localBase, rel);
      if (!localPath.startsWith(baseResolved)) {
        log("warn", "skipping S3 key with path traversal", { key });
        return;
      }
      await mkdir(localPath.substring(0, localPath.lastIndexOf("/")), { recursive: true });
      const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      if (!res.Body) return;
      await Bun.write(localPath, await res.Body.transformToByteArray());
    })
  );
}

// Downloads the user's OBS config from S3 into the instance's local bind-mount
// directory. Always applies the named template as a base layer first so shared
// assets (plugins, default scenes, etc.) reach every instance automatically.
// The instance's own config is then overlaid on top, so user changes always win.
export async function pullObsConfig(userId: string, instanceId: string, template = DEFAULT_TEMPLATE): Promise<void> {
  const localBase = localConfigDir(instanceId);
  await mkdir(localBase, { recursive: true });

  // Always apply the template as a base layer (plugins, default config, etc.)
  const tPrefix = templatePrefix(template);
  const templateKeys = await listS3Objects(tPrefix);
  if (templateKeys.length > 0) {
    await downloadPrefix(tPrefix, localBase);
    debug("s3", `applied template "${template}" (${templateKeys.length} files) for instance ${instanceId}`);
  }

  // Overlay the instance's own config on top (user changes win over template)
  const prefix = s3Prefix(userId, instanceId);
  const keys = await listS3Objects(prefix);
  if (keys.length > 0) {
    await downloadPrefix(prefix, localBase);
    log("info", "obs config pulled from S3", { userId, instanceId, template, templateFiles: templateKeys.length, instanceFiles: keys.length });
  } else {
    log("info", "no instance config in S3, started from template", { userId, instanceId, template, templateFiles: templateKeys.length });
  }
}

// Uploads the instance's local OBS config to S3 under the user's key so it
// can be restored on any node. Called after the container is stopped so the
// files are fully flushed before we read them.
export async function pushObsConfig(userId: string, instanceId: string): Promise<void> {
  const localBase = localConfigDir(instanceId);
  const prefix = s3Prefix(userId, instanceId);

  const files = await listLocalFiles(localBase);

  if (files.length === 0) {
    debug("s3", `no local config to push for instance ${instanceId}`);
    return;
  }

  debug("s3", `pushing ${files.length} config file(s) for user ${userId}`);

  await Promise.all(
    files.map(async (filePath) => {
      const key = `${prefix}${relative(localBase, filePath)}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: new Uint8Array(await Bun.file(filePath).arrayBuffer()),
        })
      );
    })
  );

  log("info", "obs config pushed to S3", { userId, instanceId, files: files.length });
}

export async function removeLocalConfig(instanceId: string): Promise<void> {
  await rm(join(CONFIG_BASE, instanceId), { recursive: true, force: true });
  debug("s3", `removed local config dir for instance ${instanceId}`);
}

function serviceJsonPath(instanceId: string): string {
  return join(localConfigDir(instanceId), "basic", "profiles", PROFILE_NAME, "service.json");
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

// Clears the stream key from service.json before pushing config to S3 so the
// key is never persisted to storage.
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

export async function removeS3Config(userId: string, instanceId: string): Promise<void> {
  const prefix = s3Prefix(userId, instanceId);
  const keys = await listS3Objects(prefix);
  if (keys.length === 0) {
    debug("s3", `no S3 config to remove for instance ${instanceId}`);
    return;
  }

  await Promise.all(
    keys.map((Key) => s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key })))
  );

  log("info", "obs config removed from S3", { userId, instanceId, files: keys.length });
}
