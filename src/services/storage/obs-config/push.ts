import { debug, log } from "@/utils/logger";
import { isSyncedConfigPath, isSyncedMediaPath } from "@/services/storage/obs-sync-policy";
import { loadManifest, saveManifest } from "./manifest";
import { instanceDir, localConfigDir, localMediaDir, pathExists, s3MediaPrefix, s3Prefix } from "./paths";
import { syncSection, type SyncStats } from "./sync";
import { removeLocalConfig } from "./cleanup";

// Push retries before a stop gives up and keeps the local dir for next start.
const PUSH_ATTEMPTS = 3;

export interface PushOptions {
  // Mirror local deletions to S3. Autosave turns this off: it runs against a
  // live OBS, which saves scene JSON by renaming files around, so a file can
  // be briefly missing. Final pushes (stop, crash, leftover) run on a stopped
  // container and do delete.
  deletes?: boolean;
}

// Uploads the instance's changed OBS config and media to S3 under the user's
// key so it can be restored on any node. Throws if any file failed, after
// saving progress, so callers can retry.
export async function pushObsConfig(userId: string, instanceId: string, options: PushOptions = {}): Promise<void> {
  if (!(await pathExists(instanceDir(instanceId)))) {
    debug("s3", `no local dir to push for instance ${instanceId}`);
    return;
  }

  const deletes = options.deletes ?? true;
  const manifest = await loadManifest(instanceId);
  let config: SyncStats;
  let media: SyncStats;
  try {
    config = await syncSection({
      localBase: localConfigDir(instanceId),
      prefix: s3Prefix(userId, instanceId),
      entries: manifest.config,
      filter: isSyncedConfigPath,
      hashContent: true,
      deletes,
    });
    media = await syncSection({
      localBase: localMediaDir(instanceId),
      prefix: s3MediaPrefix(userId, instanceId),
      entries: manifest.media,
      filter: isSyncedMediaPath,
      hashContent: false,
      deletes,
    });
  } finally {
    await saveManifest(instanceId, manifest);
  }

  const failed = config.failed + media.failed;
  const changed = config.uploaded + config.deleted + media.uploaded + media.deleted;
  if (changed > 0 || failed > 0) {
    log(failed > 0 ? "warn" : "info", "obs config synced to S3", { userId, instanceId, config, media });
  } else {
    debug("s3", `nothing changed for instance ${instanceId} (${config.skipped + media.skipped} files checked)`);
  }
  if (failed > 0) throw new Error(`${failed} file(s) failed to sync to S3`);
}

// Final push for a stopped container, then local cleanup. Retries the push,
// and only removes the local dir once it succeeded: the dir is the only copy
// of anything changed since the last successful push, and the next start on
// this node pushes it before pulling (see pullObsConfig).
export async function persistAndRemoveLocalConfig(userId: string, instanceId: string): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pushObsConfig(userId, instanceId);
      break;
    } catch (e) {
      if (attempt >= PUSH_ATTEMPTS) {
        log("error", "obs config push failed, keeping local config dir for the next start", {
          instanceId,
          attempts: attempt,
          error: (e as Error).message,
        });
        return false;
      }
      await Bun.sleep(attempt * 1000);
    }
  }

  await removeLocalConfig(instanceId).catch((e) =>
    log("warn", "failed to remove local config dir", { instanceId, error: (e as Error).message })
  );
  return true;
}
