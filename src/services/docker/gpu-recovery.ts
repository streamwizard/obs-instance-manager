import { getInstanceByIdAdmin } from "@/clients/supabase";
import { restartInstance } from "@/services/instances/instance-lifecycle";
import { trackInstanceEvent } from "@/services/metrics/influx-metrics";
import { RESTART_STAGGER_MS } from "@/utils/constants";
import { log } from "@/utils/logger";
import type { Instance } from "@/types";

// The one real GPU-bound Xorg, shared by every instance via VirtualGL (see
// docker-compose.yml). If it restarts, every instance's render connection to
// it dies and OBS crashes inside each of them -- container name is fixed
// (one compose stack = one machine = one GPU), so this can be matched by name.
const GPU_XSERVER_CONTAINER_NAME = "gpu-xserver";

// If an obs-instance-* container dies within this long after gpu-xserver
// itself died, its crash is attributed to the gpu-xserver outage and it's
// queued for auto-resume once gpu-xserver is back, rather than left "error"
// for an operator to notice.
const GPU_XSERVER_DIE_CORRELATION_WINDOW_MS = 15_000;

// Grace period after gpu-xserver's container "start" event before attempting
// to resume affected instances -- entrypoint.sh's own internal Xorg-readiness
// wait (see ROLE=gpu-xserver) budgets up to ~20s, so this leaves margin for
// the shared X server to actually be usable before instances try to attach.
const GPU_XSERVER_RECOVERY_GRACE_MS = 25_000;

let gpuXserverDownSince: number | null = null;
// instanceId -> nodeId, so recovery can look the instance up again (state
// may have moved on) without needing to keep a live Instance object around.
const pendingGpuRecovery = new Map<string, string>();

// Called by the die handler for an instance that crashed (status "error").
// If this died shortly after gpu-xserver itself went down, its crash is
// almost certainly a side effect of losing the shared X/VirtualGL
// connection rather than something wrong with the instance itself -- queue
// it for auto-resume once gpu-xserver is confirmed back. Returns whether it
// was attributed to the outage.
export function queueIfGpuCorrelated(instance: Pick<Instance, "id" | "node_id">): boolean {
  const correlated =
    gpuXserverDownSince !== null &&
    Date.now() - gpuXserverDownSince <= GPU_XSERVER_DIE_CORRELATION_WINDOW_MS;
  if (!correlated) return false;

  pendingGpuRecovery.set(instance.id, instance.node_id);
  log("info", "instance crash attributed to gpu-xserver outage, queued for auto-resume", {
    instanceId: instance.id,
  });
  return true;
}

// Tracks gpu-xserver's own lifecycle (die/start) to correlate and auto-heal
// the instance crashes it causes -- see GPU_XSERVER_CONTAINER_NAME,
// GPU_XSERVER_DIE_CORRELATION_WINDOW_MS and queueIfGpuCorrelated below.
export async function handleGpuXserverEvent(rawLine: string): Promise<void> {
  const event = JSON.parse(rawLine);

  const containerName: string = (event.Actor?.Attributes?.name ?? "").replace(/^\//, "");
  if (containerName !== GPU_XSERVER_CONTAINER_NAME) return;

  if (event.Action === "die") {
    gpuXserverDownSince = Date.now();
    log("warn", "gpu-xserver died, instance crashes over the next window will be attributed to it", {
      correlationWindowMs: GPU_XSERVER_DIE_CORRELATION_WINDOW_MS,
    });
    return;
  }

  if (event.Action !== "start") return;

  log("info", "gpu-xserver restarted, will attempt to resume affected instances after grace period", {
    graceMs: GPU_XSERVER_RECOVERY_GRACE_MS,
    pending: pendingGpuRecovery.size,
  });
  gpuXserverDownSince = null;

  setTimeout(() => {
    recoverInstancesAfterGpuXserverRestart().catch((e) =>
      log("error", "gpu-xserver recovery pass failed", { error: (e as Error).message })
    );
  }, GPU_XSERVER_RECOVERY_GRACE_MS);
}

async function recoverInstancesAfterGpuXserverRestart(): Promise<void> {
  if (pendingGpuRecovery.size === 0) return;
  const instanceIds = [...pendingGpuRecovery.keys()];
  pendingGpuRecovery.clear();

  for (const instanceId of instanceIds) {
    const instance = await getInstanceByIdAdmin(instanceId);
    // Already handled some other way (manually restarted, deleted, etc.)
    // since it was queued -- nothing to do.
    if (!instance || instance.status === "running") continue;

    try {
      await restartInstance(instance);
      log("info", "instance auto-resumed after gpu-xserver recovery", { instanceId });
      trackInstanceEvent(instance.node_id, instanceId, instance.user_id, "auto_restarted", {
        reason: "gpu_xserver_recovery",
      });
    } catch (e) {
      log("error", "instance auto-resume after gpu-xserver recovery failed", {
        instanceId,
        error: (e as Error).message,
      });
      trackInstanceEvent(instance.node_id, instanceId, instance.user_id, "restart_failed", {
        reason: "gpu_xserver_recovery",
      });
    }
    await new Promise((resolve) => setTimeout(resolve, RESTART_STAGGER_MS));
  }
}
