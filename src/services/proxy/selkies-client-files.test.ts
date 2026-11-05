import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clientFileResponse,
  DEFAULT_SELKIES_WEB_ROOT,
  hardenUpstreamHeaders,
  selkiesWebRoot,
} from "@/services/proxy/selkies-client-files";

let root: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "selkies-web-"));
  outside = await mkdtemp(path.join(tmpdir(), "selkies-outside-"));
  await writeFile(path.join(root, "index.html"), "<!doctype html><title>Selkies</title>");
  await writeFile(path.join(root, "selkies-core.js"), "export {};");
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "assets", "index-abc123.js"), "console.log(1);");
  await mkdir(path.join(root, "codecs"));
  await writeFile(path.join(outside, "secret.txt"), "not part of the client");
  await symlink(path.join(outside, "secret.txt"), path.join(root, "escape.txt"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("the page is index.html, revalidated on every load", async () => {
  const res = await clientFileResponse(root, "/", "GET");
  expect(res?.status).toBe(200);
  expect(res?.headers.get("content-type")).toStartWith("text/html");
  expect(res?.headers.get("cache-control")).toBe("no-cache");
  expect(res?.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await res?.text()).toContain("<title>Selkies</title>");
});

test("hashed assets cache for a year, other files revalidate", async () => {
  const asset = await clientFileResponse(root, "/assets/index-abc123.js", "GET");
  expect(asset?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(asset?.headers.get("content-type")).toStartWith("text/javascript");

  const core = await clientFileResponse(root, "/selkies-core.js", "GET");
  expect(core?.headers.get("cache-control")).toBe("no-cache");
});

test("HEAD sends the headers without a body", async () => {
  const res = await clientFileResponse(root, "/selkies-core.js", "HEAD");
  expect(res?.status).toBe(200);
  expect(res?.headers.get("content-length")).toBe(String("export {};".length));
  expect(await res?.text()).toBe("");
});

test("missing files and directories are not served", async () => {
  expect(await clientFileResponse(root, "/nope.js", "GET")).toBeNull();
  expect(await clientFileResponse(root, "/codecs", "GET")).toBeNull();
  expect(await clientFileResponse(root, "/codecs/", "GET")).toBeNull();
});

test("nothing outside the web root is served", async () => {
  expect(await clientFileResponse(root, `/../${path.basename(outside)}/secret.txt`, "GET")).toBeNull();
  // A sibling directory whose name starts with the root's name.
  const sibling = `${root}-sibling`;
  await mkdir(sibling);
  await writeFile(path.join(sibling, "index.html"), "sibling");
  expect(await clientFileResponse(root, `/../${path.basename(sibling)}/index.html`, "GET")).toBeNull();
  await rm(sibling, { recursive: true, force: true });
  // A symlink that points out of the root.
  expect(await clientFileResponse(root, "/escape.txt", "GET")).toBeNull();
});

test("the web root comes from VIEWER_WEB_ROOT, else the image path", () => {
  expect(selkiesWebRoot({})).toBe(DEFAULT_SELKIES_WEB_ROOT);
  expect(selkiesWebRoot({ VIEWER_WEB_ROOT: "/tmp/web/" })).toBe("/tmp/web");
});

test("container answers become sandboxed data", () => {
  const headers = hardenUpstreamHeaders(
    new Headers({ "content-type": "text/html", "content-security-policy": "frame-ancestors *" }),
  );
  expect(headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; frame-ancestors 'none'");
  expect(headers.get("x-content-type-options")).toBe("nosniff");
  expect(headers.get("content-type")).toBe("text/html");
});
