import {
  apiCountActiveInstances,
  apiDeleteInstance,
  apiGetInstanceById,
  apiGetInstanceByIdAdmin,
  apiGetNode,
  apiGetSubscriptionLimits,
  apiInsertInstance,
  apiIsAdmin,
  apiListNodeInstances,
  apiListUserInstances,
  apiUpdateInstance,
  apiUpdateInstanceByContainerId,
} from "./streamwizard-api";
import type { CloudObsPlanLimits, Instance, Node } from "../types";
// Import cycle with services/instance-cache (it reads listNodeInstances from
// this module) — harmless: both sides only call across the boundary at
// runtime, never during module evaluation.
import { invalidateNodeInstances } from "../services/instance-cache";

export async function isAdmin(userId: string): Promise<boolean> {
  return apiIsAdmin(userId);
}

export async function getNode(_nodeId: string): Promise<Node> {
  return apiGetNode();
}

export async function listUserInstances(userId: string): Promise<Instance[]> {
  return apiListUserInstances(userId);
}

export async function listNodeInstances(_nodeId: string): Promise<Instance[]> {
  return apiListNodeInstances();
}

export async function getInstanceById(instanceId: string, userId: string): Promise<Instance | null> {
  return apiGetInstanceById(instanceId, userId);
}

export async function getInstanceByIdAdmin(instanceId: string): Promise<Instance | null> {
  return apiGetInstanceByIdAdmin(instanceId);
}

// The four instance mutations below are the single choke point through which
// every change to this node's instances flows (provision, start/stop, the
// crash watchdog, delete). Each one invalidates the cached instance list on
// success, which is what makes services/instance-cache correct rather than
// merely fresh-ish — see the header comment there before adding a mutation
// path that bypasses this file.

export async function insertInstance(
  instance: Omit<Instance, "created_at" | "storage_quota_mb" | "used_storage_bytes">,
): Promise<Instance> {
  const created = await apiInsertInstance(instance);
  invalidateNodeInstances();
  return created;
}

export async function updateInstance(instanceId: string, fields: Partial<Instance>): Promise<Instance> {
  const updated = await apiUpdateInstance(instanceId, fields);
  invalidateNodeInstances();
  return updated;
}

export async function updateInstanceByContainerId(containerId: string, fields: Partial<Instance>): Promise<Instance | null> {
  const updated = await apiUpdateInstanceByContainerId(containerId, fields);
  if (updated) invalidateNodeInstances();
  return updated;
}

export async function deleteInstance(instanceId: string): Promise<void> {
  await apiDeleteInstance(instanceId);
  invalidateNodeInstances();
}

export async function countActiveInstances(_nodeId: string): Promise<number> {
  return apiCountActiveInstances();
}

export async function getSubscriptionLimits(subscriptionId: string): Promise<CloudObsPlanLimits> {
  return apiGetSubscriptionLimits(subscriptionId);
}
