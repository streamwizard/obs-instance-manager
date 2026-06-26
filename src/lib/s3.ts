import { S3Client } from "@aws-sdk/client-s3";

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
