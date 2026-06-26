import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { s3, S3_BUCKET } from "./s3";
import { debug, log } from "./logger";

const PLUGINS_PREFIX = "plugins/";
const ETAG_CACHE_FILE = ".etags.json";

// Shared between this module and docker.ts so both use the same local dir.
export const PLUGINS_LOCAL_DIR = process.env.PLUGINS_PATH ?? "/data/obs-plugins";

async function loadEtagCache(dir: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(join(dir, ETAG_CACHE_FILE), "utf8"));
  } catch {
    return {};
  }
}

// Syncs the plugins/ prefix from S3 to PLUGINS_LOCAL_DIR, skipping files
// whose ETag matches the local cache (i.e. already up to date). Called
// before every container create/start so nodes always run the latest plugins
// without needing manual file placement or an API restart.
export async function syncPlugins(): Promise<void> {
  await mkdir(PLUGINS_LOCAL_DIR, { recursive: true });

  let objects: { key: string; etag: string }[] = [];
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
      if (obj.Key && obj.ETag) objects.push({ key: obj.Key, etag: obj.ETag });
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  if (objects.length === 0) {
    debug("s3", "no plugins found in S3 under plugins/ prefix");
    return;
  }

  const etagCache = await loadEtagCache(PLUGINS_LOCAL_DIR);
  const baseResolved = resolve(PLUGINS_LOCAL_DIR) + sep;
  let downloaded = 0;

  await Promise.all(
    objects.map(async ({ key, etag }) => {
      const rel = key.slice(PLUGINS_PREFIX.length);
      if (!rel || rel.includes("\0")) return;
      const localPath = resolve(PLUGINS_LOCAL_DIR, rel);
      if (!localPath.startsWith(baseResolved)) {
        log("warn", "skipping plugin S3 key with path traversal", { key });
        return;
      }

      if (etagCache[key] === etag) {
        debug("s3", `plugin up to date: ${rel}`);
        return;
      }

      await mkdir(localPath.substring(0, localPath.lastIndexOf("/")), { recursive: true });
      const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      if (!res.Body) return;
      await Bun.write(localPath, await res.Body.transformToByteArray());
      etagCache[key] = etag;
      downloaded++;
    })
  );

  await writeFile(join(PLUGINS_LOCAL_DIR, ETAG_CACHE_FILE), JSON.stringify(etagCache, null, 2));

  log("info", "plugins synced from S3", { downloaded, total: objects.length });
}
