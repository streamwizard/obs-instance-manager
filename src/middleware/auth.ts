import type { Context, Next } from "hono";
import jwt from "jsonwebtoken";
import type { AppVariables } from "../types";
import { debug } from "../lib/logger";

const jwtSecret = process.env.SUPABASE_JWT_SECRET;

if (!jwtSecret) {
  throw new Error("SUPABASE_JWT_SECRET must be set");
}

function extractToken(c: Context<{ Variables: AppVariables }>): string | null {
  const header = c.req.header("Authorization");
  if (header?.startsWith("Bearer ")) {
    return header.slice("Bearer ".length);
  }

  const queryToken = c.req.query("token");
  if (queryToken) return queryToken;

  return null;
}

export async function authMiddleware(c: Context<{ Variables: AppVariables }>, next: Next) {
  const token = extractToken(c);
  if (!token) {
    debug("auth", `missing token on ${c.req.method} ${c.req.path}`);
    return c.json({ error: "Missing authentication token" }, 401);
  }

  try {
    const payload = jwt.verify(token, jwtSecret as string) as { sub?: string; iss?: string };
    if (!payload.sub) {
      debug("auth", `token missing sub on ${c.req.path}`, payload);
      return c.json({ error: "Invalid token payload" }, 401);
    }
    debug("auth", `verified token for sub=${payload.sub} iss=${payload.iss} on ${c.req.path}`);
    c.set("userId", payload.sub);
    await next();
  } catch (err) {
    debug("auth", `jwt.verify failed on ${c.req.path}`, err instanceof Error ? err.message : err);
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}
