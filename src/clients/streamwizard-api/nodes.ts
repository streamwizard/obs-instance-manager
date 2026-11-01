// This node's own row and reports. rest-api knows which node is calling from
// NODE_API_KEY, so none of these take a node id.
import type { Node } from "@/types";
import { StreamwizardApi } from "./client";

export async function getNode(): Promise<Node> {
  const res = await StreamwizardApi.get<Node>("/api/obs-nodes/me");
  return res.data;
}

export interface ReconcileInstanceResult {
  instance_id: string;
  action: "marked_error" | "marked_running" | "marked_stopped" | "restarted" | "restart_failed" | "no_change";
}

export interface ReconcileReport {
  reconciled_at: string;
  orphaned_containers: string[];
  instances: ReconcileInstanceResult[];
}

export async function postReconcileReport(report: ReconcileReport): Promise<void> {
  await StreamwizardApi.post("/api/obs-nodes/reconcile", report);
}
