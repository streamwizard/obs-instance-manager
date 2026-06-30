import { apiGetStreamKey } from "../clients/streamwizard-api";

export async function getStreamKey(userId: string): Promise<string | null> {
  return apiGetStreamKey(userId);
}
