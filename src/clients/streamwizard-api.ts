import axios from "axios";
import { debug, log } from "../utils/logger";
import type { CloudObsPlanLimits, Instance, Node } from "../types";

const apiUrl = process.env.REST_API_URL;
const nodeApiKey = process.env.NODE_API_KEY;

if (!apiUrl || !nodeApiKey) {
  throw new Error("REST_API_URL and NODE_API_KEY must be set");
}

// Everything on this instance is small JSON — media uploads go straight to S3 —
// so no request has a reason to run long. The timeout matters because callers
// now share responses through node-cache's single-flight: without it one hung
// socket would wedge every waiting consumer instead of just its own call.
const REQUEST_TIMEOUT_MS = 15_000;

export const StreamwizardApi = axios.create({
  baseURL: apiUrl,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${nodeApiKey}`,
  },
});

StreamwizardApi.interceptors.request.use((config) => {
  debug("rest-api", `--> ${config.method?.toUpperCase()} ${config.url}`);
  return config;
});

StreamwizardApi.interceptors.response.use(
  (response) => {
    debug("rest-api", `<-- ${response.status} ${response.config.url}`);
    return response;
  },
  (error) => {
    const status = error.response?.status;
    const url = error.config?.url;
    log("warn", "rest-api request failed", { status, url, message: error.message });
    return Promise.reject(error);
  }
);

export async function apiGetNode(): Promise<Node> {
  const res = await StreamwizardApi.get<Node>("/api/nodes/me");
  return res.data;
}

export async function apiListNodeInstances(): Promise<Instance[]> {
  const res = await StreamwizardApi.get<Instance[]>("/api/nodes/instances");
  return res.data;
}

export async function apiCountActiveInstances(): Promise<number> {
  const res = await StreamwizardApi.get<{ count: number }>("/api/nodes/instances/active-count");
  return res.data.count;
}

export async function apiGetInstanceById(instanceId: string, userId: string): Promise<Instance | null> {
  try {
    const res = await StreamwizardApi.get<Instance>(`/api/nodes/instances/${instanceId}`, {
      params: { user_id: userId },
    });
    return res.data;
  } catch (err: any) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}

export async function apiGetInstanceByIdAdmin(instanceId: string): Promise<Instance | null> {
  try {
    const res = await StreamwizardApi.get<Instance>(`/api/nodes/instances/${instanceId}`);
    return res.data;
  } catch (err: any) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}

// storage_quota_mb / used_storage_bytes are DB-defaulted (see migration) and
// never set by the node at create time, so they're omitted from the payload.
export async function apiInsertInstance(
  instance: Omit<Instance, "created_at" | "storage_quota_mb" | "used_storage_bytes">,
): Promise<Instance> {
  const res = await StreamwizardApi.post<Instance>("/api/nodes/instances", instance);
  return res.data;
}

export async function apiUpdateInstance(instanceId: string, fields: Partial<Instance>): Promise<Instance> {
  const res = await StreamwizardApi.patch<Instance>(`/api/nodes/instances/${instanceId}`, fields);
  return res.data;
}

export async function apiUpdateInstanceByContainerId(containerId: string, fields: Partial<Instance>): Promise<Instance | null> {
  try {
    const res = await StreamwizardApi.patch<Instance>(`/api/nodes/instances/by-container/${containerId}`, fields);
    return res.data;
  } catch (err: any) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}

export async function apiDeleteInstance(instanceId: string): Promise<void> {
  await StreamwizardApi.delete(`/api/nodes/instances/${instanceId}`);
}

export async function apiListUserInstances(userId: string): Promise<Instance[]> {
  const res = await StreamwizardApi.get<Instance[]>(`/api/nodes/users/${userId}/instances`);
  return res.data;
}

export async function apiIsAdmin(userId: string): Promise<boolean> {
  const res = await StreamwizardApi.get<{ is_admin: boolean }>(`/api/nodes/users/${userId}/is-admin`);
  return res.data.is_admin;
}

export async function apiGetSubscriptionLimits(subscriptionId: string): Promise<CloudObsPlanLimits> {
  const res = await StreamwizardApi.get<CloudObsPlanLimits>(`/api/nodes/subscriptions/${subscriptionId}/limits`);
  return res.data;
}

export async function apiGetStreamKey(userId: string): Promise<string | null> {
  const res = await StreamwizardApi.get<{ key: string | null }>(`/api/nodes/users/${userId}/stream-key`);
  return res.data.key;
}
