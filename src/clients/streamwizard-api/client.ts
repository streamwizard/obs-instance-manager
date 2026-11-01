// HTTP client for the panel's rest-api (`/api/obs-nodes/*`). Every database read
// and write this node does goes through here: the node holds no database
// credentials of its own, only NODE_API_KEY, which rest-api uses to know
// which node is calling. The per-domain modules next to this file are the
// only ones that should import it.
import axios from "axios";
import { debug, log } from "@/utils/logger";

const apiUrl = process.env.REST_API_URL;
const nodeApiKey = process.env.NODE_API_KEY;

if (!apiUrl || !nodeApiKey) {
  throw new Error("REST_API_URL and NODE_API_KEY must be set");
}

// Everything on this instance is small JSON — media uploads go straight to S3 —
// so no request has a reason to run long. The timeout matters because callers
// now share responses through node-cache's single-flight: without it one hung
// socket would wedge every waiting consumer instead of just its own call.
const REQUEST_TIMEOUT_MS = 15_000;

export const StreamwizardApi = axios.create({
  baseURL: apiUrl,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${nodeApiKey}`,
  },
});

StreamwizardApi.interceptors.request.use((config) => {
  debug("rest-api", `--> ${config.method?.toUpperCase()} ${config.url}`);
  return config;
});

StreamwizardApi.interceptors.response.use(
  (response) => {
    debug("rest-api", `<-- ${response.status} ${response.config.url}`);
    return response;
  },
  (error) => {
    const status = error.response?.status;
    const url = error.config?.url;
    log("warn", "rest-api request failed", { status, url, message: error.message });
    return Promise.reject(error);
  }
);

/** Runs a lookup and turns a 404 into null; any other failure still throws. */
export async function nullOn404<T>(request: () => Promise<{ data: T }>): Promise<T | null> {
  try {
    const res = await request();
    return res.data;
  } catch (err: any) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical UUID: the shape of every instance, user and subscription id. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * One URL path segment for a rest-api call. Ids reach this client from route
 * params, which Hono percent-decodes, so a raw "/" or ".." would otherwise
 * change which rest-api route is called (with this node's API key). Encodes
 * the value and refuses the segments that encoding leaves meaningful.
 */
export function pathSegment(value: string): string {
  if (!value || value === "." || value === "..") {
    throw new Error("invalid rest-api path segment");
  }
  return encodeURIComponent(value);
}
