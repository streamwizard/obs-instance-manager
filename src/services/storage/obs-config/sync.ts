import { lstat, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { debug, log } from "@/utils/logger";
import { mapLimit } from "@/utils/concurrency";
import { S3_SYNC_CONCURRENCY } from "@/utils/constants";
import { deleteKeys, downloadToFile, uploadFile } from "@/services/storage/s3-objects";
import { hashFile, type ManifestEntry } from "./manifest";
import { pathExists } from "./paths";

// Generic engine that mirrors a local dir to an S3 prefix (and back), driven
// by the sync manifest. push.ts / pull.ts decide which dirs and prefixes.

// S3 rejects keys over 1024 bytes.
const MAX_KEY_BYTES = 1024;

// ── Local walk ──────────────────────────────────────────────────────────────

interface LocalFile {
  abs: string;
  rel: string; // "/"-separated, same shape as the S3 key suffix
  size: number;
  mtimeMs: number;
}

// Returns null when the dir doesn't exist, so a push after removeLocalConfig
// can't read "no files" as "user deleted everything". Any other read error
// throws for the same reason, instead of returning a partial listing.
async function walkFiles(base: string): Promise<LocalFile[] | null> {
  if (!(await pathExists(base))) return null;
  const files: LocalFile[] = [];

  const visit = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      // A subdir removed mid-walk is just gone; anything else is real.
      if (dir !== base && (e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(abs);
      } else if (entry.isFile()) {
        // lstat confirms the path is a real file, not a symlink — a container
        // could plant a symlink to exfiltrate arbitrary host files on push.
        const st = await lstat(abs).catch(() => null);
        if (!st?.isFile()) continue;
        files.push({ abs, rel: relative(base, abs).split(sep).join("/"), size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };

  await visit(base);
  return files;
}

// ── Upload (dir -> prefix) ──────────────────────────────────────────────────

export interface SyncStats {
  uploaded: number;
  deleted: number;
  skipped: number;
  bytes: number;
  failed: number;
}

interface SyncSectionOptions {
  localBase: string;
  prefix: string;
  entries: Record<string, ManifestEntry>;
  filter: (rel: string) => boolean;
  hashContent: boolean;
  deletes: boolean;
}

// Mirrors one local dir to one S3 prefix, touching only what changed since the
// manifest was last written. Entries are only updated for operations that
// succeeded, so failures are retried by the next push.
export async function syncSection(opts: SyncSectionOptions): Promise<SyncStats> {
  const stats: SyncStats = { uploaded: 0, deleted: 0, skipped: 0, bytes: 0, failed: 0 };
  const files = await walkFiles(opts.localBase);
  if (files === null) return stats;

  const { entries } = opts;
  const wanted = files.filter((f) => {
    if (!opts.filter(f.rel)) return false;
    // S3 rejects keys over 1024 bytes. Such a file would fail every push and
    // keep the instance on its leftover dir forever, so skip it instead.
    if (Buffer.byteLength(`${opts.prefix}${f.rel}`) > MAX_KEY_BYTES) {
      log("warn", "skipping file with a path too long for S3", { prefix: opts.prefix, path: f.rel.slice(0, 200) });
      return false;
    }
    return true;
  });

  await mapLimit(wanted, S3_SYNC_CONCURRENCY, async (f) => {
    const prev = entries[f.rel];
    if (prev && prev.size === f.size && prev.mtimeMs === f.mtimeMs) {
      stats.skipped++;
      return;
    }
    try {
      // OBS rewrites scene JSON on every save even when nothing changed, so a
      // new mtime alone isn't worth an upload -- compare content first.
      const hash = opts.hashContent ? await hashFile(f.abs) : "";
      if (prev && hash && prev.hash === hash) {
        entries[f.rel] = { ...prev, size: f.size, mtimeMs: f.mtimeMs };
        stats.skipped++;
        return;
      }
      await uploadFile(`${opts.prefix}${f.rel}`, f.abs, f.size);
      entries[f.rel] = { size: f.size, mtimeMs: f.mtimeMs, hash, source: "overlay" };
      stats.uploaded++;
      stats.bytes += f.size;
    } catch (e) {
      stats.failed++;
      debug("s3", `upload failed for ${opts.prefix}${f.rel}: ${(e as Error).message}`);
    }
  });

  if (!opts.deletes) return stats;

  // Anything tracked that's no longer present (or no longer passes the policy)
  // is removed from S3, so deleted scene collections don't come back.
  const present = new Set(wanted.map((f) => f.rel));
  const gone = Object.keys(entries).filter((rel) => !present.has(rel));
  const goneKeys: string[] = [];
  for (const rel of gone) {
    if (entries[rel]?.source === "template") delete entries[rel];
    else goneKeys.push(`${opts.prefix}${rel}`);
  }
  if (goneKeys.length > 0) {
    try {
      const deleted = await deleteKeys(goneKeys);
      for (const key of deleted) delete entries[key.slice(opts.prefix.length)];
      stats.deleted += deleted.length;
      stats.failed += goneKeys.length - deleted.length;
    } catch (e) {
      stats.failed += goneKeys.length;
      debug("s3", `batch delete failed under ${opts.prefix}: ${(e as Error).message}`);
    }
  }

  return stats;
}

// ── Download (prefix -> dir) ────────────────────────────────────────────────

interface DownloadRecord {
  entries: Record<string, ManifestEntry>;
  source: ManifestEntry["source"];
  hashContent: boolean;
  filter: (rel: string) => boolean;
}

export async function downloadPrefix(keys: string[], prefix: string, localBase: string, record: DownloadRecord): Promise<void> {
  const baseResolved = resolve(localBase) + sep;

  await mapLimit(keys, S3_SYNC_CONCURRENCY, async (key) => {
    const rel = key.slice(prefix.length);
    if (!rel || rel.includes("\0")) return;
    const localPath = resolve(localBase, rel);
    if (!localPath.startsWith(baseResolved)) {
      log("warn", "skipping S3 key with path traversal", { key });
      return;
    }
    if (!(await downloadToFile(key, localPath))) return;
    if (!record.filter(rel)) return;
    const st = await lstat(localPath);
    record.entries[rel] = {
      size: st.size,
      mtimeMs: st.mtimeMs,
      hash: record.hashContent ? await hashFile(localPath) : "",
      source: record.source,
    };
  });
}

// Keys under a user's prefix that the sync policy no longer keeps (logs,
// browser caches, legacy plugins/ and profile copies, the ws password file)
// are deleted while we have the listing anyway, so every instance's prefix
// cleans itself up on its next start.
export async function pruneKeys(keys: string[], instanceId: string, what: string): Promise<void> {
  if (keys.length === 0) return;
  try {
    const deleted = await deleteKeys(keys);
    log("info", `pruned unsynced ${what} keys from S3`, { instanceId, deleted: deleted.length, total: keys.length });
  } catch (e) {
    log("warn", `failed to prune unsynced ${what} keys from S3`, { instanceId, error: (e as Error).message });
  }
}

export function splitByPolicy(keys: string[], prefix: string, filter: (rel: string) => boolean) {
  const keep: string[] = [];
  const junk: string[] = [];
  for (const key of keys) (filter(key.slice(prefix.length)) ? keep : junk).push(key);
  return { keep, junk };
}
