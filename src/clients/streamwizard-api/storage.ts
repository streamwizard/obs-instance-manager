// Temporary MinIO credentials from rest-api. The node holds no storage key of
// its own: rest-api asks MinIO for short-lived keys cut down to one
// instance's folders (or read-only templates and plugins) and only answers
// for instances on this node (404 otherwise).
//
// Callers go through clients/s3.ts, not this module. Never log the result.
import { StreamwizardApi, pathSegment } from "./client";

export interface StorageCredentials {
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
  /** ISO time the credentials stop working. */
  expires_at: string;
}

/** Read, write and delete in one instance's obs-configs/ and obs-media/ folders. */
export async function apiGetInstanceStorageCredentials(instanceId: string): Promise<StorageCredentials> {
  const res = await StreamwizardApi.post<StorageCredentials>(
    `/api/obs-nodes/instances/${pathSegment(instanceId)}/storage-credentials`,
  );
  return res.data;
}

/** Read-only obs-templates/ and plugins/. */
export async function apiGetSharedStorageCredentials(): Promise<StorageCredentials> {
  const res = await StreamwizardApi.post<StorageCredentials>("/api/obs-nodes/storage-credentials");
  return res.data;
}
