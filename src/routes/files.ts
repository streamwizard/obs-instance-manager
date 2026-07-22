// Media file-manager routes for a running instance. Mounted under /instances
// (alongside routes/instances.ts) so the URLs are /instances/:id/files*.
//
// Every route: JWT auth (authMiddleware) -> ownership-scoped getInstanceById
// -> running-guard. Files only exist on disk while the container is up (the
// bind mount), so management is running-only by design; when stopped the UI
// shows "start the instance to manage files" and these 409.
import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { getInstanceById } from "../clients/supabase";
import {
  deleteFile,
  getListing,
  MediaError,
  renameFile,
  resolveDownload,
  uploadFile,
} from "../services/media";
import { KeyedRateLimiter } from "../utils/rate-limit";
import { OBS_MEDIA_QUOTA_MB_FALLBACK } from "../utils/constants";
import type { AppVariables, Instance } from "../types";

const files = new Hono<{ Variables: AppVariables }>();

// Uploads are the one expensive op here (disk write + S3 push), so throttle
// per user like instance creation does.
const uploadLimiter = new KeyedRateLimiter(30, 60_000);

files.use("/:id/files", authMiddleware);
files.use("/:id/files/*", authMiddleware);

// Loads the instance for the caller, 404s if not owned, 409s if not running.
// Returns the instance with storage_quota_mb defaulted for pre-migration rows.
async function loadRunning(
  userId: string,
  id: string,
): Promise<{ ok: true; instance: Instance } | { ok: false; status: 404 | 409; error: string }> {
  const instance = await getInstanceById(id, userId);
  if (!instance) return { ok: false, status: 404, error: "Instance not found" };
  if (instance.status !== "running" || !instance.container_id) {
    return { ok: false, status: 409, error: "Start the instance to manage files" };
  }
  // Belt-and-braces for rows created before the storage columns existed.
  const quota = instance.storage_quota_mb ?? OBS_MEDIA_QUOTA_MB_FALLBACK;
  return { ok: true, instance: { ...instance, storage_quota_mb: quota } };
}

function handleError(err: unknown): Response {
  if (err instanceof MediaError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

// GET /instances/:id/files -> { files, used_bytes, quota_bytes }
files.get("/:id/files", async (c) => {
  const userId = c.get("userId") as string;
  const loaded = await loadRunning(userId, c.req.param("id"));
  if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status);
  return c.json(await getListing(loaded.instance));
});

// GET /instances/:id/files/download?path=foo/bar.png -> file bytes
files.get("/:id/files/download", async (c) => {
  const userId = c.get("userId") as string;
  const loaded = await loadRunning(userId, c.req.param("id"));
  if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status);

  const path = c.req.query("path");
  if (!path) return c.json({ error: "Missing path" }, 400);

  try {
    const { abs, name, size } = await resolveDownload(loaded.instance.id, path);
    // Defence in depth: names are already control-char-free (lexicalClean), but
    // build the header safely anyway -- an ASCII-only quoted fallback plus an
    // RFC 5987 filename* for the exact (percent-encoded) name. Never interpolate
    // a raw filename into a header value.
    const asciiName = name.replace(/[^A-Za-z0-9._-]/g, "_");
    return new Response(Bun.file(abs).stream(), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size),
        "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    });
  } catch (err) {
    return handleError(err);
  }
});

// POST /instances/:id/files  (raw body = file bytes; path in ?path= or header)
// Bypasses the global MAX_REQUEST_BODY_BYTES cap -- see index.ts. Size limits
// are enforced while streaming in services/media.ts.
files.post("/:id/files", async (c) => {
  const userId = c.get("userId") as string;
  if (!uploadLimiter.allow(userId)) {
    return c.json({ error: "Too many uploads, try again later" }, 429);
  }

  const loaded = await loadRunning(userId, c.req.param("id"));
  if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status);

  const path = c.req.query("path") ?? c.req.header("x-file-path");
  if (!path) return c.json({ error: "Missing file path (use ?path= or x-file-path header)" }, 400);

  const body = c.req.raw.body;
  if (!body) return c.json({ error: "Missing request body" }, 400);

  const lengthHeader = c.req.header("content-length");
  const declaredSize = lengthHeader ? Number(lengthHeader) : null;

  try {
    const listing = await uploadFile(loaded.instance, path, body, Number.isFinite(declaredSize) ? declaredSize : null);
    return c.json(listing, 201);
  } catch (err) {
    return handleError(err);
  }
});

const renameSchema = z.object({ from: z.string().min(1), to: z.string().min(1) });

// PATCH /instances/:id/files/rename  { from, to }
files.patch("/:id/files/rename", async (c) => {
  const userId = c.get("userId") as string;
  const loaded = await loadRunning(userId, c.req.param("id"));
  if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status);

  const parsed = renameSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid rename payload" }, 400);

  try {
    const result = await renameFile(loaded.instance, parsed.data.from, parsed.data.to);
    return c.json(result);
  } catch (err) {
    return handleError(err);
  }
});

const deleteSchema = z.object({ path: z.string().min(1) });

// DELETE /instances/:id/files  { path }
files.delete("/:id/files", async (c) => {
  const userId = c.get("userId") as string;
  const loaded = await loadRunning(userId, c.req.param("id"));
  if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status);

  const parsed = deleteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid delete payload" }, 400);

  try {
    return c.json(await deleteFile(loaded.instance, parsed.data.path));
  } catch (err) {
    return handleError(err);
  }
});

export default files;
