import { realpath, stat } from "node:fs/promises";
import path from "node:path";

// The Selkies web client (HTML, JS, CSS, codecs) that viewers load. OIM serves
// its own copy, extracted at image build time from the same Selkies release
// the instance image installs (see Dockerfile), instead of passing through
// whatever the instance container returns. Code running inside a container
// must never be able to put a page of its own on the node's origin.
export const DEFAULT_SELKIES_WEB_ROOT = "/app/selkies-web";

export function selkiesWebRoot(env: Record<string, string | undefined> = process.env): string {
  return path.resolve(env.VIEWER_WEB_ROOT || DEFAULT_SELKIES_WEB_ROOT);
}

/**
 * A file of the bundled Selkies client, or null when there is none.
 * `rest` is the request path below the viewer prefix ("/" for the page) and
 * must already have passed isStaticPath().
 */
export async function clientFileResponse(webRoot: string, rest: string, method: string): Promise<Response | null> {
  const relative = rest === "/" ? "index.html" : decodeURIComponent(rest.slice(1));
  let file: string;
  try {
    // Real paths on both sides, so neither ".." nor a symlink leads out.
    const root = await realpath(webRoot);
    file = await realpath(path.resolve(root, relative));
    if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) return null;
  } catch {
    return null;
  }

  const body = Bun.file(file);
  const headers = new Headers({
    "content-type": body.type,
    "content-length": String(body.size),
    "x-content-type-options": "nosniff",
    // assets/ names carry a content hash; everything else (the page, the core
    // script, codecs) keeps its name across releases and must revalidate.
    "cache-control": relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  });
  return new Response(method === "HEAD" ? null : body, { status: 200, headers });
}

// Everything that comes back from a container is data for the client's
// fetches, never a page: a browser that navigates to it gets an opaque,
// script-less document, and nothing is sniffed into HTML.
const UPSTREAM_CSP = "sandbox; default-src 'none'; frame-ancestors 'none'";

export function hardenUpstreamHeaders(headers: Headers): Headers {
  headers.set("content-security-policy", UPSTREAM_CSP);
  headers.set("x-content-type-options", "nosniff");
  return headers;
}
