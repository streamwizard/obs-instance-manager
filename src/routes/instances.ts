import { Hono } from "hono";
import { authMiddleware } from "@/middleware/auth";
import { requireScope } from "@/middleware/scope";
import { rateLimitByUser } from "@/middleware/rate-limit";
import { getInstanceById, listUserInstances } from "@/clients/supabase";
import { NOVNC_PORT_INTERNAL, OBS_WS_PORT_INTERNAL } from "@/clients/docker";
import { createInstanceSchema } from "@/schemas/instance";
import { instanceWsTicketSchema } from "@/schemas/ws-ticket";
import { proxyRoute } from "@/services/proxy/ws-proxy";
import { mintInstanceTicket } from "@/services/auth/instance-ticket";
import { createInstance, CreateInstanceError, InstanceProvisionError } from "@/services/instances/create-instance";
import { stopInstance } from "@/services/instances/stop-instance";
import { destroyInstance } from "@/services/instances/destroy-instance";
import { withDockerStatus } from "@/services/instances/instance-status";
import { restartInstance } from "@/services/instances/instance-lifecycle";
import { StreamKeyNotGrantedError } from "@/services/instances/twitch";
import { isInstanceLocked } from "@/utils/instance-lock";
import { KeyedRateLimiter } from "@/utils/rate-limit";
import type { AppVariables } from "@/types";

const instances = new Hono<{ Variables: AppVariables }>();

// Bounds how often one user can trigger container creation -- this is the
// one HTTP route that's actually expensive (spins up a Docker container),
// so it gets its own limiter rather than relying on WS-only throttling.
const createInstanceLimiter = new KeyedRateLimiter(5, 60_000);

// Bounds ws-ticket minting per user. Tickets are cheap to issue, but there's
// no reason to let one caller flood the store.
const wsTicketLimiter = new KeyedRateLimiter(30, 60_000);

// The WS proxy upgrades authenticate via single-use ws-tickets consumed inside
// proxyRoute -- NOT the JWT authMiddleware below. Browsers can't set an
// Authorization header on a WS upgrade, so these are registered before the
// middleware: the upgrade handler runs first and never calls next(), so the
// JWT check is skipped for them while every REST route still goes through it.
instances.get("/:id/novnc", proxyRoute(NOVNC_PORT_INTERNAL, 2000, "novnc", (id, ticket) => getInstanceById(id, ticket.userId)));
instances.get("/:id/obsws", proxyRoute(OBS_WS_PORT_INTERNAL, 10, "obsws", (id, ticket) => getInstanceById(id, ticket.userId)));

instances.use("*", authMiddleware);

// Mints a short-lived, single-use ticket that the browser then puts on the WS
// URL (?ticket=...). Ownership is enforced here while the real credential (a
// node token, or the legacy session JWT) is still in the Authorization header,
// so it never rides on the socket.
instances.post(
  "/:id/ws-ticket",
  requireScope("ws-ticket"),
  rateLimitByUser(wsTicketLimiter, "Too many ticket requests, try again later"),
  async (c) => {
    const userId = c.get("userId") as string;
    const id = c.req.param("id");

    const parsed = instanceWsTicketSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "Invalid scope" }, 400);
    }

    const instance = await getInstanceById(id, userId);
    if (!instance) return c.json({ error: "Instance not found" }, 404);

    return c.json(await mintInstanceTicket(userId, instance, parsed.data.scope));
  },
);

instances.get("/", requireScope("instances:read"), async (c) => {
  const userId = c.get("userId") as string;
  const userInstances = await listUserInstances(userId);
  return c.json(await Promise.all(userInstances.map(withDockerStatus)));
});

instances.get("/:id", requireScope("instances:read"), async (c) => {
  const userId = c.get("userId") as string;
  const id = c.req.param("id");

  const instance = await getInstanceById(id, userId);
  if (!instance) return c.json({ error: "Instance not found" }, 404);

  return c.json(await withDockerStatus(instance));
});

instances.post(
  "/",
  requireScope("instances:create"),
  rateLimitByUser(createInstanceLimiter, "Too many instance creation requests, try again later"),
  async (c) => {
    const userId = c.get("userId") as string;

    const parsed = createInstanceSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid request body" }, 400);
    }
    const body = parsed.data;

    if (!body.obs_ws_password) {
      return c.json({ error: "obs_ws_password is required" }, 400);
    }

    try {
      const created = await createInstance(userId, {
        subscriptionId: body.subscription_id,
        template: body.template,
        obsWsPassword: body.obs_ws_password,
        obsWsPasswordCiphertext: body.obs_ws_password_ciphertext ?? null,
        obsWsPasswordIv: body.obs_ws_password_iv ?? null,
        obsWsPasswordTag: body.obs_ws_password_tag ?? null,
      });
      return c.json(created, 201);
    } catch (err) {
      if (err instanceof CreateInstanceError) return c.json({ error: err.message }, err.status);
      if (err instanceof StreamKeyNotGrantedError) return c.json({ error: err.message, code: err.code }, 409);
      if (err instanceof InstanceProvisionError) return c.json({ error: err.message }, 500);
      throw err;
    }
  },
);

instances.post("/:id/start", requireScope("instances:control"), async (c) => {
  const userId = c.get("userId") as string;
  const id = c.req.param("id");

  const instance = await getInstanceById(id, userId);
  if (!instance) return c.json({ error: "Instance not found" }, 404);
  if (instance.status === "running") return c.json({ error: "Instance is already running" }, 400);
  // A second start while the first is still provisioning must not queue: it
  // would run against this (stale) row after the container is already up.
  if (isInstanceLocked(id)) return c.json({ error: "Instance operation already in progress" }, 409);

  try {
    const updated = await restartInstance(instance);
    return c.json(updated);
  } catch (err) {
    if (err instanceof StreamKeyNotGrantedError) return c.json({ error: err.message, code: err.code }, 409);
    return c.json({ error: (err as Error).message }, 500);
  }
});

instances.post("/:id/stop", requireScope("instances:control"), async (c) => {
  const userId = c.get("userId") as string;
  const id = c.req.param("id");

  const instance = await getInstanceById(id, userId);
  if (!instance) return c.json({ error: "Instance not found" }, 404);
  if (!instance.container_id) return c.json({ error: "Instance has no container" }, 400);

  return c.json(await stopInstance(instance));
});

instances.delete("/:id", requireScope("instances:delete"), async (c) => {
  const userId = c.get("userId") as string;
  const id = c.req.param("id");

  const instance = await getInstanceById(id, userId);
  if (!instance) return c.json({ error: "Instance not found" }, 404);

  await destroyInstance(instance);
  return c.json({ success: true });
});

export default instances;
