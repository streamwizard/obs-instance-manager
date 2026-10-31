import { docker, isApiStopping } from "@/clients/docker";
import { getInstanceByIdAdmin, updateInstanceByContainerId } from "@/clients/supabase";
import { broadcastLifecycle } from "@/clients/ws-server";
import { trackInstanceEvent } from "@/services/metrics/influx-metrics";
import { attachInstance, detachInstance } from "@/services/obs/obs-event-listener";
import { persistAndRemoveLocalConfig } from "@/services/storage/obs-config";
import { handleGpuXserverEvent, queueIfGpuCorrelated } from "@/services/docker/gpu-recovery";
import { withInstanceLock } from "@/utils/instance-lock";
import { debug, log } from "@/utils/logger";
import type { InstanceStatus } from "@/types";

const EVENT_RECONNECT_DELAY_MS = 5000;

// Live counterpart to reconcileContainers: subscribes to Docker's event
// stream so a container that dies between reconciliation runs (crash, OOM
// kill, manual `docker stop` outside the API) updates the DB immediately
// instead of waiting for the next restart. Also watches gpu-xserver's own
// die/start events to auto-resume instances that crashed because of it (see
// services/docker/gpu-recovery.ts). Reconnects on stream errors/EOF since a
// dropped connection would otherwise silently stop all live updates.
export function startEventListener(): void {
  docker.getEvents(
    { filters: JSON.stringify({ type: ["container"], event: ["die", "start"] }) },
    (err, stream) => {
      if (err || !stream) {
        log("error", "failed to attach docker event listener, retrying", {
          error: err?.message,
          retryMs: EVENT_RECONNECT_DELAY_MS,
        });
        setTimeout(startEventListener, EVENT_RECONNECT_DELAY_MS);
        return;
      }

      log("info", "docker event listener attached");

      stream.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          handleGpuXserverEvent(line).catch((e) =>
            debug("docker", `failed to handle gpu-xserver event: ${e?.message ?? e}`)
          );
          handleContainerDieEvent(line).catch((e) =>
            debug("docker", `failed to handle container die event: ${e?.message ?? e}`)
          );
          handleObsSceneWatchEvent(line).catch((e) =>
            debug("docker", `failed to handle obs scene watch event: ${e?.message ?? e}`)
          );
        }
      });

      stream.on("error", (streamErr: Error) => {
        log("warn", "docker event stream errored, reconnecting", {
          error: streamErr.message,
          retryMs: EVENT_RECONNECT_DELAY_MS,
        });
        setTimeout(startEventListener, EVENT_RECONNECT_DELAY_MS);
      });

      stream.on("end", () => {
        log("warn", "docker event stream ended, reconnecting", { retryMs: EVENT_RECONNECT_DELAY_MS });
        setTimeout(startEventListener, EVENT_RECONNECT_DELAY_MS);
      });
    }
  );
}

// Attaches/detaches the scene listener (services/obs/obs-event-listener.ts) as
// instance containers come and go. Deliberately its own handler rather than a
// branch inside handleContainerDieEvent: that one early-returns for containers
// marked via markApiStopping, so a detach placed there would leak a live socket
// on every ordinary /stop and /delete. Detaching is safe whoever initiated it.
async function handleObsSceneWatchEvent(rawLine: string): Promise<void> {
  const event = JSON.parse(rawLine);
  if (event.Action !== "start" && event.Action !== "die") return;

  const containerName: string = (event.Actor?.Attributes?.name ?? "").replace(/^\//, "");
  if (!containerName.startsWith("obs-instance-")) return;

  // Container names are `obs-instance-${instanceId}` (see services/instances/create-instance.ts),
  // so a detach needs no DB round trip.
  const instanceId = containerName.slice("obs-instance-".length);
  if (!instanceId) return;

  if (event.Action === "die") {
    detachInstance(instanceId);
    return;
  }

  // "start" fires well before OBS is listening (entrypoint.sh waits on Xorg
  // first); the listener's own backoff absorbs that.
  const instance = await getInstanceByIdAdmin(instanceId);
  if (!instance) return;
  attachInstance(instance);
}

async function handleContainerDieEvent(rawLine: string): Promise<void> {
  const event = JSON.parse(rawLine);
  // The event stream also carries "start" events (for gpu-xserver
  // recovery, see handleGpuXserverEvent/startEventListener) -- this handler
  // only cares about "die".
  if (event.Action !== "die") return;

  const containerName: string = (event.Actor?.Attributes?.name ?? "").replace(/^\//, "");
  if (!containerName.startsWith("obs-instance-")) return;

  const containerId: string | undefined = event.Actor?.ID;
  if (!containerId) return;

  if (isApiStopping(containerId)) {
    debug("docker", `skipping die-event handling for ${containerId}, an API route is already stopping it`);
    return;
  }

  const exitCode = Number(event.Actor?.Attributes?.exitCode ?? -1);
  // 0 = clean exit, 143 = SIGTERM (docker stop), both are normal stops.
  const status: InstanceStatus = exitCode === 0 || exitCode === 143 ? "stopped" : "error";

  const updated = await updateInstanceByContainerId(containerId, { status, container_id: null });
  if (!updated) return;

  // Out-of-band exit (crash, OOM, manual `docker stop`) -- API-initiated stops
  // are filtered out above via isApiStopping, so this only fires for
  // deaths the routes never see. updated is the only place user_id is in scope.
  broadcastLifecycle(updated.user_id, updated.id, status === "error" ? "error" : "stopped");

  log("info", "instance container exited, synced status", {
    instanceId: updated.id,
    containerId,
    exitCode,
    status,
  });

  // A crash right after gpu-xserver went down is queued for auto-resume (see
  // services/docker/gpu-recovery.ts).
  const gpuCorrelated = status === "error" && queueIfGpuCorrelated(updated);

  trackInstanceEvent(updated.node_id, updated.id, updated.user_id, status === "error" ? "crash" : "stopped", {
    exitCode,
    reason: gpuCorrelated ? "gpu_xserver_outage" : undefined,
  });

  // Push config to S3 for containers that died out-of-band (not via the
  // /stop route, which handles this itself). If container_id was already
  // null the record wasn't found above, so this only runs for genuine
  // out-of-band exits. Locked so it can't interleave with an autosave or a
  // start; a start that ran first (auto-resume, user) already owns the dir
  // again, so skip if the instance has a container by the time we get in.
  await withInstanceLock(updated.id, async () => {
    const current = await getInstanceByIdAdmin(updated.id);
    if (current?.container_id) {
      debug("docker", `skipping config push after exit for ${updated.id}, it was restarted`);
      return;
    }
    await persistAndRemoveLocalConfig(updated.user_id, updated.id);
  }).catch((e) =>
    log("warn", "obs config push failed after out-of-band container exit", {
      instanceId: updated.id,
      error: (e as Error).message,
    })
  );
}
