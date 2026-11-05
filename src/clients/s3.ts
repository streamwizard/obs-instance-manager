import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import {
  apiGetInstanceStorageCredentials,
  apiGetSharedStorageCredentials,
  type StorageCredentials,
} from "@/clients/streamwizard-api/storage";
import { log } from "@/utils/logger";

// The node holds no storage key. Every S3 client here signs with temporary
// credentials from rest-api: one set per instance, limited to that instance's
// obs-configs/ and obs-media/ folders, and one read-only set for the shared
// obs-templates/ and plugins/. They live only in memory and are fetched again
// before they expire (and after a restart).

const endpoint = process.env.S3_ENDPOINT;

if (!endpoint) {
  throw new Error("S3_ENDPOINT must be set");
}

export const S3_BUCKET = process.env.S3_BUCKET ?? "streamwizard-obs";
const region = process.env.S3_REGION ?? "auto";

/** Fetch new credentials once fewer than this many ms are left. */
const REFRESH_BEFORE_MS = 5 * 60 * 1000;
/** Drop an instance's client after this long without use. */
const IDLE_MS = 2 * 60 * 60 * 1000;

export type StorageScope = { kind: "instance"; instanceId: string } | { kind: "shared" };

// Must match s3Prefix / s3MediaPrefix in services/storage/obs-config/paths.ts.
const INSTANCE_KEY = /^(?:obs-configs|obs-media)\/[^/]+\/([^/]+)\//;

/** Which credentials a key (or list prefix) needs. */
export function scopeForKey(key: string): StorageScope {
  const match = INSTANCE_KEY.exec(key);
  return match ? { kind: "instance", instanceId: match[1]! } : { kind: "shared" };
}

function scopeId(scope: StorageScope): string {
  return scope.kind === "instance" ? `instance:${scope.instanceId}` : "shared";
}

interface TempCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

/**
 * Wraps a credential fetch for the AWS SDK: hands out the same credentials
 * until they are close to expiry, and shares one fetch between concurrent
 * callers.
 */
export function cachedCredentials(
  fetch: () => Promise<StorageCredentials>,
  now: () => number = Date.now,
): () => Promise<TempCredentials> {
  let current: TempCredentials | null = null;
  let pending: Promise<TempCredentials> | null = null;

  return async () => {
    if (current && current.expiration.getTime() - now() > REFRESH_BEFORE_MS) return current;
    pending ??= fetch()
      .then((c): TempCredentials => {
        current = {
          accessKeyId: c.access_key_id,
          secretAccessKey: c.secret_access_key,
          sessionToken: c.session_token,
          expiration: new Date(c.expires_at),
        };
        return current;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

function createClient(scope: StorageScope): S3Client {
  const fetch =
    scope.kind === "instance"
      ? () => apiGetInstanceStorageCredentials(scope.instanceId)
      : () => apiGetSharedStorageCredentials();
  return new S3Client({
    endpoint,
    region,
    credentials: cachedCredentials(fetch),
    forcePathStyle: true, // required for MinIO
  });
}

const clients = new Map<string, { client: S3Client; lastUsed: number }>();

function evictIdle(now: number): void {
  for (const [id, entry] of clients) {
    if (id !== "shared" && now - entry.lastUsed > IDLE_MS) {
      entry.client.destroy();
      clients.delete(id);
    }
  }
}

/** The S3 client whose credentials cover `key`. */
export function s3ForKey(key: string): S3Client {
  const scope = scopeForKey(key);
  const id = scopeId(scope);
  const now = Date.now();
  evictIdle(now);
  let entry = clients.get(id);
  if (!entry) {
    entry = { client: createClient(scope), lastUsed: now };
    clients.set(id, entry);
  }
  entry.lastUsed = now;
  return entry.client;
}

/** Drops an instance's cached client and credentials (after it is destroyed). */
export function forgetInstanceStorage(instanceId: string): void {
  const id = scopeId({ kind: "instance", instanceId });
  clients.get(id)?.client.destroy();
  clients.delete(id);
}

/** Boot check: fetches the shared credentials and lists one plugin. Logs, never throws. */
export async function checkS3(): Promise<void> {
  try {
    await s3ForKey("plugins/").send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: "plugins/", MaxKeys: 1 }));
    log("info", "S3 connection ok", { endpoint, bucket: S3_BUCKET });
  } catch (err: any) {
    const status = err?.$metadata?.httpStatusCode ?? err?.response?.status;
    if (status === 401 || status === 403) {
      log("error", "S3 auth error — check rest-api's OBS storage key and MinIO STS", { endpoint, bucket: S3_BUCKET });
    } else if (status === 404) {
      log("error", "S3 bucket not found — check S3_BUCKET", { endpoint, bucket: S3_BUCKET });
    } else if (status === 503) {
      log("error", "rest-api could not issue storage credentials", { endpoint, bucket: S3_BUCKET });
    } else {
      log("error", "S3 unreachable — check S3_ENDPOINT and network", {
        endpoint,
        bucket: S3_BUCKET,
        error: err?.message ?? String(err),
      });
    }
  }
}
