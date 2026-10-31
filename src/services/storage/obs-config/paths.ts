import { lstat } from "node:fs/promises";
import { join } from "node:path";

// Local disk layout and S3 key layout for an instance's OBS config/media.

export const PROFILE_NAME = "StreamWizard";

const CONFIG_BASE = process.env.OBS_CONFIG_BASE ?? "/data/obs-configs";
const TEMPLATES_BASE = process.env.OBS_TEMPLATES_PREFIX ?? "obs-templates/";
export const DEFAULT_TEMPLATE = process.env.OBS_DEFAULT_TEMPLATE ?? "default";

export function templatePrefix(template: string): string {
  return `${TEMPLATES_BASE}${template}/`;
}

export function instanceDir(instanceId: string): string {
  return join(CONFIG_BASE, instanceId);
}

export function localConfigDir(instanceId: string): string {
  return join(CONFIG_BASE, instanceId, "obs-studio");
}

// Exported so the media file-manager service (services/storage/media.ts) writes user
// uploads into the exact same dir that gets bind-mounted to /home/app/media
// and synced to S3 -- keeping one source of truth for the path.
export function localMediaDir(instanceId: string): string {
  return join(CONFIG_BASE, instanceId, "media");
}

export function s3Prefix(userId: string, instanceId: string): string {
  return `obs-configs/${userId}/${instanceId}/`;
}

export function s3MediaPrefix(userId: string, instanceId: string): string {
  return `obs-media/${userId}/${instanceId}/`;
}

export async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}
