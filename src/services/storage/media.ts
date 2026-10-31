// User media file-manager for a running instance's /home/app/media mount.
//
// All operations are scoped to localMediaDir(instanceId) -- the same host dir
// that clients/docker.ts bind-mounts to /home/app/media and that obs-config/ syncs
// to S3. Each mutation syncs just its own key. This service only ever touches files
// while the instance is running (the caller guards on status); on stop the
// existing lifecycle pushes to S3 and removes the local dir.
//
// Every mutation runs under withInstanceLock so an upload/rename/delete can
// never interleave with a stop's final push + removeLocalConfig, which would
// otherwise write into (or read from) a half-deleted tree.
import { chown, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deleteObsMediaFile, localMediaDir, moveObsMediaFile, pushObsMediaFile } from "@/services/storage/obs-config";
import { updateInstance } from "@/clients/supabase";
import { withInstanceLock } from "@/utils/instance-lock";
import { OBS_MEDIA_MAX_FILE_BYTES } from "@/utils/constants";
import {
  contentMatchesExtension,
  extensionOf,
  isAllowedExtension,
  MEDIA_SNIFF_BYTES,
} from "@/utils/media-types";
import { debug, log } from "@/utils/logger";
import { MediaError } from "@/services/storage/media-error";
import { resolveSafe, toRel } from "@/services/storage/media-paths";

// OBS runs as uid/gid 1000 inside the container (obs-cloud-container Dockerfile).
// The manager process runs as root, so files it writes land root-owned; chown
// them so OBS can read them in the file picker. Best-effort: if the manager
// isn't root, world-readable default perms still let OBS read.
const OBS_UID = 1000;
const OBS_GID = 1000;

export interface MediaFile {
  path: string; // relative to the media root, forward-slashed
  size: number;
  modified: string; // ISO
}

export interface MediaListing {
  files: MediaFile[];
  used_bytes: number;
  quota_bytes: number;
}


// Recursively walks the media dir, returning real files only (lstat guards
// against a symlink planted by the container pointing at host files).
async function walk(base: string, dir: string, out: MediaFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // dir doesn't exist yet
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(base, full, out);
    } else if (entry.isFile()) {
      const st = await lstat(full);
      if (st.isFile()) {
        out.push({ path: toRel(base, full), size: st.size, modified: st.mtime.toISOString() });
      }
    }
  }
}

async function listFiles(base: string): Promise<MediaFile[]> {
  const files: MediaFile[] = [];
  await walk(base, base, files);
  return files;
}

function quotaBytes(instance: { storage_quota_mb: number }): number {
  return instance.storage_quota_mb * 1024 * 1024;
}

// Persists the freshly-computed usage back to the DB (best-effort) so the
// dashboard's storage bar is correct without the panel re-summing anything.
async function syncUsage(instanceId: string, usedBytes: number): Promise<void> {
  await updateInstance(instanceId, { used_storage_bytes: usedBytes }).catch((e) =>
    log("warn", "failed to persist used_storage_bytes", { instanceId, error: (e as Error).message }),
  );
}

export async function getListing(instance: {
  id: string;
  storage_quota_mb: number;
}): Promise<MediaListing> {
  const base = localMediaDir(instance.id);
  const files = await listFiles(base);
  const used = files.reduce((sum, f) => sum + f.size, 0);
  await syncUsage(instance.id, used);
  return { files, used_bytes: used, quota_bytes: quotaBytes(instance) };
}

// Streams an upload to disk under the media root, enforcing the per-file
// ceiling and the instance quota as bytes arrive (so an oversized or
// quota-busting upload is aborted mid-stream, not after buffering it all).
export async function uploadFile(
  instance: { id: string; user_id: string; storage_quota_mb: number },
  relPath: string,
  body: ReadableStream<Uint8Array>,
  declaredSize: number | null,
): Promise<MediaListing> {
  // Fast reject on extension before touching the stream. Content is verified
  // against the extension's magic bytes once the head arrives (below).
  const ext = extensionOf(relPath);
  if (!isAllowedExtension(ext)) {
    throw new MediaError("Unsupported file type", 400);
  }

  return withInstanceLock(instance.id, async () => {
    const base = localMediaDir(instance.id);
    const abs = await resolveSafe(base, relPath);

    const existing = await listFiles(base);
    const usedExcludingTarget = existing
      .filter((f) => f.path !== toRel(base, abs))
      .reduce((sum, f) => sum + f.size, 0);
    const quota = quotaBytes(instance);

    if (declaredSize !== null) {
      if (declaredSize > OBS_MEDIA_MAX_FILE_BYTES) {
        throw new MediaError("File exceeds the maximum allowed size", 413);
      }
      if (usedExcludingTarget + declaredSize > quota) {
        throw new MediaError("Upload would exceed the storage quota", 413);
      }
    }

    // Write to a random temp file in the destination's parent, then rename it
    // into place. rename() replaces whatever is at `abs` (including a symlink
    // the container may have raced onto it) rather than following it, and the
    // temp name is unguessable so it can't be pre-planted. resolveSafe already
    // verified the parent chain is symlink-free.
    const parent = dirname(abs);
    await mkdir(parent, { recursive: true });
    const tmp = join(parent, `.upload-${crypto.randomUUID()}.tmp`);

    const sink = Bun.file(tmp).writer();
    let written = 0;
    let sniffed = false;
    const headChunks: Uint8Array[] = [];
    let headLen = 0;

    // Verifies the buffered leading bytes match the claimed extension, once we
    // have enough of them. Throws before the file is committed so a disguised
    // non-media blob never gets renamed into place or pushed to S3.
    const verifyHead = () => {
      const size = Math.min(headLen, MEDIA_SNIFF_BYTES);
      const head = new Uint8Array(size);
      let off = 0;
      for (const c of headChunks) {
        if (off >= size) break;
        const take = c.subarray(0, size - off);
        head.set(take, off);
        off += take.byteLength;
      }
      if (!contentMatchesExtension(ext, head)) {
        throw new MediaError("File contents do not match its extension", 400);
      }
      sniffed = true;
    };

    try {
      const reader = body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        written += value.byteLength;
        if (written > OBS_MEDIA_MAX_FILE_BYTES) {
          throw new MediaError("File exceeds the maximum allowed size", 413);
        }
        if (usedExcludingTarget + written > quota) {
          throw new MediaError("Upload would exceed the storage quota", 413);
        }
        if (!sniffed) {
          headChunks.push(value);
          headLen += value.byteLength;
          if (headLen >= MEDIA_SNIFF_BYTES) verifyHead();
        }
        sink.write(value);
      }
      // Stream ended before MEDIA_SNIFF_BYTES (a tiny file) -- verify what we got.
      if (!sniffed) verifyHead();
      await sink.end();
      await rename(tmp, abs);
    } catch (err) {
      try {
        await sink.end();
      } catch {}
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }

    await chown(abs, OBS_UID, OBS_GID).catch((e) =>
      debug("media", `chown failed for ${abs}: ${(e as Error).message}`),
    );

    await pushObsMediaFile(instance.user_id, instance.id, toRel(base, abs)).catch((e) =>
      log("warn", "media push to S3 failed after upload", { instanceId: instance.id, error: (e as Error).message }),
    );

    log("info", "media file uploaded", { instanceId: instance.id, path: toRel(base, abs), bytes: written });
    return getListing(instance);
  });
}

