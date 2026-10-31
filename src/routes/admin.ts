import { Hono } from "hono";
import { getInstanceByIdAdmin } from "@/clients/supabase";
import { NOVNC_PORT_INTERNAL, OBS_WS_PORT_INTERNAL } from "@/clients/docker";
import { authMiddleware } from "@/middleware/auth";
import { requireAdmin } from "@/middleware/require-admin";
import { requireScope } from "@/middleware/scope";
import { rateLimitByUser } from "@/middleware/rate-limit";
import { instanceWsTicketSchema, metricsWsTicketSchema } from "@/schemas/ws-ticket";
import { issueTicket } from "@/services/auth/ws-tickets";
import { mintInstanceTicket } from "@/services/auth/instance-ticket";
import { metricsStreamHandler } from "@/services/metrics/metrics-stream";
import { proxyRoute } from "@/services/proxy/ws-proxy";
import { restartInstance } from "@/services/instances/instance-lifecycle";
import { stopInstance } from "@/services/instances/stop-instance";
import { destroyInstance } from "@/services/instances/destroy-instance";
import { StreamKeyNotGrantedError } from "@/services/instances/twitch";
import { isInstanceLocked } from "@/utils/instance-lock";
import { KeyedRateLimiter } from "@/utils/rate-limit";
import type { AppVariables } from "@/types";

const admin = new Hono<{ Variables: AppVariables }>();

// Separate budget from the end-user ws-ticket limiter in routes/instances.ts.
const wsTicketLimiter = new KeyedRateLimiter(30, 60_000);
const wsTicketRateLimit = rateLimitByUser(wsTicketLimiter, "Too many ticket requests, try again later");

// WS upgrades (metrics/novnc/obsws) authenticate via single-use ws-tickets
// consumed in their handlers, NOT the JWT middleware below -- browsers can't
// send an Authorization header on a WS upgrade. Registered before admin.use()
// so the upgrade handler runs first and the JWT/admin check is skipped for
// them, while every REST route still goes through it. The admin role was
// already enforced at mint time (POST /admin/.../ws-ticket).
admin.get("/metrics/stream", metricsStreamHandler);
admin.get("/instances/:id/novnc", proxyRoute(NOVNC_PORT_INTERNAL, 200, "novnc", (id) => getInstanceByIdAdmin(id)));
admin.get("/instances/:id/obsws", proxyRoute(OBS_WS_PORT_INTERNAL, 10, "obsws", (id) => getInstanceByIdAdmin(id)));

admin.use("*", authMiddleware, requireAdmin);

// Mints the single-use ws-tickets the browser puts on the WS URL. Admin role
// is enforced here (via requireAdmin) while the real credential is still in
// the Authorization header -- it never rides on the socket.
admin.post("/ws-ticket", requireScope("admin:ws-ticket"), wsTicketRateLimit, async (c) => {
  const userId = c.get("userId") as string;

  const parsed = metricsWsTicketSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Invalid scope" }, 400);
  }

  const ticket = issueTicket({ userId, scope: "metrics" });
  return c.json({ ticket, expires_in: 30 });
});

admin.post("/instances/:id/ws-ticket", requireScope("admin:ws-ticket"), wsTicketRateLimit, async (c) => {
  const userId = c.get("userId") as string;
  const id = c.req.param("id");

  const parsed = instanceWsTicketSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Invalid scope" }, 400);
  }

  const instance = await getInstanceByIdAdmin(id);
  if (!instance) return c.json({ error: "Instance not found" }, 404);

  return c.json(await mintInstanceTicket(userId, instance, parsed.data.scope));
});

// Admin-scoped start/stop/delete -- same flows as the end-user
// /instances/:id/* routes, but looked up without an owning-user filter since
// the caller's authority here comes from the admin role check, not instance
// ownership.
admin.post("/instances/:id/start", requireScope("admin:instances"), async (c) => {
  const id = c.req.param("id");

  const instance = await getInstanceByIdAdmin(id);
  if (!instance) return c.json({ error: "Instance not found" }, 404);
  if (instance.status === "running") return c.json({ error: "Instance is already running" }, 400);
  if (isInstanceLocked(id)) return c.json({ error: "Instance operation already in progress" }, 409);

  try {
    const updated = await restartInstance(instance);
    return c.json(updated);
  } catch (err) {
    if (err instanceof StreamKeyNotGrantedError) return c.json({ error: err.message, code: err.code }, 409);
    return c.json({ error: (err as Error).message }, 500);
  }
});

admin.post("/instances/:id/stop", requireScope("admin:instances"), async (c) => {
  const id = c.req.param("id");

  const instance = await getInstanceByIdAdmin(id);
  if (!instance) return c.json({ error: "Instance not found" }, 404);
  if (!instance.container_id) return c.json({ error: "Instance has no container" }, 400);

  return c.json(await stopInstance(instance));
});

admin.delete("/instances/:id", requireScope("admin:instances"), async (c) => {
  const id = c.req.param("id");

  const instance = await getInstanceByIdAdmin(id);
  if (!instance) return c.json({ error: "Instance not found" }, 404);

  await destroyInstance(instance);
  return c.json({ success: true });
});

export default admin;
