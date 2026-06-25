import { describe, expect, test } from "bun:test";
import { SignJWT } from "jose";

process.env.SUPABASE_JWT_SECRET ??= "test-secret-at-least-32-bytes-long!!";
process.env.SUPABASE_URL ??= "http://localhost:54321";

const { authMiddleware, verifyToken } = await import("./auth");

const secret = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);

function signHS256(payload: Record<string, unknown>, expiresInSeconds: number): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
    .sign(secret);
}

describe("verifyToken (HS256)", () => {
  test("verifies a valid token and returns its payload", async () => {
    const token = await signHS256({ sub: "user-123" }, 60);
    const payload = await verifyToken(token);
    expect(payload.sub).toBe("user-123");
  });

  test("rejects an expired token", async () => {
    const token = await signHS256({ sub: "user-123" }, -60);
    await expect(verifyToken(token)).rejects.toThrow();
  });
});

async function runMiddleware(authHeader?: string) {
  const { Hono } = await import("hono");
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", authMiddleware);
  app.get("/", (c) => c.json({ userId: c.get("userId") }));

  const headers = authHeader ? { Authorization: authHeader } : undefined;
  return app.request("/", { headers });
}

describe("authMiddleware", () => {
  test("rejects requests with no token", async () => {
    const res = await runMiddleware();
    expect(res.status).toBe(401);
  });

  test("rejects an expired token", async () => {
    const token = await signHS256({ sub: "user-123" }, -60);
    const res = await runMiddleware(`Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  test("accepts a valid token and sets userId", async () => {
    const token = await signHS256({ sub: "user-123" }, 60);
    const res = await runMiddleware(`Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "user-123" });
  });

  test("rejects a token with no sub claim", async () => {
    const token = await signHS256({}, 60);
    const res = await runMiddleware(`Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});
