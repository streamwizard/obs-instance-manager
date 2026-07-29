import OBSWebSocket, { EventSubscription } from "obs-websocket-js";
import { instanceTarget, OBS_WS_PORT_INTERNAL } from "../clients/docker";
import { listNodeInstances } from "../clients/supabase";
import { broadcastSceneChanged } from "../clients/ws-server";
import { decryptPassword } from "../utils/crypto";
import { NODE_ID } from "../utils/node";
import { debug, log } from "../utils/logger";
import type { Instance } from "../types";

// One long-lived obs-websocket connection per *running* instance, subscribed to
// scene events only, so the platform learns the container's real program scene
// no matter who changed it -- the auto-switcher, the browser panel, the
// streamer clicking around in OBS over VNC, a hotkey, a transition.
//
// This lives on the node and talks container-to-container over obs-net, which
// is the whole point: the product promise is that the streamer's computer is
// off once OBS is set up, so nothing here may depend on a browser, panel or VNC
// session being open. (Watching the blind obsws proxy in routes/instances.ts
// would only have worked while a browser held that socket, and the /obs command
// path only ever sees the auto-switcher's own switches.)
//
// Deliberately NOT pooled into services/obs-command.ts -- that one stays
// connect-per-call for the reasons in its own comment. This module carries the
// reconnect/lifecycle burden precisely because it must stay attached.

interface Session {
  instanceId: string;
  userId: string;
  containerName: string;
  password: string;
  obs: OBSWebSocket | null;
  /** Last scene we broadcast; OBS re-emits during transitions, so we dedupe. */
  lastSceneUuid: string | null;
  attempts: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
  /** Latched so a permanently unreachable instance warns once, not every 30s. */
  warnedUnreachable: boolean;
}

const CONNECT_TIMEOUT_MS = 5_000;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;
// Same reasoning as RESTART_STAGGER_MS in clients/docker.ts: a node booting with
// N instances shouldn't open N handshakes in the same tick.
const ATTACH_STAGGER_MS = 500;

const sessions = new Map<string, Session>();

export function attachedInstanceIds(): string[] {
  return [...sessions.keys()];
}

// Idempotent. Returns immediately -- the connect (and its retry loop) runs in
// the background, because on a container "start" event OBS isn't listening yet:
// entrypoint.sh waits on Xorg readiness first, so the first several attempts
// are expected to fail and callers must not block on them.
// Note there is no `status === "running"` guard here: the docker "start" event
// beats the route's own status write to the DB, so gating on the row would miss
// every fresh container until the next resync. Callers decide -- syncInstances
// filters on status, the event path treats the container starting as proof
// enough, and a container that dies detaches regardless of what the row says.
export function attachInstance(instance: Instance): void {
  if (sessions.has(instance.id)) return;

  if (!instance.obs_ws_password_ciphertext || !instance.obs_ws_password_iv || !instance.obs_ws_password_tag) {
    log("warn", "cannot watch OBS scenes, instance has no stored websocket password", {
      instanceId: instance.id,
    });
    return;
  }

  let password: string;
  try {
    password = decryptPassword(
      instance.obs_ws_password_ciphertext,
      instance.obs_ws_password_iv,
      instance.obs_ws_password_tag,
    );
  } catch (err) {
    log("error", "cannot watch OBS scenes, password decrypt failed", {
      instanceId: instance.id,
      error: (err as Error).message,
    });
    return;
  }

  const session: Session = {
    instanceId: instance.id,
    userId: instance.user_id,
    containerName: instance.container_name,
    password,
    obs: null,
    lastSceneUuid: null,
    attempts: 0,
    retryTimer: null,
    closing: false,
    warnedUnreachable: false,
  };
  // Inserted before connecting so a second attach for the same instance (event
  // stream + resync racing) is a no-op rather than a duplicate socket.
  sessions.set(instance.id, session);

  void connect(session);
}

export function detachInstance(instanceId: string): void {
  const session = sessions.get(instanceId);
  if (!session) return;

  session.closing = true;
  if (session.retryTimer) {
    clearTimeout(session.retryTimer);
    session.retryTimer = null;
  }
  sessions.delete(instanceId);

  const obs = session.obs;
  session.obs = null;
  if (obs) {
    obs.removeAllListeners();
    obs.disconnect().catch((err) =>
      debug("obs-events", `disconnect failed for ${instanceId}: ${(err as Error).message}`),
    );
  }

  debug("obs-events", `detached ${instanceId}`);
}

export function detachAll(): void {
  for (const instanceId of [...sessions.keys()]) detachInstance(instanceId);
}

