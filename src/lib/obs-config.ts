import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { s3, S3_BUCKET } from "./s3";
import { debug, log } from "./logger";

const CONFIG_BASE = process.env.OBS_CONFIG_BASE ?? "/data/obs-configs";

function localConfigDir(instanceId: string): string {
  return join(CONFIG_BASE, instanceId, "obs-studio");
}

function s3Prefix(userId: string): string {
  return `obs-configs/${userId}/`;
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

// Downloads the user's OBS config from S3 into the instance's local bind-mount
// directory. If no config exists yet (new user) the directory is created empty
// so Docker's bind mount has somewhere to write.
export async function pullObsConfig(userId: string, instanceId: string): Promise<void> {
  const localBase = localConfigDir(instanceId);
  const prefix = s3Prefix(userId);

  const keys = await listS3Objects(prefix);

  if (keys.length === 0) {
    debug("s3", `no config in S3 for user ${userId}, starting fresh`);
    await mkdir(localBase, { recursive: true });
    return;
  }

  debug("s3", `pulling ${keys.length} config file(s) for user ${userId}`);

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

  log("info", "obs config pulled from S3", { userId, instanceId, files: keys.length });
}

// Uploads the instance's local OBS config to S3 under the user's key so it
// can be restored on any node. Called after the container is stopped so the
// files are fully flushed before we read them.
export async function pushObsConfig(userId: string, instanceId: string): Promise<void> {
  const localBase = localConfigDir(instanceId);
  const prefix = s3Prefix(userId);

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
  const localBase = localConfigDir(instanceId);
  await rm(localBase, { recursive: true, force: true });
  debug("s3", `removed local config dir for instance ${instanceId}`);
}
