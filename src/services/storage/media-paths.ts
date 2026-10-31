import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { MediaError } from "@/services/storage/media-error";

// SECURITY: the media dir is a bind mount the OBS container writes to, so the
// (semi-trusted) container can plant symlinks inside it. The manager runs as
// root, so a lexical-only path check lets an intermediate symlink (e.g.
// media/x -> /) redirect a write/delete/read outside the media root -- a
// container escape / cross-instance / host-overwrite. So resolution is NOT
// purely lexical:
//   1. Lexically reject absolute paths, "..", ".", empty segments, null bytes.
//   2. Anchor at realpath(base) -- the mount root itself is root-owned and not
//      container-replaceable.
//   3. Walk every path component and reject if any existing component is a
//      symlink (intermediate or final). Writers additionally use temp-file +
//      rename (see uploadFile) so a symlink raced onto the destination is
//      replaced, never followed.
// Residual TOCTOU (container swaps a verified dir for a symlink between check
// and open) is extremely narrow given the per-instance single-writer lock and
// the temp+rename write path; fully closing it would need openat2(RESOLVE_-
// BENEATH), which Bun does not expose.
export function lexicalClean(relPath: string): string {
  // Reject control chars (incl. NUL, CR, LF) up front: they have no place in a
  // filename and would otherwise ride through to headers (Content-Disposition)
  // as a CRLF-injection vector, or confuse the filesystem.
  if (!relPath || /[\x00-\x1f\x7f]/.test(relPath)) {
    throw new MediaError("Invalid file path", 400);
  }
  const cleaned = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = cleaned.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new MediaError("Invalid file path", 400);
  }
  return cleaned;
}

// Resolves relPath under base, guaranteeing no symlink is traversed. `base` is
// created first so realpath() succeeds and anchors us at the real mount root.
export async function resolveSafe(base: string, relPath: string): Promise<string> {
  const cleaned = lexicalClean(relPath);
  await mkdir(base, { recursive: true });
  const realBase = await realpath(base);

  let cur = realBase;
  const parts = cleaned.split("/");
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]!);
    const st = await lstat(cur).catch(() => null);
    if (st?.isSymbolicLink()) {
      throw new MediaError("Symlinked paths are not allowed", 400);
    }
    // Intermediate components that exist must be real directories.
    if (i < parts.length - 1 && st && !st.isDirectory()) {
      throw new MediaError("Invalid file path", 400);
    }
  }
  return cur;
}

export function toRel(base: string, abs: string): string {
  return relative(base, abs).split(sep).join("/");
}
