// Browser entry of the viewer relay (relay.ts), bundled into one classic
// script by viewer-page.ts. It runs in <head>, before the Selkies client
// module, so its fetch wrapper is in place when the client's auth guard binds
// window.fetch.
import { blockRawPointerUpdates, createRelay, type CoreMessage, type ParentMessage, type RelayMessage } from "./relay";

// The few DOM members used here. OIM type-checks without the DOM lib.
interface Target {
  postMessage(message: unknown, targetOrigin: string): void;
}
interface Element {
  id: string;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
}
interface RelayWindow extends Target {
  parent: Target;
  location: { href: string; origin: string; pathname: string };
  fetch: Parameters<ReturnType<typeof createRelay>["wrapFetch"]>[0];
  __SW_PANEL_ORIGINS?: unknown;
  addEventListener(
    type: string,
    listener: (event: { data: unknown; origin: string; source: unknown; stopImmediatePropagation(): void }) => void,
    options?: { capture: boolean },
  ): void;
}
interface RelayDocument {
  body: { append(node: Element): void } | null;
  createElement(tag: string): Element;
  getElementById(id: string): Element | null;
}

const win = globalThis as unknown as RelayWindow;
const doc = (globalThis as unknown as { document: RelayDocument }).document;

const ENDED_ID = "sw-viewer-ended";
const ENDED_STYLE =
  "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;" +
  "background:#000;color:#fffc;font:14px/1.5 system-ui,sans-serif;text-align:center";

function showEnded() {
  if (!doc.body || doc.getElementById(ENDED_ID)) return;
  const notice = doc.createElement("div");
  notice.id = ENDED_ID;
  notice.setAttribute("style", ENDED_STYLE);
  notice.textContent = "Viewer session ended. Reopen it from your dashboard.";
  doc.body.append(notice);
}

const framed = win.parent !== (win as Target);

const relay = createRelay({
  origins: win.__SW_PANEL_ORIGINS,
  location: () => win.location,
  self: win,
  parent: framed ? win.parent : null,
  // The client only accepts messages whose origin is its own.
  postToCore: (message: CoreMessage) => win.postMessage(message, win.location.origin),
  postToParent: (target: unknown, message: ParentMessage | RelayMessage, origin: string) =>
    (target as Target).postMessage(message, origin),
  showEnded,
  warn: (text: string) => console.warn(text),
});

win.fetch = relay.wrapFetch(win.fetch.bind(win));
if (framed) blockRawPointerUpdates(win);
win.addEventListener("message", (event) => relay.handleMessage(event));
