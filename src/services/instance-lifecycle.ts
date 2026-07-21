// Shared "bring this instance's container up" flow, used by the end-user
// POST /:id/start route, the admin POST /instances/:id/start route, and
// boot-time/event-driven recovery (reconcileContainers, gpu-xserver restart
// handling in docker.ts) -- previously this logic was duplicated between
// instances.ts and admin.ts, which had already drifted (admin.ts's copy was
// missing the syncPlugins()/stream-key-injection steps the end-user route had).
import { createContainer, removeContainer, startContainer } from "../clients/docker";
import { updateInstance } from "../clients/supabase";
import { broadcastLifecycle } from "../clients/ws-server";
import { decryptPassword, encryptPassword, generateVncPassword } from "../utils/crypto";
import { debug, log } from "../utils/logger";
import { withInstanceLock } from "../utils/instance-lock";
import { pullObsConfig, injectObsWsPassword, injectStreamKey } from "./obs-config";
import { syncPlugins } from "./plugins";
import { getStreamKey } from "./twitch";
import type { Instance } from "../types";

export class InstanceLifecycleError extends Error {}

// Resolves the plaintext VNC password for this instance, generating and
// persisting a new one if this instance predates the VNC-password feature
// (vnc_password_ciphertext is null on rows created before this change).
// Exported for the novnc ws-ticket routes: the RFB handshake happens
// directly between the browser's VNC client and x11vnc (the API's WS proxy
// is a blind byte relay), so the browser needs this password out-of-band --
// there's no other way for it to authenticate the connection.
export async function resolveVncPassword(instance: Instance): Promise<string> {
  if (instance.vnc_password_ciphertext && instance.vnc_password_iv && instance.vnc_password_tag) {
    return decryptPassword(instance.vnc_password_ciphertext, instance.vnc_password_iv, instance.vnc_password_tag);
  }

  const plaintext = generateVncPassword();
  const encrypted = encryptPassword(plaintext);
  await updateInstance(instance.id, {
    vnc_password_ciphertext: encrypted.ciphertext,
    vnc_password_iv: encrypted.iv,
    vnc_password_tag: encrypted.tag,
  });
  log("info", "generated missing VNC password for instance", { instanceId: instance.id });
  return plaintext;
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

async function doRestartInstance(instance: Instance): Promise<Instance> {
  // Leading-edge signal: the box is coming up. Lets other devices show
  // "Starting…" during the provisioning/boot wait instead of nothing.
  broadcastLifecycle(instance.user_id, instance.id, "starting");

  await Promise.all([
    pullObsConfig(instance.user_id, instance.id).catch((e) =>
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

  if (!instance.obs_ws_password_ciphertext || !instance.obs_ws_password_iv || !instance.obs_ws_password_tag) {
    throw new InstanceLifecycleError("Instance is missing OBS WebSocket password.");
  }
  const obsWsPassword = decryptPassword(
    instance.obs_ws_password_ciphertext,
    instance.obs_ws_password_iv,
    instance.obs_ws_password_tag,
  );

  const vncPassword = await resolveVncPassword(instance);

  await injectObsWsPassword(instance.id, obsWsPassword);

  const streamKey = await getStreamKey(instance.user_id);
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
    await updateInstance(instance.id, { status: "error" });
    broadcastLifecycle(instance.user_id, instance.id, "error");
    if (containerId) {
      await removeContainer(containerId).catch((e) =>
        debug("docker", `cleanup of orphaned container ${containerId} failed: ${(e as Error).message}`)
      );
    }
    throw err;
  }
}
