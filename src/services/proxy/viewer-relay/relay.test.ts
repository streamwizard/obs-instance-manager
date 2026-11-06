import { describe, expect, test } from "bun:test";
import {
  CLIPBOARD_TEXT_LIMIT,
  CORE_TO_PARENT_TYPES,
  createRelay,
  isReconnectProbe,
  PARENT_TO_CORE_TYPES,
  pairableOrigins,
  routePrefix,
  toCoreMessage,
  toParentMessage,
  type PageLocation,
} from "@/services/proxy/viewer-relay/relay";

const PANEL = "https://streamwizard.org";
const NODE = "https://node-1.streamwizard.org";
const PAGE_PATH = "/instances/abc/selkies/";

function page(): PageLocation {
  return { href: `${NODE}${PAGE_PATH}#token=t1`, origin: NODE, pathname: PAGE_PATH };
}

function setup(opts: { origins?: unknown; framed?: boolean } = {}) {
  const self = { name: "self" };
  const parent = { name: "parent" };
  const toCore: unknown[] = [];
  const toParent: { target: unknown; message: unknown; origin: string }[] = [];
  let ended = 0;
  const warnings: string[] = [];
  const relay = createRelay({
    origins: opts.origins ?? [PANEL],
    location: page,
    self,
    parent: opts.framed === false ? null : parent,
    postToCore: (m) => toCore.push(m),
    postToParent: (target, message, origin) => toParent.push({ target, message, origin }),
    showEnded: () => ended++,
    warn: (text) => warnings.push(text),
  });
  const fromParent = (data: unknown, origin = PANEL, source: unknown = parent) =>
    relay.handleMessage({ data, origin, source });
  const fromCore = (data: unknown) => relay.handleMessage({ data, origin: NODE, source: self });
  return { relay, self, parent, toCore, toParent, ended: () => ended, warnings, fromParent, fromCore };
}

const probeUrl = `${NODE}/instances/abc/selkies/api/websockets`;
const respond = (status: number) => async () => new Response(null, { status });

describe("pairableOrigins", () => {
  test("keeps exact origins", () => {
    expect(pairableOrigins([PANEL, "http://localhost:3000"])).toEqual([PANEL, "http://localhost:3000"]);
  });

  test("refuses * and nothing at all", () => {
    expect(pairableOrigins(["*"])).toBeNull();
    expect(pairableOrigins([PANEL, "*"])).toBeNull();
    expect(pairableOrigins([])).toBeNull();
    expect(pairableOrigins(undefined)).toBeNull();
    expect(pairableOrigins("https://streamwizard.org")).toBeNull();
  });

  test("drops anything that is not an exact http(s) origin", () => {
    expect(pairableOrigins([`${PANEL}/`, `${PANEL}/path`, "streamwizard.org", "javascript:alert(1)", 42])).toBeNull();
    expect(pairableOrigins([`${PANEL}/`, PANEL])).toEqual([PANEL]);
  });
});

