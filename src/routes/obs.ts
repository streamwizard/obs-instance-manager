import { Hono } from "hono";
import { commandAuthMiddleware } from "../middleware/command-auth";
import { getInstanceByIdAdmin } from "../clients/supabase";
import { executeObsCommands, validateObsCommands, ObsCommandError } from "../services/obs-command";
import { log } from "../utils/logger";
import type { AppVariables } from "../types";

const obs = new Hono<{ Variables: AppVariables }>();

obs.use("*", commandAuthMiddleware);

// Public, per-node-key-authenticated OBS control for the obs-auto-switcher.
// Reachable over the node's Cloudflare tunnel, gated by this node's obs_command
// key. The browser path stays on the ticketed blind proxy; this endpoint is the
// one place the node itself speaks obs-websocket, so the OBS password never
// leaves the node.
//
// Body: { commands: [{ request: "SetCurrentProgramScene", params: { sceneUuid } }, ...] }
// 200:  { results: [{ ok, response | error }, ...] }  (per-command outcome)
// 400 invalid/whitelisted-out request, 404 unknown instance,
// 409 instance not running, 502 obs-websocket unreachable.
obs.post("/instances/:id/command", async (c) => {
  const instanceId = c.req.param("id");

  let body: { commands?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const commands = validateObsCommands(body.commands);
    const instance = await getInstanceByIdAdmin(instanceId);
    if (!instance) {
      return c.json({ error: "Instance not found" }, 404);
    }
    const results = await executeObsCommands(instance, commands);
    return c.json({ results });
  } catch (err) {
    if (err instanceof ObsCommandError) {
      return c.json({ error: err.message }, err.status);
    }
    log("error", "obs command failed", { instanceId, error: (err as Error).message });
    return c.json({ error: "Internal error" }, 500);
  }
});

export default obs;
