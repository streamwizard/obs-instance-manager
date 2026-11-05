import { expect, test } from "bun:test";
import { isStaticPath, tokenFromBearer, tokenFromCookie, tokenFromProtocols } from "./selkies-request";

test("static client files pass without a token", () => {
  for (const path of ["/", "/index.html", "/selkies-core.js", "/assets/index-BD8uW1M7.js", "/codecs/x.wasm", "/manifest.json"]) {
    expect(isStaticPath(path)).toBe(true);
  }
});

test("anything under /api, odd characters or path tricks need a token", () => {
  for (const path of [
    "/api",
    "/api/",
    "/api/websockets",
    "/api/screenshot",
    "/%61pi/screenshot".replace("%61", "a"),
    "/assets/../api/screenshot",
    "/assets/%2e%2e/api/screenshot",
    "/x?y",
    "/%zz",
    "",
  ]) {
    expect(isStaticPath(path)).toBe(false);
  }
});

test("the token is read from the Selkies subprotocol", () => {
  const token = "tok_abc-123";
  const encoded = Buffer.from(token).toString("base64url");
  expect(tokenFromProtocols(`selkies, selkies.token.${encoded}`)).toBe(token);
  expect(tokenFromProtocols("selkies")).toBeNull();
  expect(tokenFromProtocols(undefined)).toBeNull();
  expect(tokenFromProtocols("selkies.token.")).toBeNull();
});

test("the token is read from a Bearer header only", () => {
  expect(tokenFromBearer("Bearer tok_abc")).toBe("tok_abc");
  expect(tokenFromBearer("Basic YXBwOnB3")).toBeNull();
  expect(tokenFromBearer(undefined)).toBeNull();
});

test("the token is read from the Selkies client's own cookie", () => {
  expect(tokenFromCookie("a=1; selkies_token=tok%5Fabc; b=2")).toBe("tok_abc");
  expect(tokenFromCookie("sb-127-auth-token=x")).toBeNull();
  expect(tokenFromCookie("selkies_token=%zz")).toBeNull();
  expect(tokenFromCookie(undefined)).toBeNull();
});
