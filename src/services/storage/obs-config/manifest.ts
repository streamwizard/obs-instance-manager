import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { instanceDir } from "./paths";

// ── Sync manifest ───────────────────────────────────────────────────────────
// Records what S3 holds for each synced file, so a push only uploads files
// that changed and deletes keys for files that are gone. It lives in the
// instance dir but outside both bind mounts (obs-studio/ and media/), so the
// container can't tamper with it, and removeLocalConfig takes it with it.
//
// source "template": the file came from the plan template and the user's
// overlay prefix doesn't hold it -- it's only uploaded once its content
// differs, and never deleted from S3 (it was never there).

export interface ManifestEntry {
  size: number;
  mtimeMs: number;
  // sha256 of the content; "" for media, which only our routes rewrite, so
  // size+mtime is enough and multi-GB files never get hashed.
  hash: string;
  source: "overlay" | "template";
}

export interface SyncManifest {
  version: 1;
  config: Record<string, ManifestEntry>;
  media: Record<string, ManifestEntry>;
}

export function emptyManifest(): SyncManifest {
  return { version: 1, config: {}, media: {} };
}

function manifestPath(instanceId: string): string {
  return join(instanceDir(instanceId), ".sync-manifest.json");
}

// A missing or unreadable manifest (dirs from before it existed) means every
// file is treated as changed once and nothing is deleted.
export async function loadManifest(instanceId: string): Promise<SyncManifest> {
  try {
    const m = JSON.parse(await Bun.file(manifestPath(instanceId)).text());
    if (m?.version === 1 && m.config && m.media) return m;
  } catch {
    // no manifest yet
  }
  return emptyManifest();
}

export async function saveManifest(instanceId: string, manifest: SyncManifest): Promise<void> {
  const path = manifestPath(instanceId);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, JSON.stringify(manifest));
  await rename(tmp, path);
}

export async function hashFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}
