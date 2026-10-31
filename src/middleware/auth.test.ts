import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import type { AppVariables, Node } from "../types";

process.env.SUPABASE_URL ??= "http://127.0.0.1:1";
process.env.NODE_ID ??= "node-a";

const ISSUER = "streamwizard-node-token";

interface TestKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
}

async function makeKey(): Promise<TestKey> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, publicJwk: { ...jwk, kid: await calculateJwkThumbprint(jwk), alg: "EdDSA" } };
}

let keyA: TestKey;
let keyB: TestKey;
let liveKeys: JWK[] = [];
let cachedKeys: JWK[] = [];
let refreshCalls = 0;

function node(keys: JWK[]): Node {
  return { id: "node-a", node_token_jwks: keys.length ? { keys } : null } as Node;
}

// The node row is the only source of public keys, so mocking the cache is
// mocking the key delivery: getCachedNode is the warm copy, refreshNode the
// live /me read a rotation needs.
mock.module("../services/node-cache", () => ({
  getCachedNode: async () => node(cachedKeys),
  refreshNode: async () => {
    refreshCalls++;
    cachedKeys = liveKeys;
    return node(liveKeys);
  },
}));

const { authMiddleware } = await import("./auth");
const { requireScope } = await import("./scope");
const { resetNodeTokenState } = await import("../services/node-token");

const app = new Hono<{ Variables: AppVariables }>();
app.use("*", authMiddleware);
app.post("/instances/:id/start", requireScope("instances:control"), (c) =>
  c.json({ userId: c.get("userId"), scope: c.get("nodeToken")?.scope ?? null }),
);
app.get("/instances", requireScope("instances:read"), (c) => c.json({ ok: true }));

const legacy = new Hono<{ Variables: AppVariables }>();
legacy.use("*", async (c, next) => {
  c.set("userId", "user-1");
  c.set("nodeToken", null);
  await next();
});
legacy.post("/instances/:id/start", requireScope("instances:control"), (c) => c.json({ ok: true }));

interface Claims {
  aud?: string;
  scope?: string;
  iid?: string;
  role?: string;
  sub?: string;
  iatOffset?: number;
  exp?: number;
}

function sign(key: TestKey, claims: Claims = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000) + (claims.iatOffset ?? 0);
  const body: Record<string, unknown> = { scope: claims.scope ?? "instances:control", role: claims.role ?? "user" };
  if (claims.iid !== "") body.iid = claims.iid ?? "i-42";
  return new SignJWT(body)
    .setProtectedHeader({ alg: "EdDSA", kid: key.publicJwk.kid })
    .setIssuer(ISSUER)
    .setAudience(claims.aud ?? "node-a")
    .setSubject(claims.sub ?? "user-1")
    .setIssuedAt(now)
    .setExpirationTime(claims.exp ?? now + 60)
    .sign(key.privateKey);
}

function call(token: string, path = "/instances/i-42/start", method = "POST", target = app) {
  return target.request(path, { method, headers: { Authorization: `Bearer ${token}` } });
}

beforeAll(async () => {
  keyA = await makeKey();
  keyB = await makeKey();
});

beforeEach(() => {
  liveKeys = [keyA.publicJwk];
  cachedKeys = [keyA.publicJwk];
  refreshCalls = 0;
  resetNodeTokenState();
});

describe("node tokens", () => {
  it("accepts a token for this node, this action and this instance", async () => {
    const res = await call(await sign(keyA));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "user-1", scope: "instances:control" });
  });

  it("rejects a token made for another node", async () => {
    expect((await call(await sign(keyA, { aud: "node-b" }))).status).toBe(401);
  });

  it("rejects a token signed by a key this node doesn't know", async () => {
    expect((await call(await sign(keyB))).status).toBe(401);
  });

  it("rejects an edited token", async () => {
    const [header, , signature] = (await sign(keyA, { aud: "node-b" })).split(".");
    const now = Math.floor(Date.now() / 1000);
    const forged = Buffer.from(
      JSON.stringify({ iss: ISSUER, aud: "node-a", sub: "user-1", scope: "instances:control", iid: "i-42", role: "user", iat: now, exp: now + 60 }),
    ).toString("base64url");
    expect((await call(`${header}.${forged}.${signature}`)).status).toBe(401);
  });

  it("rejects an HS256 token keyed with the public key (alg confusion)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ scope: "instances:control", role: "user", iid: "i-42" })
      .setProtectedHeader({ alg: "HS256", kid: keyA.publicJwk.kid })
      .setIssuer(ISSUER)
      .setAudience("node-a")
      .setSubject("user-1")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(new TextEncoder().encode(keyA.publicJwk.x));
    expect((await call(token)).status).toBe(401);
  });

  it("rejects a token older than a minute, even with a later exp", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await call(await sign(keyA, { iatOffset: -120, exp: now + 3600 }))).status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await call(await sign(keyA, { iatOffset: -90, exp: now - 30 }))).status).toBe(401);
  });

  it("rejects unknown scopes and roles", async () => {
    expect((await call(await sign(keyA, { scope: "everything" }))).status).toBe(401);
    expect((await call(await sign(keyA, { role: "owner" }))).status).toBe(401);
  });

  it("refuses a token for a different action", async () => {
    expect((await call(await sign(keyA, { scope: "files" }))).status).toBe(403);
    expect((await call(await sign(keyA, { scope: "admin:instances", role: "admin" }))).status).toBe(403);
  });

  it("refuses a token for a different instance, or for none", async () => {
    expect((await call(await sign(keyA, { iid: "i-77" }))).status).toBe(403);
    expect((await call(await sign(keyA, { iid: "" }))).status).toBe(403);
  });

  it("allows node-wide routes without an instance", async () => {
    const res = await call(await sign(keyA, { scope: "instances:read", iid: "" }), "/instances", "GET");
    expect(res.status).toBe(200);
  });

  it("picks up a rotated key with one refresh", async () => {
    liveKeys = [keyA.publicJwk, keyB.publicJwk];
    expect((await call(await sign(keyB))).status).toBe(200);
    expect(refreshCalls).toBe(1);
    // Now cached: no further refresh.
    expect((await call(await sign(keyB))).status).toBe(200);
    expect(refreshCalls).toBe(1);
  });

  it("rate-limits refreshes for unknown keys", async () => {
    const stranger = await makeKey();
    expect((await call(await sign(stranger))).status).toBe(401);
    expect((await call(await sign(stranger))).status).toBe(401);
    expect(refreshCalls).toBe(1);
  });

  it("rejects every node token until keys are provisioned", async () => {
    liveKeys = [];
    cachedKeys = [];
    expect((await call(await sign(keyA))).status).toBe(401);
  });
});

describe("legacy session JWT", () => {
  it("is still verified against Supabase, not as a node token", async () => {
    const bogus = `${Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url")}.${Buffer.from(
      JSON.stringify({ iss: "http://127.0.0.1:1/auth/v1", sub: "user-1" }),
    ).toString("base64url")}.sig`;
    expect((await call(bogus)).status).toBe(401);
  });

  it("passes requireScope, since it carries no scope", async () => {
    const res = await legacy.request("/instances/i-42/start", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
