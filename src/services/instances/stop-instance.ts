import { clearApiStopping, markApiStopping, removeContainer, stopContainer } from "@/clients/docker";
import { updateInstance } from "@/clients/supabase";
import { broadcastLifecycle } from "@/clients/ws-server";
import { clearStreamKey, persistAndRemoveLocalConfig } from "@/services/storage/obs-config";
import { withInstanceLock } from "@/utils/instance-lock";
import { debug, log } from "@/utils/logger";
import type { Instance } from "@/types";

// Deliberate stop: stops the container, strips the stream key, pushes the
// config to S3, removes the container and marks the row "stopped". Caller
// must have checked instance.container_id is set.
//
// markApiStopping keeps the docker die-event handler (services/docker/event-listener.ts) from
// treating this as an out-of-band exit and doing its own status write/push.
export async function stopInstance(instance: Instance): Promise<Instance> {
  const id = instance.id;

  return withInstanceLock(id, async () => {
    const containerId = instance.container_id as string;
    markApiStopping(containerId);
    // Leading-edge signal: this stop is deliberate. Lets other devices show
    // "Stopping…" instead of reading the imminent socket drop as a blip.
    broadcastLifecycle(instance.user_id, id, "stopping");
    try {
      await stopContainer(containerId);

      await clearStreamKey(id).catch((e) =>
        log("warn", "failed to clear stream key before push", { instanceId: id, error: (e as Error).message })
      );

      await persistAndRemoveLocalConfig(instance.user_id, id);

      await removeContainer(containerId).catch((e) =>
        debug("docker", `remove failed for ${id}: ${(e as Error).message}`)
      );

      const result = await updateInstance(id, { container_id: null, status: "stopped" });
      broadcastLifecycle(instance.user_id, id, "stopped");
      return result;
    } finally {
      clearApiStopping(containerId);
    }
  });
}
