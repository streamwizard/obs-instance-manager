import type { CloudObsPlanLimits } from "@/types";
import { StreamwizardApi } from "./client";

export async function getSubscriptionLimits(subscriptionId: string): Promise<CloudObsPlanLimits> {
  const res = await StreamwizardApi.get<CloudObsPlanLimits>(`/api/nodes/subscriptions/${subscriptionId}/limits`);
  return res.data;
}
