import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { debug, log } from "../utils/logger";
import { mapLimit } from "../utils/concurrency";
import { S3_SYNC_CONCURRENCY } from "../utils/constants";
import { isPluginPath, isSyncedConfigPath, isSyncedMediaPath } from "./obs-sync-policy";
import { copyObject, deleteKeys, downloadToFile, listObjects, uploadFile } from "./s3-objects";

const PROFILE_NAME = "StreamWizard";

const CONFIG_BASE = process.env.OBS_CONFIG_BASE ?? "/data/obs-configs";
const TEMPLATES_BASE = process.env.OBS_TEMPLATES_PREFIX ?? "obs-templates/";
const DEFAULT_TEMPLATE = process.env.OBS_DEFAULT_TEMPLATE ?? "default";

// Push retries before a stop gives up and keeps the local dir for next start.
const PUSH_ATTEMPTS = 3;

const MAX_KEY_BYTES = 1024;

function templatePrefix(template: string): string {
  return `${TEMPLATES_BASE}${template}/`;
}

function instanceDir(instanceId: string): string {
  return join(CONFIG_BASE, instanceId);
}

function localConfigDir(instanceId: string): string {
  return join(CONFIG_BASE, instanceId, "obs-studio");
}

// Exported so the media file-manager service (services/media.ts) writes user
// uploads into the exact same dir that gets bind-mounted to /home/app/media
// and synced to S3 below -- keeping one source of truth for the path.
export function localMediaDir(instanceId: string): string {
  return join(CONFIG_BASE, instanceId, "media");
}

function s3Prefix(userId: string, instanceId: string): string {
  return `obs-configs/${userId}/${instanceId}/`;
}

function s3MediaPrefix(userId: string, instanceId: string): string {
  return `obs-media/${userId}/${instanceId}/`;
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

// ── Sync manifest ───────────────────────────────────────────────────────────
// Records what S3 holds for each synced file, so a push only uploads files
// that changed and deletes keys for files that are gone. It lives in the
// instance dir but outside both bind mounts (obs-studio/ and media/), so the
// container can't tamper with it, and removeLocalConfig takes it with it.
//
// source "template": the file came from the plan template and the user's
// overlay prefix doesn't hold it -- it's only uploaded once its content
// differs, and never deleted from S3 (it was never there).

interface ManifestEntry {
  size: number;
  mtimeMs: number;
  // sha256 of the content; "" for media, which only our routes rewrite, so
  // size+mtime is enough and multi-GB files never get hashed.
  hash: string;
  source: "overlay" | "template";
}

interface SyncManifest {
  version: 1;
  config: Record<string, ManifestEntry>;
  media: Record<string, ManifestEntry>;
}

function emptyManifest(): SyncManifest {
  return { version: 1, config: {}, media: {} };
}

function manifestPath(instanceId: string): string {
  return join(instanceDir(instanceId), ".sync-manifest.json");
}

// A missing or unreadable manifest (dirs from before it existed) means every
// file is treated as changed once and nothing is deleted.
async function loadManifest(instanceId: string): Promise<SyncManifest> {
  try {
    const m = JSON.parse(await Bun.file(manifestPath(instanceId)).text());
    if (m?.version === 1 && m.config && m.media) return m;
  } catch {
    // no manifest yet
  }
  return emptyManifest();
}

async function saveManifest(instanceId: string, manifest: SyncManifest): Promise<void> {
  const path = manifestPath(instanceId);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, JSON.stringify(manifest));
  await rename(tmp, path);
}

async function hashFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

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

// ── Push ────────────────────────────────────────────────────────────────────

interface SyncStats {
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
async function syncSection(opts: SyncSectionOptions): Promise<SyncStats> {
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

// ── Pull ────────────────────────────────────────────────────────────────────

interface DownloadRecord {
  entries: Record<string, ManifestEntry>;
  source: ManifestEntry["source"];
  hashContent: boolean;
  filter: (rel: string) => boolean;
}

async function downloadPrefix(keys: string[], prefix: string, localBase: string, record: DownloadRecord): Promise<void> {
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
async function pruneKeys(keys: string[], instanceId: string, what: string): Promise<void> {
  if (keys.length === 0) return;
  try {
    const deleted = await deleteKeys(keys);
    log("info", `pruned unsynced ${what} keys from S3`, { instanceId, deleted: deleted.length, total: keys.length });
  } catch (e) {
    log("warn", `failed to prune unsynced ${what} keys from S3`, { instanceId, error: (e as Error).message });
  }
}

function splitByPolicy(keys: string[], prefix: string, filter: (rel: string) => boolean) {
  const keep: string[] = [];
  const junk: string[] = [];
  for (const key of keys) (filter(key.slice(prefix.length)) ? keep : junk).push(key);
  return { keep, junk };
}

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
// docker.ts's /home/app/media bind mount). No template layer here — media
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

export async function removeLocalConfig(instanceId: string): Promise<void> {
  await rm(instanceDir(instanceId), { recursive: true, force: true });
  debug("s3", `removed local config dir for instance ${instanceId}`);
}

function serviceJsonPath(instanceId: string): string {
  return join(localConfigDir(instanceId), "basic", "profiles", PROFILE_NAME, "service.json");
}

function obsWsConfigPath(instanceId: string): string {
  return join(localConfigDir(instanceId), "plugin_config", "obs-websocket", "config.json");
}

// Writes our generated password into the obs-websocket config.json after
// pullObsConfig runs. The entrypoint only seeds that file when it doesn't
// exist; if one is already there (template, or a leftover dir) with a
// different password the entrypoint would silently ignore
// OBS_WEBSOCKET_PASSWORD. Patching here ensures the password we stored in the
// DB is always the one OBS actually uses. The file is never pushed to S3
// (see obs-sync-policy.ts).
export async function injectObsWsPassword(instanceId: string, password: string): Promise<void> {
  const path = obsWsConfigPath(instanceId);
  await mkdir(path.substring(0, path.lastIndexOf("/")), { recursive: true });

  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await Bun.file(path).text());
  } catch {
    // no existing config — start fresh
  }

  cfg.server_enabled = true;
  cfg.auth_required = true;
  cfg.server_password = password;
  cfg.first_load = false;
  cfg.alerts_enabled = cfg.alerts_enabled ?? false;
  cfg.server_port = cfg.server_port ?? Number(process.env.OBS_WEBSOCKET_PORT ?? 4455);

  await Bun.write(path, JSON.stringify(cfg, null, 4));
  debug("obs-config", `obs-websocket password injected for instance ${instanceId}`);
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

// Clears the stream key from service.json after a stop. service.json lives in
// basic/profiles/, which the sync policy never pushes, so this is defence in
// depth for the local dir that may outlive a failed push, not what keeps the
// key out of S3.
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
  for (const [what, prefix] of [
    ["config", s3Prefix(userId, instanceId)],
    ["media", s3MediaPrefix(userId, instanceId)],
  ] as const) {
    const keys = (await listObjects(prefix)).map((o) => o.key);
    if (keys.length === 0) {
      debug("s3", `no S3 ${what} to remove for instance ${instanceId}`);
      continue;
    }
    const deleted = await deleteKeys(keys);
    log("info", `obs ${what} removed from S3`, { userId, instanceId, files: deleted.length });
  }
}
