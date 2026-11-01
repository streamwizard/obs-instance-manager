// Per-user lookups: admin flag, Cloud OBS plan access and the Twitch stream key.
import { StreamwizardApi } from "./client";

export async function isAdmin(userId: string): Promise<boolean> {
  const res = await StreamwizardApi.get<{ is_admin: boolean }>(`/api/nodes/users/${userId}/is-admin`);
  return res.data.is_admin;
}

/** Whether the user's Cloud OBS plan may start an instance right now. */
export async function canInteractCloudObs(userId: string): Promise<boolean> {
  const res = await StreamwizardApi.get<{ can_interact: boolean }>(`/api/nodes/users/${userId}/cloud-obs-access`);
  return res.data.can_interact;
}

/**
 * Mirrors StreamKeyReason in rest-api. `scope_missing` and `no_integration`
 * mean the user has not granted the stream key on Twitch; `error` is a
 * failure on rest-api's side. A rest-api that predates the field is read as
 * granted-or-error from the key alone.
 */
export type StreamKeyReason = "granted" | "no_integration" | "scope_missing" | "error";

export interface StreamKeyLookup {
  key: string | null;
  reason: StreamKeyReason;
}

export async function getStreamKey(userId: string): Promise<StreamKeyLookup> {
  const res = await StreamwizardApi.get<{ key: string | null; reason?: StreamKeyReason }>(
    `/api/nodes/users/${userId}/stream-key`,
  );
  const { key, reason } = res.data;
  return { key, reason: reason ?? (key ? "granted" : "error") };
}