describe("message allowlists", () => {
  test("the two directions share no type, so re-posted messages never echo", () => {
    const toCore = new Set<string>(PARENT_TO_CORE_TYPES);
    for (const type of CORE_TO_PARENT_TYPES) expect(toCore.has(type)).toBe(false);
  });

  test("parent messages are rebuilt from known fields", () => {
    expect(toCoreMessage({ type: "setMute", value: true, extra: "<b>" })).toEqual({ type: "setMute", value: true });
    expect(toCoreMessage({ type: "setVolume", value: 3 })).toEqual({ type: "setVolume", value: 1 });
    expect(toCoreMessage({ type: "setVolume", value: -1 })).toEqual({ type: "setVolume", value: 0 });
    expect(toCoreMessage({ type: "clipboardUpdateFromUI", text: "hi" })).toEqual({ type: "clipboardUpdateFromUI", text: "hi" });
    expect(toCoreMessage({ type: "pipelineControl", pipeline: "audio", enabled: false })).toEqual({
      type: "pipelineControl",
      pipeline: "audio",
      enabled: false,
    });
  });

  test("parent messages outside the allowlist or with bad fields are dropped", () => {
    for (const bad of [
      null,
      "setMute",
      [],
      { type: "mode", mode: "webrtc" },
      { type: "settings", settings: {} },
      { type: "command", value: "xterm" },
      { type: "getStats" },
      { type: "setMute", value: "true" },
      { type: "setVolume", value: Number.NaN },
      { type: "clipboardUpdateFromUI", text: 1 },
      { type: "clipboardUpdateFromUI", text: "x".repeat(CLIPBOARD_TEXT_LIMIT + 1) },
      { type: "pipelineControl", pipeline: "video", enabled: false },
      { type: "pipelineControl", pipeline: "microphone", enabled: true },
    ]) {
      expect(toCoreMessage(bad)).toBeNull();
    }
  });

  test("client messages reach the parent as plain data", () => {
    expect(toParentMessage({ type: "pipelineStatusUpdate", video: true, audio: false, microphone: true })).toEqual({
      type: "pipelineStatusUpdate",
      video: true,
      audio: false,
    });
    expect(toParentMessage({ type: "clientRoleUpdate", role: "controller" })).toEqual({ type: "clientRoleUpdate", role: "controller" });
    expect(toParentMessage({ type: "clipboardContentUpdate", text: "copied", totalLength: 6, secret: false })).toEqual({
      type: "clipboardContentUpdate",
      text: "copied",
      truncated: false,
      secret: false,
    });
  });

  test("long clipboard text is cut and marked truncated", () => {
    const message = toParentMessage({ type: "clipboardContentUpdate", text: "x".repeat(CLIPBOARD_TEXT_LIMIT + 10) });
    expect(message).toMatchObject({ truncated: true });
    expect(message?.type === "clipboardContentUpdate" && message.text.length).toBe(CLIPBOARD_TEXT_LIMIT);
  });

  test("other client messages stay on the node", () => {
    for (const bad of [
      { type: "serverSettings", payload: {} },
      { type: "stats", data: {} },
      { type: "fileUpload", payload: {} },
      { type: "pipelineStatusUpdate", microphone: true },
      { type: "clipboardContentUpdate", text: { html: "<img>" } },
      { type: "clientRoleUpdate", role: "x".repeat(33) },
    ]) {
      expect(toParentMessage(bad)).toBeNull();
    }
  });
});

