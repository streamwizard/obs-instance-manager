import path from "node:path";
import { pairableOrigins } from "@/services/proxy/viewer-relay/relay";
import { PANEL_ORIGINS } from "@/utils/panel-origins";

// The viewer's entry page. OIM serves this instead of the index.html in the
// Selkies release: the same shell as Selkies' own core-only page (an #app
// div and the selkies-core.js module, no dashboard), plus the relay script
// (relay.ts) and the panel origins it may pair with. The Selkies client
// files themselves are served untouched (selkies-client-files.ts).

/** Path of the relay script below the viewer prefix, next to the client files. */
export const RELAY_SCRIPT_PATH = "/sw-relay.js";

// JSON in an inline <script>: escape "<" so no value can close the tag.
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * The entry page. `origins` is PANEL_ORIGIN parsed; an empty list goes out
 * when it is "*" or names nothing valid, and the relay then refuses to pair.
 */
export function viewerPageHtml(origins: readonly string[]): string {
  const pairable = pairableOrigins([...origins]) ?? [];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<script>(function(){var u=new URL(document.URL);if(u.username||u.password){u.username="";u.password="";location.replace(u.href);}})();</script>
<title>OBS desktop</title>
<script>window.__SW_PANEL_ORIGINS=${scriptJson(pairable)};</script>
<script src="${RELAY_SCRIPT_PATH.slice(1)}"></script>
</head>
<body style="margin:0;background:#000">
<div id="app"></div>
<script type="module" src="selkies-core.js"></script>
</body>
</html>
`;
}

// Who may frame the page: the panel origins when PANEL_ORIGIN names them,
// anyone otherwise (as before the relay existed).
function frameAncestors(origins: readonly string[]): string | null {
  const pairable = pairableOrigins([...origins]);
  return pairable ? `frame-ancestors ${pairable.join(" ")}` : null;
}

function pageHeaders(contentType: string, length: number, origins: readonly string[]): Headers {
  const headers = new Headers({
    "content-type": contentType,
    "content-length": String(length),
    "x-content-type-options": "nosniff",
    "cache-control": "no-cache",
  });
  const ancestors = frameAncestors(origins);
  if (ancestors) headers.set("content-security-policy", ancestors);
  return headers;
}

/** The entry page as a response (headers only for HEAD). */
export function viewerPageResponse(method: string, origins: readonly string[] = PANEL_ORIGINS): Response {
  const body = new TextEncoder().encode(viewerPageHtml(origins));
  const headers = pageHeaders("text/html; charset=utf-8", body.byteLength, origins);
  return new Response(method === "HEAD" ? null : body, { status: 200, headers });
}

let relayScript: Promise<Uint8Array> | null = null;

// Bundled once per process, from the TypeScript source that ships in the
// image (Dockerfile copies src/).
async function buildRelayScript(): Promise<Uint8Array> {
  const result = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "relay-browser.ts")],
    target: "browser",
    format: "iife",
    minify: true,
  });
  const output = result.outputs[0];
  if (!result.success || !output) throw new Error("viewer relay script failed to build");
  return new Uint8Array(await output.arrayBuffer());
}

/** The relay script as a response (headers only for HEAD). */
export async function relayScriptResponse(method: string): Promise<Response> {
  relayScript ??= buildRelayScript().catch((err) => {
    relayScript = null;
    throw err;
  });
  const body = await relayScript;
  const headers = new Headers({
    "content-type": "text/javascript; charset=utf-8",
    "content-length": String(body.byteLength),
    "x-content-type-options": "nosniff",
    "cache-control": "no-cache",
  });
  return new Response(method === "HEAD" ? null : body, { status: 200, headers });
}
