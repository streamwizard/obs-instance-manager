import { getCachedNodeInstances } from "@/services/cache/instance-cache";
import { pushObsConfig } from "@/services/storage/obs-config";
import { isInstanceLocked, withInstanceLock } from "@/utils/instance-lock";
import { mapLimit } from "@/utils/concurrency";
import { AUTOSAVE_INSTANCE_CONCURRENCY, CONFIG_AUTOSAVE_INTERVAL_MS } from "@/utils/constants";
import { debug, log } from "@/utils/logger";

// Bounds config-loss exposure from a hard crash (see CONFIG_AUTOSAVE_INTERVAL_MS)
// by periodically pushing every running instance's config to S3, same as a
// clean /stop does. Failures are per-instance and non-fatal -- one bad push
// shouldn't skip the rest or crash the interval.
export function startConfigAutosave(): void {
  setInterval(() => {
    autosaveRunningInstanceConfigs().catch((err) =>
      log("error", "config autosave pass failed", { error: (err as Error).message }),
    );
  }, CONFIG_AUTOSAVE_INTERVAL_MS);
}

// Each push takes the instance lock so it can't land an older upload after a
// stop's final push, or resurrect a media file a route just deleted. An
// instance that's already locked (stopping, starting, mid media op) is skipped
// rather than queued: its own operation pushes, and a queued autosave would
// run against a dir the stop already removed.
async function autosaveRunningInstanceConfigs(): Promise<void> {
  const nodeInstances = await getCachedNodeInstances();
  const running = nodeInstances.filter((i) => i.status === "running" && i.container_id);

  let pushed = 0;
  await mapLimit(running, AUTOSAVE_INSTANCE_CONCURRENCY, async (instance) => {
    if (isInstanceLocked(instance.id)) {
      debug("autosave", `skipping ${instance.id}, another operation holds its lock`);
      return;
    }
    await withInstanceLock(instance.id, () => pushObsConfig(instance.user_id, instance.id, { deletes: false }))
      .then(() => pushed++)
      .catch((e) =>
        log("warn", "config autosave push failed", {
          instanceId: instance.id,
          error: (e as Error).message,
        }),
      );
  });

  debug("autosave", `checked config for ${pushed}/${running.length} running instance(s)`);
}
