import { clearApiStopping, markApiStopping, removeContainer, stopContainer } from "@/clients/docker";
import { deleteInstance } from "@/clients/supabase";
import { broadcastLifecycle } from "@/clients/ws-server";
import { removeLocalConfig, removeS3Config } from "@/services/storage/obs-config";
import { withInstanceLock } from "@/utils/instance-lock";
import { debug, log } from "@/utils/logger";
import type { Instance } from "@/types";

// Permanent delete: tears down the container (if any), wipes the local config
// dir and the S3 prefix, then removes the DB row. Container/config cleanup is
// best-effort so a half-broken instance can still be deleted.
export async function destroyInstance(instance: Instance): Promise<void> {
  const id = instance.id;

  await withInstanceLock(id, async () => {
    if (instance.container_id) {
      const containerId = instance.container_id;
      markApiStopping(containerId);
      try {
        await stopContainer(containerId).catch((e) =>
          debug("docker", `stop failed for ${id}: ${(e as Error).message}`)
        );

        // No push: the S3 prefix is removed right below.
        await removeLocalConfig(id).catch((e) =>
          log("warn", "failed to remove local config dir before delete", {
            instanceId: id,
            error: (e as Error).message,
          })
        );

        await removeContainer(containerId).catch((e) =>
          debug("docker", `remove failed for ${id}: ${(e as Error).message}`)
        );
      } finally {
        clearApiStopping(containerId);
      }
    }

    await removeS3Config(instance.user_id, id).catch((e) =>
      log("warn", "S3 config removal failed", { instanceId: id, error: (e as Error).message })
    );

    await deleteInstance(id);
    broadcastLifecycle(instance.user_id, id, "deleted");
  });
}
