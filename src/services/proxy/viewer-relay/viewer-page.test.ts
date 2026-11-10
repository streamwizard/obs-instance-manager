import { expect, test } from "bun:test";
import { relayScriptResponse, viewerPageHtml, viewerPageResponse } from "@/services/proxy/viewer-relay/viewer-page";

const PANEL = "https://streamwizard.org";

function injectedOrigins(html: string): unknown {
  const match = /window\.__SW_PANEL_ORIGINS=(.*?);<\/script>/.exec(html);
  return match ? JSON.parse(match[1] as string) : undefined;
}

test("the page loads the relay before the Selkies client", () => {
  const html = viewerPageHtml([PANEL]);
  const relay = html.indexOf('<script src="sw-relay.js">');
  const core = html.indexOf('<script type="module" src="selkies-core.js">');
  expect(relay).toBeGreaterThan(-1);
  expect(core).toBeGreaterThan(relay);
  expect(html).toContain('<div id="app"></div>');
  expect(html).not.toContain("Selkies</title>");
});

test("the panel origins are injected as a JSON array", () => {
  expect(injectedOrigins(viewerPageHtml([PANEL, "http://localhost:3003"]))).toEqual([PANEL, "http://localhost:3003"]);
});

test("* and invalid origins inject an empty list", () => {
  expect(injectedOrigins(viewerPageHtml(["*"]))).toEqual([]);
  expect(injectedOrigins(viewerPageHtml(["</script><script>alert(1)</script>"]))).toEqual([]);
});

test("only the panel origins may frame the page", () => {
  const res = viewerPageResponse("GET", [PANEL, "http://localhost:3003"]);
  expect(res.headers.get("content-security-policy")).toBe(`frame-ancestors ${PANEL} http://localhost:3003`);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  expect(viewerPageResponse("GET", ["*"]).headers.get("content-security-policy")).toBeNull();
});

test("HEAD answers without a body", async () => {
  const res = viewerPageResponse("HEAD", [PANEL]);
  expect(res.status).toBe(200);
  expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
  expect(await res.text()).toBe("");
});

test("the relay script bundles into one classic script", async () => {
  const res = await relayScriptResponse("GET");
  const js = await res.text();
  expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(js.length).toBeGreaterThan(500);
  expect(js).not.toMatch(/^\s*(import|export)\s/m);
  expect(js).toContain("__SW_PANEL_ORIGINS");
});
