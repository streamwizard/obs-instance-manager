import type { Context, Next } from "hono";
import { MAX_REQUEST_BODY_BYTES } from "@/utils/constants";

// Media uploads (POST /instances/:id/files) legitimately exceed the 10MB cap
// -- they stream large assets to disk and enforce their own per-file/quota
// limits in services/storage/media.ts. Every other route stays bounded.
const MEDIA_UPLOAD_PATH = /^\/instances\/[^/]+\/files$/;

export async function bodyLimit(c: Context, next: Next) {
  const isMediaUpload = c.req.method === "POST" && MEDIA_UPLOAD_PATH.test(c.req.path);
  if (!isMediaUpload) {
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (contentLength > MAX_REQUEST_BODY_BYTES) {
      return c.json({ error: "Request body too large" }, 413);
    }
  }
  await next();
}
