// Plaintext passwords for one of this node's instances. rest-api holds the
// encryption key and decrypts them; this node never sees ciphertext or the
// key, and rest-api only answers for instances on this node (404 otherwise).
//
// Callers go through services/cache/instance-secrets-cache, not this module.
// Never log the result.
import { StreamwizardApi, pathSegment } from "./client";

export interface InstanceSecrets {
  /** null on a row that has no OBS WebSocket password. */
  obs_ws_password: string | null;
  /** rest-api generates one for old rows that have none. */
  vnc_password: string;
}

export async function apiGetInstanceSecrets(instanceId: string): Promise<InstanceSecrets> {
  const res = await StreamwizardApi.get<InstanceSecrets>(`/api/obs-nodes/instances/${pathSegment(instanceId)}/secrets`);
  return res.data;
}
