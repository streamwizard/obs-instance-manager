import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { debug, log } from "@/utils/logger";
import { isPluginPath, isSyncedConfigPath, isSyncedMediaPath } from "@/services/storage/obs-sync-policy";
import { listObjects } from "@/services/storage/s3-objects";
import { emptyManifest, saveManifest, type SyncManifest } from "./manifest";
import { DEFAULT_TEMPLATE, instanceDir, localConfigDir, localMediaDir, pathExists, s3MediaPrefix, s3Prefix, templatePrefix } from "./paths";
import { downloadPrefix, pruneKeys, splitByPolicy } from "./sync";
import { pushObsConfig } from "./push";
import { removeLocalConfig } from "./cleanup";

// Replaces the local basic/profiles/ with the template's. Wipes first, so if
// S3 is down the instance boots without a profile (OBS creates a default)
// rather than with a user-edited one.
async function applyTemplateProfile(instanceId: string, template: string): Promise<void> {
  const localBase = localConfigDir(instanceId);
  await rm(join(localBase, "basic", "profiles"), { recursive: true, force: true });
  const tPrefix = templatePrefix(template);
  const keys = (await listObjects(`${tPrefix}basic/profiles/`)).map((o) => o.key);
  await downloadPrefix(keys, tPrefix, localBase, {
    entries: {},
    source: "template",
    hashContent: false,
    filter: () => false,
  });
}

// Downloads the user's OBS config from S3 into the instance's local bind-mount
// directory. Always applies the named template as a base layer first so shared
// assets (default scenes, the plan's profile, etc.) reach every instance
// automatically. The instance's own config is then overlaid on top, so user
// changes always win.
export async function pullObsConfig(userId: string, instanceId: string, template = DEFAULT_TEMPLATE): Promise<void> {
  // A dir left behind by a crash or a failed final push holds changes S3 may
  // not have. Push it first so pulling doesn't clobber it with older state; if
  // S3 can't take it, start from it as-is rather than lose it.
  if (await pathExists(instanceDir(instanceId))) {
    try {
      await pushObsConfig(userId, instanceId);
      await removeLocalConfig(instanceId);
      log("info", "pushed leftover local config before pull", { instanceId });
    } catch (e) {
      log("warn", "leftover local config could not be pushed, starting from it as-is", {
        instanceId,
        error: (e as Error).message,
      });
      // The profile is still plan-owned: never start from one the user may
      // have edited in the last run.
      await applyTemplateProfile(instanceId, template).catch((err) =>
        log("warn", "could not re-apply template profile to leftover config", {
          instanceId,
          error: (err as Error).message,
        })
      );
      return;
    }
  }

  const localBase = localConfigDir(instanceId);
  await mkdir(localBase, { recursive: true });
  const manifest = emptyManifest();

  // Template base layer (default config, scenes, the plan's profile). Plugin
  // binaries are excluded — they're shared across all instances via
  // syncPlugins()/PLUGINS_LOCAL_DIR and bind-mounted directly into the
  // container. This filter is defensive: it holds even if a template still has
  // (or regains) its own plugins/ subtree in S3.
  const tPrefix = templatePrefix(template);
  const allTemplateKeys = (await listObjects(tPrefix)).map((o) => o.key);
  const templateKeys = allTemplateKeys.filter((key) => !isPluginPath(key.slice(tPrefix.length)));
  await downloadPrefix(templateKeys, tPrefix, localBase, {
    entries: manifest.config,
    source: "template",
    hashContent: true,
    filter: isSyncedConfigPath,
  });
  if (templateKeys.length > 0) {
    debug("s3", `applied template "${template}" (${templateKeys.length} files) for instance ${instanceId}`);
  }

  // Overlay the instance's own config on top. Only policy-synced paths are
  // restored -- notably never basic/profiles/ (plan-owned, from the template
  // above) or plugins/ -- and the rest is pruned from S3.
  const prefix = s3Prefix(userId, instanceId);
  const { keep, junk } = splitByPolicy(
    (await listObjects(prefix)).map((o) => o.key),
    prefix,
    isSyncedConfigPath,
  );
  await downloadPrefix(keep, prefix, localBase, {
    entries: manifest.config,
    source: "overlay",
    hashContent: true,
    filter: isSyncedConfigPath,
  });
  await pruneKeys(junk, instanceId, "config");
  if (keep.length > 0) {
    log("info", "obs config pulled from S3", { userId, instanceId, template, templateFiles: templateKeys.length, instanceFiles: keep.length });
  } else {
    log("info", "no instance config in S3, started from template", { userId, instanceId, template, templateFiles: templateKeys.length });
  }

  await pullObsMedia(userId, instanceId, manifest);
  await saveManifest(instanceId, manifest);
}

// Restores whatever the user previously placed in OBS's media folder (see
// clients/docker.ts's /home/app/media bind mount). No template layer here — media
// is purely user-owned, unlike config which has a shared default base.
async function pullObsMedia(userId: string, instanceId: string, manifest: SyncManifest): Promise<void> {
  const localBase = localMediaDir(instanceId);
  await mkdir(localBase, { recursive: true });

  const prefix = s3MediaPrefix(userId, instanceId);
  const { keep, junk } = splitByPolicy(
    (await listObjects(prefix)).map((o) => o.key),
    prefix,
    isSyncedMediaPath,
  );
  await downloadPrefix(keep, prefix, localBase, {
    entries: manifest.media,
    source: "overlay",
    hashContent: false,
    filter: isSyncedMediaPath,
  });
  await pruneKeys(junk, instanceId, "media");
  if (keep.length > 0) {
    log("info", "obs media pulled from S3", { userId, instanceId, files: keep.length });
  } else {
    debug("s3", `no media in S3 for instance ${instanceId}`);
  }
}
