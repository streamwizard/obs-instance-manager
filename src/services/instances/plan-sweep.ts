// Stops running instances whose owner no longer has a Cloud OBS plan that may
// run them: revoked, set to past_due, or a grant whose expiry passed (nothing
// fires an event for that last one). rest-api decides who that is; a failed
// lookup throws, so a rest-api outage stops nothing.
import { getInstanceByIdAdmin, listUnentitledInstanceIds } from "@/clients/supabase";
import { stopInstance } from "@/services/instances/stop-instance";
import { isInstanceLocked } from "@/utils/instance-lock";
import { PLAN_SWEEP_INTERVAL_MS } from "@/utils/constants";
import { log } from "@/utils/logger";

// Stops instances whose owner lost their Cloud OBS plan (see PLAN_SWEEP_INTERVAL_MS).
export function startPlanSweep(nodeId: string): void {
  setInterval(() => {
    sweepUnentitledInstances(nodeId).catch((err) =>
      log("error", "plan sweep failed", { error: (err as Error).message }),
    );
  }, PLAN_SWEEP_INTERVAL_MS);
}

export async function sweepUnentitledInstances(nodeId: string): Promise<string[]> {
  const ids = await listUnentitledInstanceIds(nodeId);
  const stopped: string[] = [];
  for (const id of ids) {
    // Already starting or stopping: leave it to that operation. The next pass
    // picks it up if it is still running then.
    if (isInstanceLocked(id)) continue;
    try {
      const instance = await getInstanceByIdAdmin(id);
      if (!instance?.container_id || instance.status !== "running") continue;
      await stopInstance(instance);
      log("info", "stopped instance without an active plan", { instanceId: id, userId: instance.user_id });
      stopped.push(id);
    } catch (err) {
      log("error", "plan sweep failed to stop instance", { instanceId: id, error: (err as Error).message });
    }
  }
  return stopped;
}
