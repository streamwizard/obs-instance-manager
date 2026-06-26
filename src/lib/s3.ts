import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { log } from "./logger";

const endpoint = process.env.S3_ENDPOINT;
const accessKeyId = process.env.S3_ACCESS_KEY;
const secretAccessKey = process.env.S3_SECRET_KEY;

if (!endpoint || !accessKeyId || !secretAccessKey) {
  throw new Error("S3_ENDPOINT, S3_ACCESS_KEY and S3_SECRET_KEY must be set");
}

export const S3_BUCKET = process.env.S3_BUCKET ?? "streamwizard-obs";

export const s3 = new S3Client({
  endpoint,
  region: process.env.S3_REGION ?? "auto",
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: true, // required for MinIO; harmless on R2
});

export async function checkS3(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
    log("info", "S3 connection ok", { endpoint, bucket: S3_BUCKET });
  } catch (err: any) {
    const status = err?.$metadata?.httpStatusCode;
    if (status === 403) {
      log("error", "S3 auth error — check S3_ACCESS_KEY and S3_SECRET_KEY", { endpoint, bucket: S3_BUCKET });
    } else if (status === 404) {
      log("error", "S3 bucket not found — check S3_BUCKET", { endpoint, bucket: S3_BUCKET });
    } else {
      log("error", "S3 unreachable — check S3_ENDPOINT and network", {
        endpoint,
        bucket: S3_BUCKET,
        error: err?.message ?? String(err),
      });
    }
  }
}
