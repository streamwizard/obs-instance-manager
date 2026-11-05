// Lifecycle and scene events for one of this node's instances. rest-api checks
// the instance is on this node, looks up its owner and forwards the event to
// that user's ws-server room. The node holds no ws-server credential: that
// secret works for every user, so it stays on rest-api.
//
// "deleted" isn't sent from here: rest-api sends it itself when the node
// deletes the row (DELETE /api/obs-nodes/instances/:id).
import { debug, log } from "@/utils/logger";
import { StreamwizardApi, pathSegment } from "./client";

export type LifecycleAction = "starting" | "started" | "stopping" | "stopped" | "error";

type InstanceEvent =
  | { type: "lifecycle"; action: LifecycleAction; at: string }
  | { type: "scene_changed"; sceneName: string; sceneUuid: string; at: string };

// Fire-and-forget: never awaited and never throws into a caller. A failed
// push must not fail or slow a container start/stop, nor kill a scene
// listener. The DB / OBS stays the source of truth; a dropped event just means
// a browser learns the new state on its next fetch.
function postEvent(instanceId: string, event: InstanceEvent): void {
  StreamwizardApi.post(`/api/obs-nodes/instances/${pathSegment(instanceId)}/events`, event)
    .then(() => debug("instance-events", `${event.type} sent for ${instanceId}`))
    .catch((error) =>
      log("warn", `${event.type} event failed`, { instanceId, error: (error as Error).message }),
    );
}

export function broadcastLifecycle(instanceId: string, action: LifecycleAction): void {
  postEvent(instanceId, { type: "lifecycle", action, at: new Date().toISOString() });
}

// The instance's program scene actually changed (observed, not commanded).
// Callers dedupe on sceneUuid before calling -- OBS re-emits during transitions.
export function broadcastSceneChanged(instanceId: string, sceneName: string, sceneUuid: string): void {
  postEvent(instanceId, { type: "scene_changed", sceneName, sceneUuid, at: new Date().toISOString() });
}
