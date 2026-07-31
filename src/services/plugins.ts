import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { s3, S3_BUCKET } from "../clients/s3";
import { log } from "../utils/logger";

const PLUGINS_PREFIX = "plugins/";

// Shared between this module and docker.ts so both use the same local dir.
export const PLUGINS_LOCAL_DIR = process.env.PLUGINS_PATH ?? "/data/obs-plugins";

// Guards against two concurrent create/start requests both wiping+downloading
// at once — callers that arrive while a sync is in flight just await the same
// promise. Load-bearing for correctness: a second sync starting mid-download
// would wipe files the first one just wrote.
let inFlight: Promise<void> | null = null;

// Mirrors the plugins/ prefix from S3 to PLUGINS_LOCAL_DIR: wipes the local
// dir and re-downloads everything, so S3 is the single source of truth —
// plugins added to or removed from the bucket take effect on the next
// container create/start. If S3 is unreachable the listing throws before
// anything is wiped, and callers fall back to the existing local plugins.
export function syncPlugins(): Promise<void> {
  if (!inFlight) {
    inFlight = syncPluginsInternal().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function syncPluginsInternal(): Promise<void> {
  await mkdir(PLUGINS_LOCAL_DIR, { recursive: true });

  let objects: string[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: PLUGINS_PREFIX,
        ContinuationToken: continuationToken,
      })
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) objects.push(obj.Key);
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  // Wipe the dir's contents (not the dir itself — running containers
  // bind-mount this exact inode; replacing it would detach them).
  for (const entry of await readdir(PLUGINS_LOCAL_DIR)) {
    await rm(join(PLUGINS_LOCAL_DIR, entry), { recursive: true, force: true });
  }

  if (objects.length === 0) {
    log("warn", "no plugins in S3 under plugins/ prefix — local plugins dir wiped empty");
    return;
  }

  const baseResolved = resolve(PLUGINS_LOCAL_DIR) + sep;
  let downloaded = 0;

  await Promise.all(
    objects.map(async (key) => {
      const rel = key.slice(PLUGINS_PREFIX.length);
      if (!rel || rel.includes("\0")) return;
      const localPath = resolve(PLUGINS_LOCAL_DIR, rel);
      if (!localPath.startsWith(baseResolved)) {
        log("warn", "skipping plugin S3 key with path traversal", { key });
        return;
      }

      await mkdir(localPath.substring(0, localPath.lastIndexOf("/")), { recursive: true });
      const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      if (!res.Body) return;
      await Bun.write(localPath, await res.Body.transformToByteArray());
      downloaded++;
    })
  );

  log("info", "plugins synced from S3", { downloaded, total: objects.length });
}
