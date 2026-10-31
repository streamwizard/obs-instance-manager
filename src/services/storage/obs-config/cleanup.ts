import { rm } from "node:fs/promises";
import { debug, log } from "@/utils/logger";
import { deleteKeys, listObjects } from "@/services/storage/s3-objects";
import { instanceDir, s3MediaPrefix, s3Prefix } from "./paths";

export async function removeLocalConfig(instanceId: string): Promise<void> {
  await rm(instanceDir(instanceId), { recursive: true, force: true });
  debug("s3", `removed local config dir for instance ${instanceId}`);
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