describe("pairing", () => {
  test("pairs with an allowed parent and answers sw-ready", () => {
    const { relay, parent, toParent, fromParent } = setup();
    fromParent({ type: "sw-hello" });
    expect(relay.paired).toBe(true);
    expect(toParent).toEqual([{ target: parent, message: { type: "sw-ready", version: 1 }, origin: PANEL }]);
  });

  test("ignores a hello from another origin or another window", () => {
    const { relay, toParent, fromParent } = setup();
    fromParent({ type: "sw-hello" }, "https://evil.example");
    fromParent({ type: "sw-hello" }, PANEL, { name: "opener" });
    expect(relay.paired).toBe(false);
    expect(toParent).toEqual([]);
  });

  test("refuses to pair when PANEL_ORIGIN is *, and says so once", () => {
    const { relay, toParent, warnings, fromParent } = setup({ origins: [] });
    fromParent({ type: "sw-hello" });
    fromParent({ type: "sw-hello" });
    expect(relay.paired).toBe(false);
    expect(toParent).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  test("a top-level page has no parent to pair with", () => {
    const { relay, self, fromParent } = setup({ framed: false });
    fromParent({ type: "sw-hello" }, PANEL, self);
    expect(relay.paired).toBe(false);
  });

  test("replays the client's last status on pairing", () => {
    const { toParent, fromParent, fromCore } = setup();
    fromCore({ type: "pipelineStatusUpdate", video: true, audio: true });
    fromCore({ type: "pipelineStatusUpdate", audio: false });
    fromParent({ type: "sw-hello" });
    expect(toParent.map((p) => p.message)).toEqual([
      { type: "sw-ready", version: 1 },
      { type: "pipelineStatusUpdate", video: true, audio: false },
    ]);
  });
});

describe("relaying", () => {
  test("passes allowed parent messages to the client only once paired", () => {
    const { toCore, fromParent } = setup();
    fromParent({ type: "setMute", value: true });
    expect(toCore).toEqual([]);
    fromParent({ type: "sw-hello" });
    fromParent({ type: "setMute", value: true });
    fromParent({ type: "mode", mode: "webrtc" });
    expect(toCore).toEqual([{ type: "setMute", value: true }]);
  });

  test("drops messages from any window but the paired parent", () => {
    const { toCore, fromParent } = setup();
    fromParent({ type: "sw-hello" });
    fromParent({ type: "setMute", value: true }, "https://evil.example");
    fromParent({ type: "setMute", value: true }, PANEL, { name: "other" });
    expect(toCore).toEqual([]);
  });

  test("forwards client status to the paired parent with its origin as target", () => {
    const { parent, toParent, fromParent, fromCore } = setup();
    fromParent({ type: "sw-hello" });
    fromCore({ type: "clientRoleUpdate", role: "controller" });
    expect(toParent.at(-1)).toEqual({ target: parent, message: { type: "clientRoleUpdate", role: "controller" }, origin: PANEL });
  });

  test("ignores client-type messages that come from another origin", () => {
    const { relay, self, toParent, fromParent } = setup();
    fromParent({ type: "sw-hello" });
    relay.handleMessage({ data: { type: "clientRoleUpdate", role: "x" }, origin: "https://evil.example", source: self });
    expect(toParent).toHaveLength(1);
  });

  test("its own re-posts to the client are not forwarded back", () => {
    const { toParent, fromParent, fromCore } = setup();
    fromParent({ type: "sw-hello" });
    fromCore({ type: "setMute", value: true });
    expect(toParent).toHaveLength(1);
  });
});

describe("expired session", () => {
  test("a 401 on the reconnect probe tells the parent once and hides the 401 from the client", async () => {
    const { relay, toParent, fromParent } = setup();
    fromParent({ type: "sw-hello" });
    const fetch = relay.wrapFetch(respond(401));
    const res = await fetch(probeUrl, { method: "GET" });
    expect(res.status).toBe(503);
    expect(relay.expired).toBe(true);
    await fetch(probeUrl);
    expect(toParent.filter((p) => (p.message as { type: string }).type === "viewer-expired")).toHaveLength(1);
  });

  test("once expired, API calls stay off the network and relaying stops", async () => {
    const { relay, toCore, toParent, fromParent, fromCore } = setup();
    fromParent({ type: "sw-hello" });
    let calls = 0;
    const fetch = relay.wrapFetch(async () => {
      calls++;
      return new Response(null, { status: 401 });
    });
    await fetch(probeUrl);
    expect((await fetch(`${NODE}/instances/abc/selkies/api/status`)).status).toBe(503);
    expect(calls).toBe(1);
    // The page itself (the client's auth probe) still loads.
    expect((await fetch({ url: `${NODE}${PAGE_PATH}`, method: "HEAD" })).status).toBe(401);
    expect(calls).toBe(2);
    fromParent({ type: "setMute", value: true });
    fromCore({ type: "pipelineStatusUpdate", video: false });
    expect(toCore).toEqual([]);
    expect(toParent).toHaveLength(2);
  });

  test("a 401 anywhere but the probe is left to the client", async () => {
    const { relay } = setup();
    const fetch = relay.wrapFetch(respond(401));
    expect((await fetch(`${NODE}/instances/abc/selkies/api/status`)).status).toBe(401);
    expect((await fetch(probeUrl, { method: "HEAD" })).status).toBe(401);
    expect((await fetch(`${NODE}/instances/other/selkies/api/websockets`)).status).toBe(401);
    expect((await fetch(`https://elsewhere.example/instances/abc/selkies/api/websockets`)).status).toBe(401);
    expect(relay.expired).toBe(false);
  });

  test("other answers to the probe pass through", async () => {
    const { relay } = setup();
    expect((await relay.wrapFetch(respond(400))(probeUrl)).status).toBe(400);
    expect((await relay.wrapFetch(respond(502))(probeUrl)).status).toBe(502);
    expect(relay.expired).toBe(false);
  });

  test("without a parent, the page shows the ended text instead", async () => {
    const { relay, ended } = setup({ framed: false });
    const fetch = relay.wrapFetch(respond(401));
    await fetch(probeUrl);
    await fetch(probeUrl);
    expect(ended()).toBe(1);
  });

  test("a parent that pairs after expiry is told at once", async () => {
    const { relay, toParent, fromParent } = setup();
    await relay.wrapFetch(respond(401))(probeUrl);
    fromParent({ type: "sw-hello" });
    expect(toParent.map((p) => p.message)).toEqual([{ type: "sw-ready", version: 1 }, { type: "viewer-expired" }]);
  });
});

describe("helpers", () => {
  test("routePrefix matches Selkies' getRoutePrefix", () => {
    expect(routePrefix("/instances/abc/selkies/")).toBe("/instances/abc/selkies");
    expect(routePrefix("/admin/instances/abc/selkies/index.html")).toBe("/admin/instances/abc/selkies");
  });

  test("isReconnectProbe wants GET of the prefix's api/websockets on this origin", () => {
    expect(isReconnectProbe("GET", new URL(probeUrl), page())).toBe(true);
    expect(isReconnectProbe("POST", new URL(probeUrl), page())).toBe(false);
    expect(isReconnectProbe("GET", new URL(`${probeUrl}/x`), page())).toBe(false);
  });
});
