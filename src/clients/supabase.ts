import {
  apiCountActiveInstances,
  apiDeleteInstance,
  apiGetInstanceById,
  apiGetInstanceByIdAdmin,
  apiGetNode,
  apiInsertInstance,
  apiIsAdmin,
  apiListNodeInstances,
  apiListUserInstances,
  apiSumAllocatedVram,
  apiUpdateInstance,
  apiUpdateInstanceByContainerId,
} from "./streamwizard-api";
import type { Instance, Node } from "../types";

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

export async function insertInstance(instance: Omit<Instance, "created_at">): Promise<Instance> {
  return apiInsertInstance(instance);
}

export async function updateInstance(instanceId: string, fields: Partial<Instance>): Promise<Instance> {
  return apiUpdateInstance(instanceId, fields);
}

export async function updateInstanceByContainerId(containerId: string, fields: Partial<Instance>): Promise<Instance | null> {
  return apiUpdateInstanceByContainerId(containerId, fields);
}

export async function deleteInstance(instanceId: string): Promise<void> {
  return apiDeleteInstance(instanceId);
}

export async function sumAllocatedVram(_nodeId: string): Promise<number> {
  return apiSumAllocatedVram();
}

export async function countActiveInstances(_nodeId: string): Promise<number> {
  return apiCountActiveInstances();
}
