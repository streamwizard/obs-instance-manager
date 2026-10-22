import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { s3, S3_BUCKET } from "../clients/s3";

// Object-level helpers shared by the config/media sync (obs-config.ts) and the
// plugin mirror (plugins.ts). Everything here streams: files are never held in
// memory whole, except small ones where a single buffered PUT is cheaper.

export interface S3ObjectInfo {
  key: string;
  etag: string;
  size: number;
}

// Files at or below this go up in one buffered PutObject; larger ones stream as
// a multipart upload of MULTIPART_PART_BYTES parts, MULTIPART_QUEUE at a time,
// so a 2GB media file costs ~16MB of memory instead of 2GB.
const SINGLE_PUT_MAX_BYTES = 8 * 1024 * 1024;
const MULTIPART_PART_BYTES = 8 * 1024 * 1024;
const MULTIPART_QUEUE = 2;

// DeleteObjects accepts at most 1000 keys per request.
const DELETE_BATCH = 1000;

export async function listObjects(prefix: string): Promise<S3ObjectInfo[]> {
  const objects: S3ObjectInfo[] = [];
  let continuationToken: string | undefined;

  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) objects.push({ key: obj.Key, etag: obj.ETag ?? "", size: obj.Size ?? 0 });
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects;
}

// Streams an object to localPath via a temp file + rename, so the target is
// replaced with a new inode rather than truncated in place -- a running OBS
// may have the old file mmapped (plugin .so files) or open. Returns false if
// the object had no body.
export async function downloadToFile(key: string, localPath: string): Promise<boolean> {
  const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  if (!res.Body) return false;

  await mkdir(dirname(localPath), { recursive: true });
  const tmp = `${localPath}.sync-${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(tmp, new Response(res.Body.transformToWebStream()));
    await rename(tmp, localPath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return true;
}

export async function uploadFile(key: string, localPath: string, size: number): Promise<void> {
  const file = Bun.file(localPath);
  if (size <= SINGLE_PUT_MAX_BYTES) {
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: new Uint8Array(await file.arrayBuffer()),
      })
    );
    return;
  }

  await new Upload({
    client: s3,
    params: { Bucket: S3_BUCKET, Key: key, Body: file.stream() },
    partSize: MULTIPART_PART_BYTES,
    queueSize: MULTIPART_QUEUE,
  }).done();
}

// Server-side copy, so a media rename doesn't re-upload the file.
export async function copyObject(fromKey: string, toKey: string): Promise<void> {
  const source = `${S3_BUCKET}/${fromKey}`.split("/").map(encodeURIComponent).join("/");
  await s3.send(new CopyObjectCommand({ Bucket: S3_BUCKET, Key: toKey, CopySource: source }));
}

// Batched delete. Returns the keys that were actually deleted; per-key
// failures are left out (callers keep tracking them and retry next time).
// A failed request for a whole batch throws.
export async function deleteKeys(keys: string[]): Promise<string[]> {
  const deleted: string[] = [];
  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    const batch = keys.slice(i, i + DELETE_BATCH);
    const res = await s3.send(
      new DeleteObjectsCommand({
        Bucket: S3_BUCKET,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      })
    );
    const failed = new Set((res.Errors ?? []).map((e) => e.Key));
    deleted.push(...batch.filter((k) => !failed.has(k)));
  }
  return deleted;
}
