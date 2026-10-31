// Decides which files under an instance's OBS config dir and media dir are
// persisted to S3. Config is an allow-list: OBS and its embedded Chromium
// (obs-browser) write a lot of regenerated state into ~/.config/obs-studio --
// logs, crash sentinels, GPU/shader/HTTP caches, rtmp-services downloads --
// and a skip-list leaked every new cache dir straight into the bucket. Only
// user-owned state below is kept; everything else is rebuilt on the next boot.

// Plugin binaries are shared across all instances via syncPlugins()/PLUGINS_LOCAL_DIR
// and bind-mounted directly into the container — they must never be pulled into, or
// pushed from, an instance's own config tree.
export function isPluginPath(rel: string): boolean {
  return rel.startsWith("plugins/");
}

// The OBS profile (basic/profiles/) is deliberately absent from the allow-list
// below: it holds resolution, fps and encoder/output settings -- all plan-owned
// -- and is sourced only from the plan template folder on every start, never
// overlaid from the user's obs-configs and never pushed back, so a user can't
// drift off their plan and a plan change takes effect on next start.
// service.json (the stream key) lives there too, which is why the key never
// reaches S3.

const ROOT_FILES = new Set(["global.ini", "user.ini"]);

// plugin_config/<name>/ dirs that are regenerated on every boot. obs-websocket's
// config.json carries the live server password and is rewritten by
// injectObsWsPassword on start; rtmp-services is a service list OBS downloads.
const REGENERATED_PLUGIN_CONFIGS = new Set(["obs-websocket", "rtmp-services"]);

// What survives of obs-browser's Chromium profile: cookies and site storage, so
// overlays that keep a login or settings in the browser don't reset on every
// restart. Caches (Cache, Code Cache, GPUCache, *ShaderCache, Dawn*), session
// storage and Chromium's own bookkeeping are rebuilt by CEF.
const BROWSER_KEEP_FILES = new Set(["Cookies"]);
const BROWSER_KEEP_DIRS = ["Local Storage/", "IndexedDB/"];

// leveldb lock/info-log files: recreated on open, meaningless once copied.
const LEVELDB_TRANSIENT = new Set(["LOCK", "LOG", "LOG.old"]);

function basename(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

function isBrowserPathSynced(rel: string): boolean {
  if (BROWSER_KEEP_FILES.has(rel)) return true;
  if (!BROWSER_KEEP_DIRS.some((dir) => rel.startsWith(dir))) return false;
  return !LEVELDB_TRANSIENT.has(basename(rel));
}

// `rel` is relative to the instance's obs-studio dir, "/"-separated.
export function isSyncedConfigPath(rel: string): boolean {
  if (!rel || rel.includes("\0") || rel.split("/").includes("..")) return false;
  // SQLite rollback journals only exist mid-transaction or after a crash.
  if (rel.endsWith("-journal")) return false;

  if (ROOT_FILES.has(rel)) return true;
  if (rel.startsWith("plugin_manager/")) return true;

  if (rel.startsWith("basic/scenes/")) {
    return !rel.endsWith(".bak") && !rel.endsWith(".tmp");
  }

  if (rel.startsWith("plugin_config/")) {
    const rest = rel.slice("plugin_config/".length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return false;
    const plugin = rest.slice(0, slash);
    const inner = rest.slice(slash + 1);
    if (REGENERATED_PLUGIN_CONFIGS.has(plugin)) return false;
    if (plugin === "obs-browser") return isBrowserPathSynced(inner);
    // Any other plugin's settings (scene switchers, move transitions, ...) are
    // user state.
    return true;
  }

  return false;
}

// `rel` is relative to the instance's media dir. Media is user-owned, so
// everything is kept except dotfiles -- notably media.ts's in-progress
// `.upload-<uuid>.tmp` files, which must never be pushed mid-upload.
export function isSyncedMediaPath(rel: string): boolean {
  if (!rel || rel.includes("\0")) return false;
  return !rel.split("/").some((part) => part === ".." || part.startsWith("."));
}
