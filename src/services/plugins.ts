import { lstat, mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { log } from "../utils/logger";
import { mapLimit } from "../utils/concurrency";
import { S3_SYNC_CONCURRENCY } from "../utils/constants";
import { downloadToFile, listObjects } from "./s3-objects";

const PLUGINS_PREFIX = "plugins/";

// Shared between this module and docker.ts so both use the same local dir.
export const PLUGINS_LOCAL_DIR = process.env.PLUGINS_PATH ?? "/data/obs-plugins";

// Key -> ETag/size of what's on disk, so a sync only fetches changed objects.
// A dotfile at the top of the plugins dir: OBS only loads subdirectories.
const MANIFEST_PATH = join(PLUGINS_LOCAL_DIR, ".sync-manifest.json");

type PluginManifest = Record<string, { etag: string; size: number }>;

// Guards against two concurrent create/start requests both syncing at once —
// callers that arrive while a sync is in flight just await the same promise.
// Load-bearing for correctness: a second sync starting mid-download would
// race the first one's deletes and manifest write.
let inFlight: Promise<void> | null = null;

// Mirrors the plugins/ prefix from S3 to PLUGINS_LOCAL_DIR, so S3 is the single
// source of truth — plugins added to or removed from the bucket take effect on
// the next container create/start. Only changed objects are downloaded and
// only removed ones deleted; running containers bind-mount this dir, so
// unchanged plugins are never touched under them. If S3 is unreachable the
// listing throws before anything changes, and callers fall back to the
// existing local plugins.
export function syncPlugins(): Promise<void> {
  if (!inFlight) {
    inFlight = syncPluginsInternal().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function loadManifest(): Promise<PluginManifest> {
  try {
    return JSON.parse(await Bun.file(MANIFEST_PATH).text()) ?? {};
  } catch {
    return {};
  }
}

async function listLocalFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listLocalFiles(full)));
    else files.push(full);
  }
  return files;
}

// Removes dirs left empty by deletions, bottom-up, so OBS doesn't try to load
// a plugin dir with no binary in it. Never removes the root itself.
async function pruneEmptyDirs(dir: string, isRoot = true): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await pruneEmptyDirs(join(dir, entry.name), false);
  }
  if (!isRoot && (await readdir(dir)).length === 0) await rmdir(dir).catch(() => {});
}

async function syncPluginsInternal(): Promise<void> {
  await mkdir(PLUGINS_LOCAL_DIR, { recursive: true });

  const objects = (await listObjects(PLUGINS_PREFIX)).filter((o) => {
    const rel = o.key.slice(PLUGINS_PREFIX.length);
    return rel && !rel.endsWith("/") && !rel.includes("\0");
  });

  if (objects.length === 0) {
    // Same as before: an empty prefix means no plugins. Wipe the dir's contents
    // (not the dir itself — running containers bind-mount this exact inode;
    // replacing it would detach them).
    for (const entry of await readdir(PLUGINS_LOCAL_DIR)) {
      await rm(join(PLUGINS_LOCAL_DIR, entry), { recursive: true, force: true });
    }
    log("warn", "no plugins in S3 under plugins/ prefix — local plugins dir wiped empty");
    return;
  }

  const baseResolved = resolve(PLUGINS_LOCAL_DIR) + sep;
  const manifest = await loadManifest();
  const next: PluginManifest = {};
  const wanted = new Set<string>();

  // Delete local files the bucket no longer has (and anything untracked, e.g.
  // a half-written temp file from a crashed sync).
  const desired = new Set(objects.map((o) => resolve(PLUGINS_LOCAL_DIR, o.key.slice(PLUGINS_PREFIX.length))));
  let removed = 0;
  for (const file of await listLocalFiles(PLUGINS_LOCAL_DIR)) {
    if (file === MANIFEST_PATH || desired.has(resolve(file))) continue;
    await rm(file, { force: true });
    removed++;
  }
  await pruneEmptyDirs(PLUGINS_LOCAL_DIR);

  let downloaded = 0;
  await mapLimit(objects, S3_SYNC_CONCURRENCY, async (obj) => {
    const rel = obj.key.slice(PLUGINS_PREFIX.length);
    const localPath = resolve(PLUGINS_LOCAL_DIR, rel);
    if (!localPath.startsWith(baseResolved)) {
      log("warn", "skipping plugin S3 key with path traversal", { key: obj.key });
      return;
    }
    wanted.add(rel);

    const prev = manifest[rel];
    const st = await lstat(localPath).catch(() => null);
    if (prev && st?.isFile() && prev.etag === obj.etag && st.size === obj.size) {
      next[rel] = prev;
      return;
    }

    // downloadToFile renames a fresh file into place, so a running OBS that
    // has the old .so mapped keeps its inode instead of seeing it truncated.
    if (await downloadToFile(obj.key, localPath)) {
      next[rel] = { etag: obj.etag, size: obj.size };
      downloaded++;
    }
  });

  await Bun.write(MANIFEST_PATH, JSON.stringify(next));
  log("info", "plugins synced from S3", {
    downloaded,
    removed,
    unchanged: wanted.size - downloaded,
    total: objects.length,
  });
}