// Renames a file within the media root. Returns scene_reference_warning: true
// because OBS scene collections store absolute /home/app/media/... paths -- a
// rename silently breaks any source pointing at the old name. We warn rather
// than rewrite scene JSON (fragile, and OBS may be holding the file open).
export async function renameFile(
  instance: { id: string; user_id: string },
  fromPath: string,
  toPath: string,
): Promise<{ scene_reference_warning: boolean }> {
  return withInstanceLock(instance.id, async () => {
    // Keep the media dir to allowlisted extensions -- a rename must not turn a
    // stored asset into e.g. a .exe/.html sitting in our S3.
    if (!isAllowedExtension(extensionOf(toPath))) {
      throw new MediaError("Unsupported file type", 400);
    }

    const base = localMediaDir(instance.id);
    const fromAbs = await resolveSafe(base, fromPath);
    const toAbs = await resolveSafe(base, toPath);

    const src = await lstat(fromAbs).catch(() => null);
    if (!src || !src.isFile()) throw new MediaError("File not found", 404);
    // lstat (not stat) so a symlink squatting on the target name is treated as
    // "exists" and rejected rather than followed.
    if (await lstat(toAbs).then(() => true).catch(() => false)) {
      throw new MediaError("A file with that name already exists", 409);
    }

    await mkdir(dirname(toAbs), { recursive: true });
    await rename(fromAbs, toAbs);

    // Move the S3 key too, so a restart's pull doesn't resurrect the
    // pre-rename file.
    await moveObsMediaFile(instance.user_id, instance.id, toRel(base, fromAbs), toRel(base, toAbs)).catch((e) =>
      log("warn", "S3 media move failed after rename", { instanceId: instance.id, error: (e as Error).message }),
    );

    log("info", "media file renamed", { instanceId: instance.id, from: fromPath, to: toPath });
    return { scene_reference_warning: true };
  });
}

export async function deleteFile(
  instance: { id: string; user_id: string; storage_quota_mb: number },
  relPath: string,
): Promise<MediaListing> {
  return withInstanceLock(instance.id, async () => {
    const base = localMediaDir(instance.id);
    const abs = await resolveSafe(base, relPath);

    const st = await lstat(abs).catch(() => null);
    if (!st || !st.isFile()) throw new MediaError("File not found", 404);

    const rel = toRel(base, abs);
    // resolveSafe guaranteed no symlink component, and lstat above confirmed the
    // target is a real file, so this rm cannot traverse a symlink out of base.
    await rm(abs, { force: true });

    // Delete the S3 key now rather than waiting for the next full push, so a
    // crash before then can't restore the file on the next start.
    await deleteObsMediaFile(instance.user_id, instance.id, rel).catch((e) =>
      log("warn", "S3 media key delete failed after delete", { instanceId: instance.id, error: (e as Error).message }),
    );

    log("info", "media file deleted", { instanceId: instance.id, path: relPath });
    return getListing(instance);
  });
}

// Resolves a single media file's absolute path for download/streaming back to
// the browser. Throws MediaError(404) if it isn't a real file.
export async function resolveDownload(
  instanceId: string,
  relPath: string,
): Promise<{ abs: string; name: string; size: number }> {
  const base = localMediaDir(instanceId);
  const abs = await resolveSafe(base, relPath);
  const st = await lstat(abs).catch(() => null);
  if (!st || !st.isFile()) throw new MediaError("File not found", 404);
  return { abs, name: abs.slice(abs.lastIndexOf("/") + 1), size: st.size };
}
