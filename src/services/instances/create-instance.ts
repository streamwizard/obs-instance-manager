// Provisioning flow behind POST /instances: capacity checks, row insert,
// stream-key lookup, config/plugin pull, then container create + start.
import {
  countActiveInstances,
  deleteInstance,
  getSubscriptionLimits,
  insertInstance,
  updateInstance,
} from "@/clients/supabase";
import { createContainer, removeContainer, startContainer } from "@/clients/docker";
import { broadcastLifecycle } from "@/clients/ws-server";
import { refreshNode } from "@/services/cache/node-cache";
import { pullObsConfig, injectStreamKey, injectObsWsPassword } from "@/services/storage/obs-config";
import { syncPlugins } from "@/services/storage/plugins";
import { requireStreamKey } from "@/services/instances/twitch";
import { encryptPassword, generateVncPassword } from "@/utils/crypto";
import { debug, log } from "@/utils/logger";
import type { Instance } from "@/types";

// A request the node refuses before anything is provisioned (bad
// subscription, node at capacity). Carries the HTTP status for the route.
export class CreateInstanceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
  }
}

// The row exists but bringing the container up failed. The instance has
// already been marked "error" and any orphaned container removed.
export class InstanceProvisionError extends Error {}

export interface CreateInstanceInput {
  subscriptionId: string;
  template?: string;
  obsWsPassword: string;
  obsWsPasswordCiphertext: string | null;
  obsWsPasswordIv: string | null;
  obsWsPasswordTag: string | null;
  // The caller's instances:create node token, forwarded to rest-api so it can
  // check the user asked for this instance (SW-473). null for a session JWT.
  nodeToken: string | null;
}

// Throws CreateInstanceError (refused up front), StreamKeyNotGrantedError
// (user hasn't connected Twitch; the row is removed again) or
// InstanceProvisionError (container bring-up failed).
export async function createInstance(userId: string, input: CreateInstanceInput): Promise<Instance> {
  const { subscriptionId, template, obsWsPassword } = input;

  // refreshNode, not the cached read: max_instances/max_encoder_sessions gate
  // authorization here rather than feeding telemetry, so an admin raising
  // capacity to unblock someone must take effect on the very next create — not
  // whenever the TTL happens to lapse. Creates are rare and rate-limited, so
  // the live read costs nothing.
  const [node, planLimits] = await Promise.all([
    refreshNode(),
    getSubscriptionLimits(subscriptionId),
  ]);

  if (!planLimits) {
    throw new CreateInstanceError("Subscription not found or inactive", 400);
  }

  const activeCount = await countActiveInstances(node.id);
  if (activeCount >= node.max_instances) {
    throw new CreateInstanceError("Node has reached max_instances capacity", 409);
  }

  // Consumer NVIDIA drivers cap concurrent NVENC sessions (8 as of the 500+
  // driver series) independent of VRAM headroom -- Quadro/RTX-A cards have no
  // such cap, which is why this is a per-node config value (null = unlimited)
  // rather than a hardcoded constant. One instance == one NVENC session in
  // this architecture, so activeCount (already computed above) is exact.
  if (node.max_encoder_sessions !== null && activeCount >= node.max_encoder_sessions) {
    throw new CreateInstanceError("Node has reached max_encoder_sessions capacity", 409);
  }

  // No VRAM ledger check here: plan vram_mb allocations are far more
  // conservative than real usage (~4 GB booked vs ~300 MB measured per
  // streaming instance), so enforcing the sum against total_vram_mb starved
  // nodes long before actual VRAM pressure. vram_allocated_mb is still
  // recorded on the row for display; max_instances and max_encoder_sessions
  // remain the capacity guards.
  const instanceId = crypto.randomUUID();
  const containerName = `obs-instance-${instanceId}`;

  // Generated and encrypted server-side (unlike obsWsPassword, which the
  // client generates/encrypts today) since the VNC password never needs to
  // be seen by the panel -- x11vnc's RFB auth is purely an internal
  // obs-net-isolation measure, not something the end user interacts with.
  const vncPassword = generateVncPassword();
  const encryptedVncPassword = encryptPassword(vncPassword);

  await insertInstance({
    id: instanceId,
    user_id: userId,
    node_id: node.id,
    container_id: null,
    container_name: containerName,
    resolution: planLimits.resolution,
    status: "creating",
    vram_allocated_mb: planLimits.vram_mb,
    memory_mb: planLimits.memory_mb,
    cpu_quota: planLimits.cpu_quota,
    shm_size: planLimits.shm_size,
    config_template: planLimits.config_template ?? null,
    subscription_id: subscriptionId,
    obs_ws_password_ciphertext: input.obsWsPasswordCiphertext,
    obs_ws_password_iv: input.obsWsPasswordIv,
    obs_ws_password_tag: input.obsWsPasswordTag,
    vnc_password_ciphertext: encryptedVncPassword.ciphertext,
    vnc_password_iv: encryptedVncPassword.iv,
    vnc_password_tag: encryptedVncPassword.tag,
  }, input.nodeToken);

  // After the row insert, not before: rest-api only releases a user's stream
  // key to a node that already hosts an instance for them (403 otherwise), so
  // a first-ever create has to exist as a row before the key can be looked up.
  // A refusal (or a lookup failure) removes the row again so nothing is left
  // behind in "creating" -- an instance that boots without the user's stream
  // key is useless, so the dashboard sends them to Twitch first.
  let streamKey: string | null;
  try {
    streamKey = await requireStreamKey(userId);
  } catch (err) {
    await deleteInstance(instanceId).catch((e) =>
      log("warn", "failed to remove instance row after stream key refusal", {
        instanceId,
        error: (e as Error).message,
      })
    );
    throw err;
  }

  // Leading-edge signal for the fresh-launch flow (status "creating"): show
  // "Starting…" on every device while the container is provisioned.
  broadcastLifecycle(userId, instanceId, "starting");

  let containerId: string | null = null;
  try {
    await Promise.all([
      pullObsConfig(userId, instanceId, planLimits.config_template ?? template).catch((e) =>
        log("warn", "obs config pull failed, starting with empty config", {
          instanceId,
          error: (e as Error).message,
        })
      ),
      syncPlugins().catch((e) =>
        log("warn", "plugin sync failed, starting with existing local plugins", {
          instanceId,
          error: (e as Error).message,
        })
      ),
    ]);

    await injectObsWsPassword(instanceId, obsWsPassword);

    if (streamKey) await injectStreamKey(instanceId, streamKey);

    containerId = await createContainer({
      instanceId,
      containerName,
      resolution: planLimits.resolution,
      obsWsPassword,
      vncPassword,
      memory_mb: planLimits.memory_mb,
      cpu_quota: planLimits.cpu_quota,
      shm_size: planLimits.shm_size,
    });
    await startContainer(containerId);

    const updated = await updateInstance(instanceId, {
      container_id: containerId,
      status: "running",
    });

    broadcastLifecycle(userId, instanceId, "started");
    return updated;
  } catch (err) {
    log("error", "instance create failed", { instanceId, error: (err as Error).message });
    await updateInstance(instanceId, { status: "error" });
    broadcastLifecycle(userId, instanceId, "error");
    if (containerId) {
      await removeContainer(containerId).catch((e) =>
        debug("docker", `cleanup of orphaned container ${containerId} failed: ${(e as Error).message}`),
      );
    }
    throw new InstanceProvisionError((err as Error).message, { cause: err });
  }
}
