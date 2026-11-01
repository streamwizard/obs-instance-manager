import type { CloudObsPlanLimits } from "@/types";
import { StreamwizardApi, pathSegment } from "./client";

export async function getSubscriptionLimits(subscriptionId: string): Promise<CloudObsPlanLimits> {
  const res = await StreamwizardApi.get<CloudObsPlanLimits>(`/api/obs-nodes/subscriptions/${pathSegment(subscriptionId)}/limits`);
  return res.data;
}
