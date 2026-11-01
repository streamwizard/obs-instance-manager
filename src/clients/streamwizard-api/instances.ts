// obs_instances rows, read and written through rest-api.
import type { Instance } from "@/types";
// Import cycle with services/cache/instance-cache (it reads listNodeInstances from
// this module) — harmless: both sides only call across the boundary at
// runtime, never during module evaluation.
import { invalidateNodeInstances } from "@/services/cache/instance-cache";
import { forgetInstanceSecrets } from "@/services/cache/instance-secrets-cache";
import { StreamwizardApi, nullOn404 } from "./client";

/** Every instance hosted on this node. */
export async function listNodeInstances(): Promise<Instance[]> {
  const res = await StreamwizardApi.get<Instance[]>("/api/obs-nodes/instances");
  return res.data;
}

export async function countActiveInstances(): Promise<number> {
  const res = await StreamwizardApi.get<{ count: number }>("/api/obs-nodes/instances/active-count");
  return res.data.count;
}

/** Running instances on this node whose owner has lost their Cloud OBS plan. */
export async function listUnentitledInstanceIds(): Promise<string[]> {
  const res = await StreamwizardApi.get<{ instance_ids: string[] }>("/api/obs-nodes/instances/unentitled");
  return res.data.instance_ids;
}

export async function listUserInstances(userId: string): Promise<Instance[]> {
  const res = await StreamwizardApi.get<Instance[]>(`/api/obs-nodes/users/${userId}/instances`);
  return res.data;
}

/** The instance, only if `userId` owns it. */
export async function getInstanceById(instanceId: string, userId: string): Promise<Instance | null> {
  return nullOn404(() =>
    StreamwizardApi.get<Instance>(`/api/obs-nodes/instances/${instanceId}`, { params: { user_id: userId } }),
  );
}

/** The instance, whoever owns it. */
export async function getInstanceByIdAdmin(instanceId: string): Promise<Instance | null> {
  return nullOn404(() => StreamwizardApi.get<Instance>(`/api/obs-nodes/instances/${instanceId}`));
}

// The four mutations below are the single choke point through which every
// change to this node's instances flows (provision, start/stop, the crash
// watchdog, delete). Each one invalidates the cached instance list on
// success, which is what makes services/cache/instance-cache correct rather
// than merely fresh-ish — see the header comment there before adding a
// mutation path that bypasses this file.

// storage_quota_mb / used_storage_bytes are DB-defaulted (see migration) and
// never set by the node at create time, so they're omitted from the payload.
//
// nodeToken is the user's instances:create token from the web app. rest-api
// takes user_id from this body, and the token is what proves that user asked
// for the instance (SW-473); our own API key can't.
//
// obs_ws_password is plaintext: rest-api encrypts it and generates the VNC
// password itself. Read both back with getInstanceSecrets().
export async function insertInstance(
  instance: Omit<Instance, "created_at" | "storage_quota_mb" | "used_storage_bytes"> & { obs_ws_password: string },
  nodeToken: string | null,
): Promise<Instance> {
  const res = await StreamwizardApi.post<Instance>("/api/obs-nodes/instances", instance, {
    headers: nodeToken ? { "X-Node-Token": nodeToken } : undefined,
  });
  invalidateNodeInstances();
  return res.data;
}

export async function updateInstance(instanceId: string, fields: Partial<Instance>): Promise<Instance> {
  const res = await StreamwizardApi.patch<Instance>(`/api/obs-nodes/instances/${instanceId}`, fields);
  invalidateNodeInstances();
  return res.data;
}

export async function updateInstanceByContainerId(
  containerId: string,
  fields: Partial<Instance>,
): Promise<Instance | null> {
  const updated = await nullOn404(() =>
    StreamwizardApi.patch<Instance>(`/api/obs-nodes/instances/by-container/${containerId}`, fields),
  );
  if (updated) invalidateNodeInstances();
  return updated;
}

export async function deleteInstance(instanceId: string): Promise<void> {
  await StreamwizardApi.delete(`/api/obs-nodes/instances/${instanceId}`);
  invalidateNodeInstances();
  forgetInstanceSecrets(instanceId);
}
