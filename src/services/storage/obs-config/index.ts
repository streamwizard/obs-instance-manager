// Public API for an instance's OBS config/media on disk and in S3.
//   paths.ts       local dir + S3 key layout
//   manifest.ts    per-instance record of what S3 holds
//   sync.ts        dir <-> prefix mirroring engine
//   push.ts        local -> S3 (stop, autosave, crash)
//   pull.ts        S3 -> local (start), template base layer
//   media-sync.ts  single-file media ops for the file-manager routes
//   secrets.ts     ws password / stream key injection
//   cleanup.ts     local dir + S3 prefix removal
export { localMediaDir } from "./paths";
export { pushObsConfig, persistAndRemoveLocalConfig, type PushOptions } from "./push";
export { pullObsConfig } from "./pull";
export { pushObsMediaFile, moveObsMediaFile, deleteObsMediaFile } from "./media-sync";
export { injectObsWsPassword, injectStreamKey, clearStreamKey } from "./secrets";
export { removeLocalConfig, removeS3Config } from "./cleanup";
