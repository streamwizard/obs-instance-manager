import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { debug } from "@/utils/logger";
import { isSyncedMediaPath } from "@/services/storage/obs-sync-policy";
import { copyObject, deleteKeys, uploadFile } from "@/services/storage/s3-objects";
import { loadManifest, saveManifest, type SyncManifest } from "./manifest";
import { localMediaDir, s3MediaPrefix } from "./paths";

// ── Single media files (file-manager routes) ────────────────────────────────
// The media routes change one file at a time under the instance lock, so they
// sync just that key instead of the whole dir.

async function trackMediaFile(manifest: SyncManifest, instanceId: string, relPath: string): Promise<void> {
  const st = await lstat(join(localMediaDir(instanceId), relPath));
  manifest.media[relPath] = { size: st.size, mtimeMs: st.mtimeMs, hash: "", source: "overlay" };
}

export async function pushObsMediaFile(userId: string, instanceId: string, relPath: string): Promise<void> {
  if (!isSyncedMediaPath(relPath)) return;
  const abs = join(localMediaDir(instanceId), relPath);
  const st = await lstat(abs);
  if (!st.isFile()) return;

  await uploadFile(`${s3MediaPrefix(userId, instanceId)}${relPath}`, abs, st.size);
  const manifest = await loadManifest(instanceId);
  await trackMediaFile(manifest, instanceId, relPath);
  await saveManifest(instanceId, manifest);
  debug("s3", `pushed media object ${relPath} for instance ${instanceId}`);
}

// Server-side copy to the new key (falling back to an upload if the old key
// isn't in S3 yet), then drop the old key so a restart doesn't resurrect the
// pre-rename file. If this fails midway the manifest still tracks the old
// name, so the next full push uploads the new one and deletes the old one.
export async function moveObsMediaFile(userId: string, instanceId: string, fromRel: string, toRel: string): Promise<void> {
  const prefix = s3MediaPrefix(userId, instanceId);
  const abs = join(localMediaDir(instanceId), toRel);

  try {
    await copyObject(`${prefix}${fromRel}`, `${prefix}${toRel}`);
  } catch (e) {
    debug("s3", `copy failed for ${prefix}${fromRel}, uploading instead: ${(e as Error).message}`);
    await uploadFile(`${prefix}${toRel}`, abs, (await lstat(abs)).size);
  }
  await deleteKeys([`${prefix}${fromRel}`]);

  const manifest = await loadManifest(instanceId);
  delete manifest.media[fromRel];
  await trackMediaFile(manifest, instanceId, toRel);
  await saveManifest(instanceId, manifest);
  debug("s3", `moved media object ${fromRel} -> ${toRel} for instance ${instanceId}`);
}

// Deletes a single media object from S3 by its path relative to the media root.
// The manifest entry is only dropped once S3 confirms, so a failed delete is
// retried by the next full push.
export async function deleteObsMediaFile(userId: string, instanceId: string, relPath: string): Promise<void> {
  const key = `${s3MediaPrefix(userId, instanceId)}${relPath}`;
  const deleted = await deleteKeys([key]);
  if (deleted.length === 0) throw new Error(`S3 refused to delete ${key}`);

  const manifest = await loadManifest(instanceId);
  if (manifest.media[relPath]) {
    delete manifest.media[relPath];
    await saveManifest(instanceId, manifest);
  }
  debug("s3", `deleted media object ${key}`);
}
