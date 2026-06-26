import { Hono, type Context, type Next } from "hono";
import { deleteInstance, getInstanceByIdAdmin, getNode, isAdmin, listNodeInstances, updateInstance } from "../clients/supabase";
import { getAllMetrics } from "../services/metrics";
import { createContainer, NOVNC_PORT_INTERNAL, OBS_WS_PORT_INTERNAL, removeContainer, startContainer, stopContainer } from "../clients/docker";
import { NODE_ID } from "../utils/node";
import { authMiddleware } from "../middleware/auth";
import { upgradeWebSocket } from "../utils/ws";
import { debug, log } from "../utils/logger";
import { pullObsConfig, pushObsConfig, removeLocalConfig, removeS3Config } from "../services/obs-config";
import { syncPlugins } from "../services/plugins";
import { proxyRoute } from "./instances";
import { STREAM_INTERVAL_MS } from "../utils/constants";
import type { AppVariables } from "../types";

const admin = new Hono<{ Variables: AppVariables }>();

// Same JWT auth every end-user route uses (authMiddleware) -- the only
// difference here is the authorization check is "has the admin role"
// instead of "owns this instance".
async function requireAdmin(c: Context<{ Variables: AppVariables }>, next: Next) {
  const userId = c.get("userId");
  if (!(await isAdmin(userId))) {
    debug("auth", `user ${userId} is not an admin, rejecting ${c.req.path}`);
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
}

admin.use("*", authMiddleware, requireAdmin);

// Node-wide metrics for every instance on this node, not just one user's —
// this is what the panel's admin Nodes page consumes, gated by the caller's
// own Supabase JWT having the admin role (same as every other route here,
// just a role check instead of an ownership check).
admin.get(
  "/metrics/stream",
  upgradeWebSocket(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

    const sendMetrics = async (ws: { send: (data: string) => void }) => {
      const nodeInstances = await listNodeInstances(NODE_ID);
      const payload = await getAllMetrics(nodeInstances);
      ws.send(JSON.stringify(payload));
      debug("ws", `metrics/stream sent payload for ${nodeInstances.length} instance(s)`);
    };

    return {
      onOpen(_event, ws) {
        debug("ws", "metrics/stream client connected");
        sendMetrics(ws).catch((err) => debug("ws", "metrics/stream send failed", err));
        interval = setInterval(() => {
          sendMetrics(ws).catch((err) => debug("ws", "metrics/stream send failed", err));
        }, STREAM_INTERVAL_MS);
      },
      onClose() {
        debug("ws", "metrics/stream client disconnected");
        if (interval) clearInterval(interval);
      },
    };
  })
);

// Admin-scoped start/stop -- same docker actions as the end-user
// /instances/:id/start|stop routes, but looked up without an owning-user
// filter since the caller's authority here comes from the admin role check,
// not instance ownership.
admin.post("/instances/:id/start", async (c) => {
  const id = c.req.param("id");

  const instance = await getInstanceByIdAdmin(id);
  if (!instance) return c.json({ error: "Instance not found" }, 404);
  if (instance.status === "running") return c.json({ error: "Instance is already running" }, 400);

  const node = await getNode(NODE_ID);

  await pullObsConfig(instance.user_id, instance.id).catch((e) =>
    log("warn", "obs config pull failed, starting with empty config", {
      instanceId: instance.id,
      error: (e as Error).message,
    })
  );

  await syncPlugins().catch((e) =>
    log("warn", "plugin sync failed, container will use cached plugins", {
      error: (e as Error).message,
    })
  );

  let containerId: string | null = null;
  try {
    containerId = await createContainer({
      instanceId: instance.id,
      containerName: instance.container_name,
      node,
      resolution: instance.resolution,
    });
    await startContainer(containerId);
    const updated = await updateInstance(id, { container_id: containerId, status: "running" });
    return c.json(updated);
  } catch (err) {
    await updateInstance(id, { status: "error" });
    if (containerId) {
      await removeContainer(containerId).catch((e) =>
        debug("docker", `cleanup of orphaned container ${containerId} failed: ${(e as Error).message}`)
      );
    }
    return c.json({ error: (err as Error).message }, 500);
  }
});

admin.post("/instances/:id/stop", async (c) => {
  const id = c.req.param("id");

  const instance = await getInstanceByIdAdmin(id);
  if (!instance) return c.json({ error: "Instance not found" }, 404);
  if (!instance.container_id) return c.json({ error: "Instance has no container" }, 400);

  await stopContainer(instance.container_id);

  await pushObsConfig(instance.user_id, instance.id).catch((e) =>
    log("warn", "obs config push failed after stop", {
      instanceId: instance.id,
      error: (e as Error).message,
    })
  );

  await removeLocalConfig(instance.id).catch((e) =>
    log("warn", "failed to remove local config dir after stop", {
      instanceId: instance.id,
      error: (e as Error).message,
    })
  );

  await removeContainer(instance.container_id).catch((e) =>
    debug("docker", `remove failed for ${id}: ${(e as Error).message}`)
  );

  const updated = await updateInstance(id, { container_id: null, status: "stopped" });

  return c.json(updated);
});

admin.delete("/instances/:id", async (c) => {
  const id = c.req.param("id");

  const instance = await getInstanceByIdAdmin(id);
  if (!instance) return c.json({ error: "Instance not found" }, 404);

  if (instance.container_id) {
    await stopContainer(instance.container_id).catch((e) =>
      debug("docker", `stop failed for ${id}: ${(e as Error).message}`)
    );

    await pushObsConfig(instance.user_id, instance.id).catch((e) =>
      log("warn", "obs config push failed before delete", {
        instanceId: instance.id,
        error: (e as Error).message,
      })
    );

    await removeLocalConfig(instance.id).catch((e) =>
      log("warn", "failed to remove local config dir before delete", {
        instanceId: instance.id,
        error: (e as Error).message,
      })
    );

    await removeContainer(instance.container_id).catch((e) =>
      debug("docker", `remove failed for ${id}: ${(e as Error).message}`)
    );
  }

  await removeS3Config(instance.user_id, instance.id).catch((e) =>
    log("warn", "S3 config removal failed", { instanceId: instance.id, error: (e as Error).message })
  );

  await deleteInstance(id);

  return c.json({ success: true });
});

// Same noVNC/obsws proxy the end-user routes expose, just backed by the
// ownership-free admin lookup so any admin can watch/control any instance
// on this node, gated by the role check above rather than instance ownership.
admin.get("/instances/:id/novnc", proxyRoute(NOVNC_PORT_INTERNAL, 200, (id) => getInstanceByIdAdmin(id)));
admin.get("/instances/:id/obsws", proxyRoute(OBS_WS_PORT_INTERNAL, 10, (id) => getInstanceByIdAdmin(id)));

export default admin;
