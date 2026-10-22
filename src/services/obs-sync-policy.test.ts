import { describe, expect, test } from "bun:test";
import { isSyncedConfigPath, isSyncedMediaPath } from "./obs-sync-policy";

// Every file OBS 32.2 wrote into ~/.config/obs-studio after one boot plus one
// browser source (captured from the real instance image).
const PROBE_FILES = [
  ".sentinel/run_3a8b8899-49f8-4316-9bff-d2a14bd4dd96",
  ".websocket_password",
  "basic/profiles/Untitled/basic.ini",
  "basic/scenes/Untitled.json",
  "basic/scenes/Untitled.json.bak",
  "global.ini",
  "logs/2026-10-22 07-29-36.txt",
  "plugin_config/obs-browser/000003.log",
  "plugin_config/obs-browser/CURRENT",
  "plugin_config/obs-browser/Cache/Cache_Data/5349fbae98c6d9a1_0",
  "plugin_config/obs-browser/Cache/Cache_Data/b1a3c775546b93a7_0",
  "plugin_config/obs-browser/Cache/Cache_Data/index",
  "plugin_config/obs-browser/Cache/Cache_Data/index-dir/the-real-index",
  "plugin_config/obs-browser/Code Cache/js/eef242fb354b72cf_0",
  "plugin_config/obs-browser/Code Cache/js/index",
  "plugin_config/obs-browser/Code Cache/js/index-dir/the-real-index",
  "plugin_config/obs-browser/Code Cache/wasm/index",
  "plugin_config/obs-browser/Code Cache/wasm/index-dir/the-real-index",
  "plugin_config/obs-browser/Cookies",
  "plugin_config/obs-browser/Cookies-journal",
  "plugin_config/obs-browser/DawnGraphiteCache/data_0",
  "plugin_config/obs-browser/DawnGraphiteCache/data_1",
  "plugin_config/obs-browser/DawnGraphiteCache/data_2",
  "plugin_config/obs-browser/DawnGraphiteCache/data_3",
  "plugin_config/obs-browser/DawnGraphiteCache/index",
  "plugin_config/obs-browser/DawnWebGPUCache/data_0",
  "plugin_config/obs-browser/DawnWebGPUCache/data_1",
  "plugin_config/obs-browser/DawnWebGPUCache/data_2",
  "plugin_config/obs-browser/DawnWebGPUCache/data_3",
  "plugin_config/obs-browser/DawnWebGPUCache/index",
  "plugin_config/obs-browser/GPUCache/data_0",
  "plugin_config/obs-browser/GPUCache/data_1",
  "plugin_config/obs-browser/GPUCache/data_2",
  "plugin_config/obs-browser/GPUCache/data_3",
  "plugin_config/obs-browser/GPUCache/index",
  "plugin_config/obs-browser/GrShaderCache/data_0",
  "plugin_config/obs-browser/GrShaderCache/data_1",
  "plugin_config/obs-browser/GrShaderCache/data_2",
  "plugin_config/obs-browser/GrShaderCache/data_3",
  "plugin_config/obs-browser/GrShaderCache/index",
  "plugin_config/obs-browser/GraphiteDawnCache/data_0",
  "plugin_config/obs-browser/GraphiteDawnCache/data_1",
  "plugin_config/obs-browser/GraphiteDawnCache/data_2",
  "plugin_config/obs-browser/GraphiteDawnCache/data_3",
  "plugin_config/obs-browser/GraphiteDawnCache/index",
  "plugin_config/obs-browser/LOCK",
  "plugin_config/obs-browser/LOG",
  "plugin_config/obs-browser/Local Storage/leveldb/000003.log",
  "plugin_config/obs-browser/Local Storage/leveldb/CURRENT",
  "plugin_config/obs-browser/Local Storage/leveldb/LOCK",
  "plugin_config/obs-browser/Local Storage/leveldb/LOG",
  "plugin_config/obs-browser/Local Storage/leveldb/MANIFEST-000001",
  "plugin_config/obs-browser/LocalPrefs.json",
  "plugin_config/obs-browser/MANIFEST-000001",
  "plugin_config/obs-browser/Network Persistent State",
  "plugin_config/obs-browser/Reporting and NEL",
  "plugin_config/obs-browser/Reporting and NEL-journal",
  "plugin_config/obs-browser/SCT Auditing Pending Reports",
  "plugin_config/obs-browser/Session Storage/000003.log",
  "plugin_config/obs-browser/Session Storage/CURRENT",
  "plugin_config/obs-browser/Session Storage/LOCK",
  "plugin_config/obs-browser/Session Storage/LOG",
  "plugin_config/obs-browser/Session Storage/MANIFEST-000001",
  "plugin_config/obs-browser/ShaderCache/data_0",
  "plugin_config/obs-browser/ShaderCache/data_1",
  "plugin_config/obs-browser/ShaderCache/data_2",
  "plugin_config/obs-browser/ShaderCache/data_3",
  "plugin_config/obs-browser/ShaderCache/index",
  "plugin_config/obs-browser/Shared Dictionary/cache/index",
  "plugin_config/obs-browser/Shared Dictionary/cache/index-dir/the-real-index",
  "plugin_config/obs-browser/Shared Dictionary/db",
  "plugin_config/obs-browser/Shared Dictionary/db-journal",
  "plugin_config/obs-browser/Trust Tokens",
  "plugin_config/obs-browser/Trust Tokens-journal",
  "plugin_config/obs-browser/UserPrefs.json",
  "plugin_config/obs-browser/Visited Links",
  "plugin_config/obs-browser/first_party_sets.db",
  "plugin_config/obs-browser/first_party_sets.db-journal",
  "plugin_config/obs-websocket/config.json",
  "plugin_config/rtmp-services/amazon_ivs_ingests.json",
  "plugin_config/rtmp-services/package.json",
  "plugin_config/rtmp-services/services.json",
  "plugin_config/rtmp-services/twitch_ingests.json",
  "plugin_manager/modules.json",
  "updates/whatsnew.json",
  "user.ini",
];

