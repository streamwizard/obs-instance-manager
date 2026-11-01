// Shared "bring this instance's container up" flow, used by the end-user
// POST /:id/start route, the admin POST /instances/:id/start route, and
// boot-time/event-driven recovery (reconcileContainers, gpu-xserver restart
// handling in services/docker/) -- previously this logic was duplicated between
// instances.ts and admin.ts, which had already drifted (admin.ts's copy was
// missing the syncPlugins()/stream-key-injection steps the end-user route had).
import { createContainer, findContainerByName, removeContainer, startContainer } from "@/clients/docker";
import { updateInstance } from "@/clients/streamwizard-api/instances";
import { broadcastLifecycle } from "@/clients/ws-server";
import type { InstanceSecrets } from "@/clients/streamwizard-api/secrets";
import { getInstanceSecrets } from "@/services/cache/instance-secrets-cache";
import { debug, log } from "@/utils/logger";
import { withInstanceLock } from "@/utils/instance-lock";
import { pullObsConfig, injectObsWsPassword, injectStreamKey } from "@/services/storage/obs-config";
import { syncPlugins } from "@/services/storage/plugins";
import { requireStreamKey } from "@/services/instances/twitch";
import type { Instance } from "@/types";

export class InstanceLifecycleError extends Error {}

// Loads the instance's plaintext passwords from rest-api (which holds the
// encryption key). Any failure becomes an InstanceLifecycleError so the start
// is refused with a clear message, the same way a decrypt failure was before.
async function loadStartSecrets(instance: Instance): Promise<InstanceSecrets & { obs_ws_password: string }> {
  let secrets: InstanceSecrets;
  try {
    secrets = await getInstanceSecrets(instance.id);
  } catch (err) {
    throw new InstanceLifecycleError(
      `Could not load the instance's passwords from rest-api: ${(err as Error).message}`,
    );
  }
  if (!secrets.obs_ws_password) {
    throw new InstanceLifecycleError("Instance is missing OBS WebSocket password.");
  }
  return { ...secrets, obs_ws_password: secrets.obs_ws_password };
}

// Brings up (or resumes) an instance's container: pulls its config/plugins,
// resolves its secrets, creates and starts the Docker container, and syncs
// status back to the DB. On failure, marks the instance "error" and cleans
// up any orphaned container -- mirrors the try/catch shape both routes had.
//
// Locked per-instance (see withInstanceLock) so this never overlaps with
// another restartInstance call, nor with a concurrent stop/delete, for the
// same instance -- every caller (the start routes, reconcileContainers'
// auto-restart, and gpu-xserver recovery) funnels through here, so guarding
// here covers all of them without each call site needing its own lock.
export async function restartInstance(instance: Instance): Promise<Instance> {
  return withInstanceLock(instance.id, () => doRestartInstance(instance));
}

// Marks the instance running against a container that already exists for it.
// Deliberately skips the config pull and password/stream-key injection: those
// write into the container's bind-mounted config dir, and rewriting it under a
// live OBS leaves the process on stale values (the obs-websocket password OBS
// loaded at boot no longer matches what the DB and dashboard hold).
async function adoptRunningContainer(instance: Instance, containerId: string): Promise<Instance> {
  log("info", "container already running for instance, adopting instead of recreating", {
    instanceId: instance.id,
    containerId,
  });
  const updated = await updateInstance(instance.id, { container_id: containerId, status: "running" });
  broadcastLifecycle(instance.user_id, instance.id, "started");
  return updated;
}

async function doRestartInstance(instance: Instance): Promise<Instance> {
  // Idempotency guard, checked before anything touches the config dir. The
  // row passed in may be stale (a start that queued on the lock behind another
  // start of the same instance), so Docker -- not the DB -- decides whether a
  // container already exists for this name.
  const existing = await findContainerByName(instance.container_name);
  if (existing?.running) return adoptRunningContainer(instance, existing.id);

  // Preconditions that refuse the start outright come before the "starting"
  // broadcast and before anything touches S3 or the config dir: a refusal
  // here leaves the instance exactly as it was, so other devices must not be
  // told it's coming up (there'd be no terminal "error"/"stopped" to clear it).
  const { obs_ws_password: obsWsPassword, vnc_password: vncPassword } = await loadStartSecrets(instance);
  // Throws StreamKeyNotGrantedError when the user has not connected Twitch;
  // every caller (user start, admin start, auto-resume) already treats a
  // throw here as a failed start.
  const streamKey = await requireStreamKey(instance.user_id);

  // Leading-edge signal: the box is coming up. Lets other devices show
  // "Starting…" during the provisioning/boot wait instead of nothing.
  broadcastLifecycle(instance.user_id, instance.id, "starting");

  if (existing) {
    // Exited/dead leftover (crash mid-start, stop that never got to remove).
    // Clear it so createContainer below doesn't fail on the name.
    log("warn", "removing stale non-running container before start", {
      instanceId: instance.id,
      containerId: existing.id,
    });
    await removeContainer(existing.id);
  }

  await Promise.all([
    pullObsConfig(instance.user_id, instance.id, instance.config_template ?? undefined).catch((e) =>
      log("warn", "obs config pull failed, starting with empty config", {
        instanceId: instance.id,
        error: (e as Error).message,
      })
    ),
    syncPlugins().catch((e) =>
      log("warn", "plugin sync failed, starting with existing local plugins", {
        instanceId: instance.id,
        error: (e as Error).message,
      })
    ),
  ]);

  await injectObsWsPassword(instance.id, obsWsPassword);
  if (streamKey) await injectStreamKey(instance.id, streamKey);

  let containerId: string | null = null;
  try {
    containerId = await createContainer({
      instanceId: instance.id,
      containerName: instance.container_name,
      resolution: instance.resolution,
      obsWsPassword,
      vncPassword,
      memory_mb: instance.memory_mb,
      cpu_quota: instance.cpu_quota,
      shm_size: instance.shm_size,
    });
    await startContainer(containerId);
    const updated = await updateInstance(instance.id, { container_id: containerId, status: "running" });
    // Covers every start path funnelling through here: user start, admin start,
    // reconcile auto-resume, and gpu-xserver recovery.
    broadcastLifecycle(instance.user_id, instance.id, "started");
    return updated;
  } catch (err) {
    log("error", "instance start failed", { instanceId: instance.id, error: (err as Error).message });
    if (containerId) {
      await removeContainer(containerId).catch((e) =>
        debug("docker", `cleanup of orphaned container ${containerId} failed: ${(e as Error).message}`)
      );
    }

    // Never mark a live instance "error": if a container for this instance
    // is running (ours was just removed above, so this is a different one
    // that appeared alongside this attempt), the instance is healthy --
    // report that instead of the failed create.
    const survivor = await findContainerByName(instance.container_name).catch(() => null);
    if (survivor?.running) {
      log("warn", "start failed but a running container exists for instance, adopting it", {
        instanceId: instance.id,
        containerId: survivor.id,
        error: (err as Error).message,
      });
      return adoptRunningContainer(instance, survivor.id);
    }

    await updateInstance(instance.id, { status: "error" });
    broadcastLifecycle(instance.user_id, instance.id, "error");
    throw err;
  }
}
