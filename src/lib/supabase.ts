import { createClient } from "@supabase/supabase-js";
import { debug } from "./logger";
import type { Instance, InstanceStatus, Node } from "../types";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}

export const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Times and logs every query under the "db" debug scope, on success and failure.
async function logged<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    debug("db", `${label} ok (${(performance.now() - start).toFixed(1)}ms)`);
    return result;
  } catch (err) {
    debug("db", `${label} failed (${(performance.now() - start).toFixed(1)}ms)`, err);
    throw err;
  }
}

export async function isAdmin(userId: string): Promise<boolean> {
  return logged(`isAdmin(${userId})`, async () => {
    const { data, error } = await supabase
      .from("user_roles")
      .select("id")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    if (error) throw error;
    return !!data;
  });
}

export async function getNode(nodeId: string): Promise<Node> {
  return logged(`getNode(${nodeId})`, async () => {
    const { data, error } = await supabase
      .from("obs_nodes")
      .select("*")
      .eq("id", nodeId)
      .single();
    if (error) throw error;
    return data as Node;
  });
}

export async function listUserInstances(userId: string): Promise<Instance[]> {
  return logged(`listUserInstances(${userId})`, async () => {
    const { data, error } = await supabase
      .from("obs_instances")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data as Instance[];
  });
}

export async function listNodeInstances(nodeId: string): Promise<Instance[]> {
  return logged(`listNodeInstances(${nodeId})`, async () => {
    const { data, error } = await supabase
      .from("obs_instances")
      .select("*")
      .eq("node_id", nodeId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data as Instance[];
  });
}

export async function getInstanceById(
  instanceId: string,
  userId: string
): Promise<Instance | null> {
  return logged(`getInstanceById(${instanceId})`, async () => {
    const { data, error } = await supabase
      .from("obs_instances")
      .select("*")
      .eq("id", instanceId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    return data as Instance | null;
  });
}

// Admin variant of getInstanceById with no ownership check -- callers must
// gate access themselves (see admin.ts's requireAdmin).
export async function getInstanceByIdAdmin(instanceId: string): Promise<Instance | null> {
  return logged(`getInstanceByIdAdmin(${instanceId})`, async () => {
    const { data, error } = await supabase
      .from("obs_instances")
      .select("*")
      .eq("id", instanceId)
      .maybeSingle();
    if (error) throw error;
    return data as Instance | null;
  });
}

export async function insertInstance(
  instance: Omit<Instance, "created_at">
): Promise<Instance> {
  return logged(`insertInstance(${instance.id})`, async () => {
    const { data, error } = await supabase
      .from("obs_instances")
      .insert(instance)
      .select()
      .single();
    if (error) throw error;
    return data as Instance;
  });
}

export async function updateInstance(
  instanceId: string,
  fields: Partial<Instance>
): Promise<Instance> {
  return logged(`updateInstance(${instanceId})`, async () => {
    const { data, error } = await supabase
      .from("obs_instances")
      .update(fields)
      .eq("id", instanceId)
      .select()
      .single();
    if (error) throw error;
    return data as Instance;
  });
}

// Used by the docker event listener, which only has the container_id from
// the Docker events stream, not the instance id or owning user.
export async function updateInstanceByContainerId(
  containerId: string,
  fields: Partial<Instance>
): Promise<Instance | null> {
  return logged(`updateInstanceByContainerId(${containerId})`, async () => {
    const { data, error } = await supabase
      .from("obs_instances")
      .update(fields)
      .eq("container_id", containerId)
      .select()
      .maybeSingle();
    if (error) throw error;
    return data as Instance | null;
  });
}

export async function deleteInstance(instanceId: string): Promise<void> {
  return logged(`deleteInstance(${instanceId})`, async () => {
    const { error } = await supabase.from("obs_instances").delete().eq("id", instanceId);
    if (error) throw error;
  });
}

export async function sumAllocatedVram(nodeId: string): Promise<number> {
  return logged(`sumAllocatedVram(${nodeId})`, async () => {
    const { data, error } = await supabase
      .from("obs_instances")
      .select("vram_allocated_mb")
      .eq("node_id", nodeId)
      .eq("status", "running");
    if (error) throw error;

    const rows = (data ?? []) as { vram_allocated_mb: number }[];
    return rows.reduce((sum, r) => sum + r.vram_allocated_mb, 0);
  });
}

export async function countActiveInstances(nodeId: string): Promise<number> {
  return logged(`countActiveInstances(${nodeId})`, async () => {
    const { count, error } = await supabase
      .from("obs_instances")
      .select("id", { count: "exact", head: true })
      .eq("node_id", nodeId)
      .in("status", ["creating", "running"] as InstanceStatus[]);
    if (error) throw error;
    return count ?? 0;
  });
}