describe("isSyncedConfigPath", () => {
  test("keeps only user-owned state from a real OBS config dir", () => {
    expect(PROBE_FILES.filter(isSyncedConfigPath).sort()).toEqual([
      "basic/scenes/Untitled.json",
      "global.ini",
      "plugin_config/obs-browser/Cookies",
      "plugin_config/obs-browser/Local Storage/leveldb/000003.log",
      "plugin_config/obs-browser/Local Storage/leveldb/CURRENT",
      "plugin_config/obs-browser/Local Storage/leveldb/MANIFEST-000001",
      "plugin_manager/modules.json",
      "user.ini",
    ]);
  });

  test("keeps IndexedDB and third-party plugin settings", () => {
    expect(isSyncedConfigPath("plugin_config/obs-browser/IndexedDB/https_x_0.indexeddb.leveldb/000005.ldb")).toBe(true);
    expect(isSyncedConfigPath("plugin_config/obs-browser/IndexedDB/https_x_0.indexeddb.leveldb/LOCK")).toBe(false);
    expect(isSyncedConfigPath("plugin_config/advanced-scene-switcher/settings.json")).toBe(true);
    expect(isSyncedConfigPath("basic/scenes/Main Stream.json")).toBe(true);
  });

  test("drops plugins, profiles, logs and traversal", () => {
    expect(isSyncedConfigPath("plugins/foo/bin/64bit/foo.so")).toBe(false);
    expect(isSyncedConfigPath("basic/profiles/StreamWizard/service.json")).toBe(false);
    expect(isSyncedConfigPath("crashes/Crash 2026.txt")).toBe(false);
    expect(isSyncedConfigPath("profiler_data/x.csv.gz")).toBe(false);
    expect(isSyncedConfigPath("plugin_config/x.json")).toBe(false);
    expect(isSyncedConfigPath("basic/scenes/../../global.ini")).toBe(false);
    expect(isSyncedConfigPath("")).toBe(false);
  });
});

describe("isSyncedMediaPath", () => {
  test("keeps media, drops dotfiles and in-progress uploads", () => {
    expect(isSyncedMediaPath("intro.mp4")).toBe(true);
    expect(isSyncedMediaPath("alerts/sub.webm")).toBe(true);
    expect(isSyncedMediaPath(".upload-3f2a.tmp")).toBe(false);
    expect(isSyncedMediaPath("alerts/.upload-3f2a.tmp")).toBe(false);
    expect(isSyncedMediaPath("../escape.mp4")).toBe(false);
  });
});
