import type { Context, Next } from "hono";
import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } from "jose";
import type { AppVariables } from "../types";
import { debug } from "../utils/logger";

const jwtSecret = process.env.SUPABASE_JWT_SECRET;
const supabaseUrl = process.env.SUPABASE_URL;

if (!jwtSecret) {
  throw new Error("SUPABASE_JWT_SECRET must be set");
}
if (!supabaseUrl) {
  throw new Error("SUPABASE_URL must be set");
}

const hsSecret = new TextEncoder().encode(jwtSecret);

// Newer Supabase projects (including local dev via the CLI) sign session
// JWTs asymmetrically (ES256) and publish the verification key over JWKS,
// rather than the legacy shared HS256 secret. We support both: route on the
// token's own `alg` header so older projects still on the legacy secret
// keep working unchanged. jose's jwtVerify handles both HS256 and
// RS256/ES256, so there's no need for a separate jsonwebtoken dependency.
const jwks = createRemoteJWKSet(new URL("/auth/v1/.well-known/jwks.json", supabaseUrl));

function extractToken(c: Context<{ Variables: AppVariables }>): string | null {
  const header = c.req.header("Authorization");
  if (header?.startsWith("Bearer ")) {
    return header.slice("Bearer ".length);
  }

  const queryToken = c.req.query("token");
  if (queryToken) return queryToken;

  return null;
}

export async function verifyToken(token: string): Promise<{ sub?: string; iss?: string }> {
  const { alg } = decodeProtectedHeader(token);
  if (alg && !alg.startsWith("HS")) {
    const { payload } = await jwtVerify(token, jwks);
    return payload as { sub?: string; iss?: string };
  }
  const { payload } = await jwtVerify(token, hsSecret);
  return payload as { sub?: string; iss?: string };
}

export async function authMiddleware(c: Context<{ Variables: AppVariables }>, next: Next) {
  const token = extractToken(c);
  if (!token) {
    debug("auth", `missing token on ${c.req.method} ${c.req.path}`);
    return c.json({ error: "Missing authentication token" }, 401);
  }

  try {
    const payload = await verifyToken(token);
    if (!payload.sub) {
      debug("auth", `token missing sub on ${c.req.path}`, payload);
      return c.json({ error: "Invalid token payload" }, 401);
    }
    debug("auth", `verified token for sub=${payload.sub} iss=${payload.iss} on ${c.req.path}`);
    c.set("userId", payload.sub);
    await next();
  } catch (err) {
    debug("auth", `jwt verify failed on ${c.req.path}`, err instanceof Error ? err.message : err);
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}