// Correctness backstop for anything the docker event stream missed (dropped
// stream, manager restart, a status flipped by reconcile rather than an event).
// Idempotent -- safe to run on boot and on an interval.
export async function syncInstances(): Promise<void> {
  const nodeInstances = await listNodeInstances(NODE_ID);
  const shouldWatch = new Map(
    nodeInstances.filter((i) => i.status === "running" && i.container_id).map((i) => [i.id, i]),
  );

  for (const instanceId of [...sessions.keys()]) {
    if (!shouldWatch.has(instanceId)) detachInstance(instanceId);
  }

  for (const instance of shouldWatch.values()) {
    if (sessions.has(instance.id)) continue;
    attachInstance(instance);
    await new Promise((resolve) => setTimeout(resolve, ATTACH_STAGGER_MS));
  }

  debug("obs-events", `sync complete, watching ${sessions.size} instance(s)`);
}

async function connect(session: Session): Promise<void> {
  if (session.closing) return;

  const obs = new OBSWebSocket();
  session.obs = obs;

  // Scenes only: this socket exists for one event, and the high-volume
  // categories (inputs, scene items, media) would be pure waste on the wire.
  obs.on("CurrentProgramSceneChanged", (data: { sceneName?: string; sceneUuid?: string }) => {
    emitScene(session, data.sceneName, data.sceneUuid);
  });
  obs.on("ConnectionClosed", () => scheduleRetry(session));
  obs.on("ConnectionError", (err: Error) => {
    debug("obs-events", `connection error on ${session.instanceId}: ${err?.message}`);
    scheduleRetry(session);
  });

  const url = `ws://${instanceTarget(session.containerName, OBS_WS_PORT_INTERNAL)}`;

  try {
    await Promise.race([
      obs.connect(url, session.password, {
        rpcVersion: 1,
        eventSubscriptions: EventSubscription.Scenes,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("obs-websocket connect timeout")), CONNECT_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    // Disconnect explicitly: if the timeout won the race the underlying connect
    // may still land, and an orphaned socket would keep its listeners.
    obs.disconnect().catch(() => {});
    debug("obs-events", `connect failed for ${session.instanceId}: ${(err as Error).message}`);
    scheduleRetry(session);
    return;
  }

  if (session.closing) {
    obs.disconnect().catch(() => {});
    return;
  }

  session.attempts = 0;
  session.warnedUnreachable = false;
  log("info", "watching OBS scene changes", { instanceId: session.instanceId });

  // Seed the current scene on every (re)connect and push it: ws-server has no
  // replay, so a container that just started -- or an overlay that reloaded
  // while we were disconnected -- would otherwise have nothing to render until
  // the streamer happened to switch.
  try {
    const scene = (await obs.call("GetCurrentProgramScene")) as {
      sceneName?: string;
      sceneUuid?: string;
      currentProgramSceneName?: string;
      currentProgramSceneUuid?: string;
    };
    emitScene(
      session,
      scene.sceneName ?? scene.currentProgramSceneName,
      scene.sceneUuid ?? scene.currentProgramSceneUuid,
    );
  } catch (err) {
    debug("obs-events", `seed scene failed for ${session.instanceId}: ${(err as Error).message}`);
  }
}

function emitScene(session: Session, sceneName: string | undefined, sceneUuid: string | undefined): void {
  if (!sceneUuid || !sceneName) return;
  if (sceneUuid === session.lastSceneUuid) return;

  session.lastSceneUuid = sceneUuid;
  broadcastSceneChanged(session.userId, session.instanceId, sceneName, sceneUuid);
  debug("obs-events", `${session.instanceId} scene -> ${sceneName}`);
}

function scheduleRetry(session: Session): void {
  if (session.closing || session.retryTimer) return;

  // A dead socket must not keep firing ConnectionClosed into a fresh attempt.
  if (session.obs) {
    session.obs.removeAllListeners();
    session.obs = null;
  }
  // The scene we last saw is no longer authoritative -- OBS may come back on a
  // different one, and that must not be deduped away.
  session.lastSceneUuid = null;

  const delay = Math.min(RETRY_BASE_MS * 2 ** session.attempts, RETRY_MAX_MS);
  session.attempts += 1;

  // The first ~30s of failures are normal (OBS booting behind Xorg), so they
  // stay at debug. Once backoff saturates, the instance is genuinely
  // unreachable and deserves one warn -- not one every 30s forever.
  if (delay >= RETRY_MAX_MS && !session.warnedUnreachable) {
    session.warnedUnreachable = true;
    log("warn", "OBS scene listener cannot reach instance, still retrying", {
      instanceId: session.instanceId,
      attempts: session.attempts,
    });
  }

  session.retryTimer = setTimeout(() => {
    session.retryTimer = null;
    void connect(session);
  }, delay);
  session.retryTimer.unref?.();
}
