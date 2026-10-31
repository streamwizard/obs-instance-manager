import { docker, getContainerStatus } from "@/clients/docker";
import { updateInstance } from "@/clients/supabase";
import { StreamwizardApi } from "@/clients/streamwizard-api";
import { broadcastLifecycle } from "@/clients/ws-server";
import { refreshNodeInstances } from "@/services/cache/instance-cache";
import { restartInstance } from "@/services/instances/instance-lifecycle";
import { trackInstanceEvent } from "@/services/metrics/influx-metrics";
import { RESTART_STAGGER_MS } from "@/utils/constants";
import { debug, log } from "@/utils/logger";

export interface ReconcileInstanceResult {
  instance_id: string;
  action: "marked_error" | "marked_running" | "marked_stopped" | "restarted" | "restart_failed" | "no_change";
}

// Boot-time reconciliation: cross-checks running OBS containers against
// the DB so a restarted API process doesn't operate on stale state (e.g.
// after a crash mid-create, or a container stopped/removed out-of-band).
// Instances the DB still expects to be running are auto-resumed (see
// restartInstance in instance-lifecycle.ts) rather than just marked error,
// so a node reboot or manager crash doesn't strand every paying customer's
// session until an operator notices.
export async function reconcileContainers(nodeId: string): Promise<void> {
  // Live read (and boot-time cache warm-up): the process just started, so its
  // memory is empty by definition — reconcile must see the database's truth.
  const nodeInstances = await refreshNodeInstances();
  const knownContainerIds = new Set(
    nodeInstances.map((i) => i.container_id).filter((id): id is string => !!id)
  );

  const dockerContainers = await docker.listContainers({
    all: true,
    filters: { name: ["obs-instance-"] },
  });

  const orphanedContainers: string[] = [];

  for (const container of dockerContainers) {
    if (!knownContainerIds.has(container.Id)) {
      log("warn", "orphaned container with no matching DB record", {
        containerId: container.Id,
        names: container.Names,
      });
      orphanedContainers.push(container.Id);
    }
  }

  const instanceResults: ReconcileInstanceResult[] = [];

  for (const instance of nodeInstances) {
    if (!instance.container_id) continue;

    const status = await getContainerStatus(instance.container_id);
    if (status === "unknown") continue;

    if (status === "not_found" && instance.status === "running") {
      log("warn", "instance container missing but DB expects it running, attempting restart", {
        instanceId: instance.id,
      });
      try {
        await restartInstance(instance);
        log("info", "instance auto-resumed after reconcile", { instanceId: instance.id });
        instanceResults.push({ instance_id: instance.id, action: "restarted" });
        trackInstanceEvent(nodeId, instance.id, instance.user_id, "auto_restarted", { reason: "reconcile" });
      } catch (e) {
        log("error", "instance auto-resume failed, marked error", {
          instanceId: instance.id,
          error: (e as Error).message,
        });
        instanceResults.push({ instance_id: instance.id, action: "restart_failed" });
        trackInstanceEvent(nodeId, instance.id, instance.user_id, "restart_failed", { reason: "reconcile" });
      }
      await new Promise((resolve) => setTimeout(resolve, RESTART_STAGGER_MS));
    } else if (status === "not_found" && instance.status !== "error") {
      await updateInstance(instance.id, { status: "error" });
      broadcastLifecycle(instance.user_id, instance.id, "error");
      log("warn", "instance container missing, marked error", { instanceId: instance.id });
      instanceResults.push({ instance_id: instance.id, action: "marked_error" });
      trackInstanceEvent(nodeId, instance.id, instance.user_id, "crash", { reason: "reconcile" });
    } else if (status === "running" && instance.status !== "running") {
      await updateInstance(instance.id, { status: "running" });
      broadcastLifecycle(instance.user_id, instance.id, "started");
      log("info", "instance container running, resynced status", { instanceId: instance.id });
      instanceResults.push({ instance_id: instance.id, action: "marked_running" });
    } else if (status === "stopped" && instance.status === "running") {
      await updateInstance(instance.id, { status: "stopped" });
      broadcastLifecycle(instance.user_id, instance.id, "stopped");
      log("info", "instance container stopped, resynced status", { instanceId: instance.id });
      instanceResults.push({ instance_id: instance.id, action: "marked_stopped" });
    } else {
      instanceResults.push({ instance_id: instance.id, action: "no_change" });
    }
  }

  await reportReconcile(orphanedContainers, instanceResults);
}

async function reportReconcile(
  orphanedContainers: string[],
  instances: ReconcileInstanceResult[]
): Promise<void> {
  if (!process.env.REST_API_URL) {
    debug("reconcile", "REST_API_URL not set, skipping reconcile report");
    return;
  }

  try {
    await StreamwizardApi.post("/api/nodes/reconcile", {
      reconciled_at: new Date().toISOString(),
      orphaned_containers: orphanedContainers,
      instances,
    });
  } catch {
    // error already logged by the response interceptor
  }
}
