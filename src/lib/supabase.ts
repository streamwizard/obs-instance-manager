import { createClient } from "@supabase/supabase-js";
import type { Instance, InstanceStatus, Node } from "../types";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}

export const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export async function getNode(nodeId: string): Promise<Node> {
  const { data, error } = await supabase
    .from("obs_nodes")
    .select("*")
    .eq("id", nodeId)
    .single();
  if (error) throw error;
  return data as Node;
}

export async function listUserInstances(userId: string): Promise<Instance[]> {
  const { data, error } = await supabase
    .from("obs_instances")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as Instance[];
}

export async function listNodeInstances(nodeId: string): Promise<Instance[]> {
  const { data, error } = await supabase
    .from("obs_instances")
    .select("*")
    .eq("node_id", nodeId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as Instance[];
}

export async function getInstanceById(
  instanceId: string,
  userId: string
): Promise<Instance | null> {
  const { data, error } = await supabase
    .from("obs_instances")
    .select("*")
    .eq("id", instanceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as Instance | null;
}

export async function insertInstance(
  instance: Omit<Instance, "created_at">
): Promise<Instance> {
  const { data, error } = await supabase
    .from("obs_instances")
    .insert(instance)
    .select()
    .single();
  if (error) throw error;
  return data as Instance;
}

export async function updateInstance(
  instanceId: string,
  fields: Partial<Instance>
): Promise<Instance> {
  const { data, error } = await supabase
    .from("obs_instances")
    .update(fields)
    .eq("id", instanceId)
    .select()
    .single();
  if (error) throw error;
  return data as Instance;
}

export async function deleteInstance(instanceId: string): Promise<void> {
  const { error } = await supabase.from("obs_instances").delete().eq("id", instanceId);
  if (error) throw error;
}

export async function sumAllocatedVram(nodeId: string): Promise<number> {
  const { data, error } = await supabase
    .from("obs_instances")
    .select("vram_allocated_mb")
    .eq("node_id", nodeId)
    .eq("status", "running");
  if (error) throw error;

  const rows = (data ?? []) as { vram_allocated_mb: number }[];
  return rows.reduce((sum, r) => sum + r.vram_allocated_mb, 0);
}

export async function countActiveInstances(nodeId: string): Promise<number> {
  const { count, error } = await supabase
    .from("obs_instances")
    .select("id", { count: "exact", head: true })
    .eq("node_id", nodeId)
    .in("status", ["creating", "running"] as InstanceStatus[]);
  if (error) throw error;
  return count ?? 0;
}
