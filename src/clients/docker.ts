import Docker from "dockerode";
import { debug, log } from "../utils/logger";
import { PLUGINS_LOCAL_DIR } from "../services/plugins";
import { getInstanceByIdAdmin, listNodeInstances, updateInstance, updateInstanceByContainerId } from "./supabase";
import { trackInstanceEvent } from "../services/influx-metrics";
import { StreamwizardApi } from "./streamwizard-api";
import type { Instance, InstanceStatus } from "../types";

// Imported lazily to avoid a circular dependency (obs-config imports s3, s3
// imports logger, docker imports supabase — all fine, but obs-config also
// uses docker indirectly via routes). Calling these at event-time is safe.
let _pushObsConfig: ((userId: string, instanceId: string) => Promise<void>) | null = null;
let _removeLocalConfig: ((instanceId: string) => Promise<void>) | null = null;

export function registerConfigHandlers(
  push: (userId: string, instanceId: string) => Promise<void>,
  remove: (instanceId: string) => Promise<void>
): void {
  _pushObsConfig = push;
  _removeLocalConfig = remove;
}

// Same lazy-registration trick as registerConfigHandlers above, for the same
// reason: instance-lifecycle.ts imports createContainer/startContainer/
// removeContainer from this module, so this module can't statically import
// restartInstance back from there without a cycle.
let _restartInstance: ((instance: Instance) => Promise<Instance>) | null = null;

export function registerInstanceLifecycleHandlers(
  restart: (instance: Instance) => Promise<Instance>
): void {
  _restartInstance = restart;
}

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

// Container IDs currently being stopped via the API routes. The die event
// handler skips its own push+cleanup for these since the API route handles it.
const apiStoppingContainers = new Set<string>();

const IMAGE = "ghcr.io/streamwizard/obs-cloud-container:latest";

// Shared user-defined network joined by both the api container and every
// instance container, so the api can reach instances by container name over
// Docker's embedded DNS instead of publishing per-instance ports to the host.
const NETWORK_NAME = process.env.OBS_NETWORK || "obs-net";

export const VNC_PORT_INTERNAL = 5900;
export const NOVNC_PORT_INTERNAL = 6080;
export const OBS_WS_PORT_INTERNAL = 4455;

export { docker };

async function ensureImagePulled(image: string): Promise<void> {
  // Always try to pull first -- "latest" only means anything if we actually
  // check for a newer version each time. A previous version of this function
  // skipped the pull whenever *any* local image already existed under that
  // tag, which silently kept reusing a stale cached image forever once one
  // had been pulled once; only fall back to whatever's cached locally if the
  // pull itself fails (no network/registry access, or a local-only tag used
  // for manual dev testing with no real upstream).
  try {
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (followErr: Error | null) => {
          if (followErr) return reject(followErr);
          resolve();
        });
      });
    });
  } catch (pullErr) {
    await docker.getImage(image).inspect().catch(() => {
      throw pullErr;
    });
    log("warn", "image pull failed, using local cached image", {
      image,
      error: (pullErr as Error).message,
    });
  }
}

// Named volume backing the shared gpu-xserver's X11 socket directory --
// gpu-xserver itself is a plain static service in this repo's own
// docker-compose.yml (one per machine/GPU, alongside `api`/`cadvisor`), not
// something this API provisions at runtime. Read-only here since every
// instance container only ever consumes that socket via VirtualGL, never
// creates it.
const GPU_XSOCKET_VOLUME = "gpu-x11-socket";

export interface CreateContainerOptions {
  instanceId: string;
  containerName: string;
  resolution: string;
  obsWsPassword: string;
  vncPassword: string;
  memory_mb: number;
  cpu_quota: number;
  shm_size: string;
}

export async function createContainer(
  opts: CreateContainerOptions
): Promise<string> {
  const { instanceId, containerName, resolution, obsWsPassword, vncPassword, memory_mb, cpu_quota, shm_size } = opts;

  await ensureImagePulled(IMAGE);

  const memoryBytes = memory_mb * 1024 * 1024;

  const container = await docker.createContainer({
    name: containerName,
    Image: IMAGE,
    Env: [
      `RESOLUTION=${resolution}`,
      `VNC_PORT=${VNC_PORT_INTERNAL}`,
      `NOVNC_PORT=${NOVNC_PORT_INTERNAL}`,
      `OBS_WEBSOCKET_PORT=${OBS_WS_PORT_INTERNAL}`,
      `OBS_WEBSOCKET_PASSWORD=${obsWsPassword}`,
      `VNC_PASSWORD=${vncPassword}`,
      // :10, not :0 -- :0 is reserved for the shared gpu-xserver's real
      // Xorg (see docker-compose.yml); each instance's own Xvfb lives here.
      `DISPLAY_NUM=:10`,
      `OBS_BROWSER_EXTRA_FLAGS=--no-sandbox --disable-dev-shm-usage --disable-gpu`,
    ],
    HostConfig: {
      Runtime: "nvidia",
      ShmSize: parseShmSize(shm_size),
      // SYS_ADMIN is required by OBS's browser-source plugin, which ships a
      // setuid-root chrome-sandbox binary (standard Chromium sandboxing).
      // NET_ADMIN and SYS_PTRACE are required because bwrap (entrypoint.sh)
      // acquires its capability bundle via a single capset() call that fails
      // entirely if any one of SYS_ADMIN/NET_ADMIN/SYS_PTRACE/SETUID/SETGID/
      // SYS_CHROOT is missing from the container's capability set.
      CapAdd: ["SYS_ADMIN", "NET_ADMIN", "SYS_PTRACE"],
      // Docker's default AppArmor and seccomp profiles both block the
      // userns/capset syscalls bwrap needs to jail OBS (entrypoint.sh),
      // independent of CapAdd above. Unconfined here only relaxes MAC/syscall
      // filtering inside this already-isolated container.
      SecurityOpt: ["apparmor=unconfined", "seccomp=unconfined"],
      // Pin swap to the memory limit so a container can't exceed it by swapping.
      Memory: memoryBytes,
      MemoryReservation: memoryBytes,
      MemorySwap: memoryBytes,

      NanoCpus: Math.round(cpu_quota * 1000000000),

      Binds: [
        `/data/obs-configs/${instanceId}/obs-studio:/home/app/.config/obs-studio`,
        // Shared, read-only across all instances on this node — synced once via
        // syncPlugins() instead of duplicating plugin binaries per instance.
        `${PLUGINS_LOCAL_DIR}:/home/app/.config/obs-studio/plugins:ro`,
        // Read-only: this instance only ever consumes the shared gpu-xserver's
        // X11 socket (a static service in docker-compose.yml), never creates it.
        `${GPU_XSOCKET_VOLUME}:/opt/gpu-xsocket:ro`,
        // Persists whatever the user drops into OBS's media folder (Add
        // Source > local files, etc.) across stop/start -- synced to S3
        // alongside the obs-studio config, see obs-config.ts.
        `/data/obs-configs/${instanceId}/media:/home/app/media`,
      ],

      DeviceRequests: [
        {
          Driver: "nvidia",
          Count: -1,
          // FIX: Wrap the strings in a nested array to satisfy the string[][] type definition
          Capabilities: [["gpu", "utility", "video", "display"]],
        },
      ],
    },
    ExposedPorts: {
      [`${VNC_PORT_INTERNAL}/tcp`]: {},
      [`${NOVNC_PORT_INTERNAL}/tcp`]: {},
      [`${OBS_WS_PORT_INTERNAL}/tcp`]: {},
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [NETWORK_NAME]: {},
      },
    },
  });

  return container.id;
}

// Address used by the api container to reach an instance's internal ports
// over the shared `obs-net` network (instances are never published to the host).
export function instanceTarget(containerName: string, port: number): string {
  return `${containerName}:${port}`;
}

export function parseShmSize(shmSize: string): number {
  const match = /^(\d+)([kmg]?)b?$/i.exec(shmSize.trim());
  if (!match) throw new Error(`Invalid shm_size: ${shmSize}`);
  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === "g" ? 1024 ** 3 : unit === "m" ? 1024 ** 2 : unit === "k" ? 1024 : 1;
  return value * multiplier;
}

export async function startContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.start();
}

export async function stopContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.stop({ t: 10 });
}

export async function removeContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.remove({ force: true });
}

export type DockerStatus = "running" | "stopped" | "not_found" | "unknown";

export async function getContainerStatus(containerId: string): Promise<DockerStatus> {
  try {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    return info.State.Running ? "running" : "stopped";
  } catch (err: any) {
    if (err?.statusCode === 404) return "not_found";
    // Docker daemon unreachable or some other transient failure -- don't
    // let one bad inspect() crash the whole GET /instances listing.
    debug("docker", `failed to inspect ${containerId}: ${err?.message ?? err}`);
    return "unknown";
  }
}

export interface ReconcileInstanceResult {
  instance_id: string;
  action: "marked_error" | "marked_running" | "marked_stopped" | "restarted" | "restart_failed" | "no_change";
}

// Sequential delay between restart attempts during reconciliation, so a node
// coming back up after an outage doesn't slam the GPU/CPU with N simultaneous
// OBS launches at once.
const RESTART_STAGGER_MS = 3000;

// Boot-time reconciliation: cross-checks running OBS containers against
// the DB so a restarted API process doesn't operate on stale state (e.g.
// after a crash mid-create, or a container stopped/removed out-of-band).
// Instances the DB still expects to be running are auto-resumed (see
// restartInstance in instance-lifecycle.ts) rather than just marked error,
// so a node reboot or manager crash doesn't strand every paying customer's
// session until an operator notices.
export async function reconcileContainers(nodeId: string): Promise<void> {
  const nodeInstances = await listNodeInstances(nodeId);
  const knownContainerIds = new Set(
    nodeInstances.map((i) => i.container_id).filter((id): id is string => !!id)
  );

  const dockerContainers = await docker.listContainers({
    all: true,
    filters: { name: ["obs-instance-"] },
  });

  const orphanedContainers: string[] = [];

  for (const container of dockerContainers) {
    if (!knownContainerIds.has(container.Id)) {
      log("warn", "orphaned container with no matching DB record", {
        containerId: container.Id,
        names: container.Names,
      });
      orphanedContainers.push(container.Id);
    }
  }

  const instanceResults: ReconcileInstanceResult[] = [];

  for (const instance of nodeInstances) {
    if (!instance.container_id) continue;

    const status = await getContainerStatus(instance.container_id);
    if (status === "unknown") continue;

    if (status === "not_found" && instance.status === "running") {
      log("warn", "instance container missing but DB expects it running, attempting restart", {
        instanceId: instance.id,
      });
      if (_restartInstance) {
        try {
          await _restartInstance(instance);
          log("info", "instance auto-resumed after reconcile", { instanceId: instance.id });
          instanceResults.push({ instance_id: instance.id, action: "restarted" });
          trackInstanceEvent(nodeId, instance.id, instance.user_id, "auto_restarted", { reason: "reconcile" });
        } catch (e) {
          log("error", "instance auto-resume failed, marked error", {
            instanceId: instance.id,
            error: (e as Error).message,
          });
          instanceResults.push({ instance_id: instance.id, action: "restart_failed" });
          trackInstanceEvent(nodeId, instance.id, instance.user_id, "restart_failed", { reason: "reconcile" });
        }
        await new Promise((resolve) => setTimeout(resolve, RESTART_STAGGER_MS));
      } else {
        await updateInstance(instance.id, { status: "error" });
        log("warn", "instance container missing, marked error (no restart handler registered)", { instanceId: instance.id });
        instanceResults.push({ instance_id: instance.id, action: "marked_error" });
        trackInstanceEvent(nodeId, instance.id, instance.user_id, "crash", { reason: "reconcile" });
      }
    } else if (status === "not_found" && instance.status !== "error") {
      await updateInstance(instance.id, { status: "error" });
      log("warn", "instance container missing, marked error", { instanceId: instance.id });
      instanceResults.push({ instance_id: instance.id, action: "marked_error" });
      trackInstanceEvent(nodeId, instance.id, instance.user_id, "crash", { reason: "reconcile" });
    } else if (status === "running" && instance.status !== "running") {
      await updateInstance(instance.id, { status: "running" });
      log("info", "instance container running, resynced status", { instanceId: instance.id });
      instanceResults.push({ instance_id: instance.id, action: "marked_running" });
    } else if (status === "stopped" && instance.status === "running") {
      await updateInstance(instance.id, { status: "stopped" });
      log("info", "instance container stopped, resynced status", { instanceId: instance.id });
      instanceResults.push({ instance_id: instance.id, action: "marked_stopped" });
    } else {
      instanceResults.push({ instance_id: instance.id, action: "no_change" });
    }
  }

  await reportReconcile(nodeId, orphanedContainers, instanceResults);
}

async function reportReconcile(
  nodeId: string,
  orphanedContainers: string[],
  instances: ReconcileInstanceResult[]
): Promise<void> {
  if (!process.env.REST_API_URL) {
    debug("reconcile", "REST_API_URL not set, skipping reconcile report");
    return;
  }

  try {
    await StreamwizardApi.post("/api/nodes/reconcile", {
      reconciled_at: new Date().toISOString(),
      orphaned_containers: orphanedContainers,
      instances,
    });
  } catch {
    // error already logged by the response interceptor
  }
}

const EVENT_RECONNECT_DELAY_MS = 5000;

// The one real GPU-bound Xorg, shared by every instance via VirtualGL (see
// docker-compose.yml). If it restarts, every instance's render connection to
// it dies and OBS crashes inside each of them -- container name is fixed
// (one compose stack = one machine = one GPU), so this can be matched by name.
const GPU_XSERVER_CONTAINER_NAME = "gpu-xserver";

// If an obs-instance-* container dies within this long after gpu-xserver
// itself died, its crash is attributed to the gpu-xserver outage and it's
// queued for auto-resume once gpu-xserver is back, rather than left "error"
// for an operator to notice.
const GPU_XSERVER_DIE_CORRELATION_WINDOW_MS = 15_000;

// Grace period after gpu-xserver's container "start" event before attempting
// to resume affected instances -- entrypoint.sh's own internal Xorg-readiness
// wait (see ROLE=gpu-xserver) budgets up to ~20s, so this leaves margin for
// the shared X server to actually be usable before instances try to attach.
const GPU_XSERVER_RECOVERY_GRACE_MS = 25_000;

let gpuXserverDownSince: number | null = null;
// instanceId -> nodeId, so recovery can look the instance up again (state
// may have moved on) without needing to keep a live Instance object around.
const pendingGpuRecovery = new Map<string, string>();

// Live counterpart to reconcileContainers: subscribes to Docker's event
// stream so a container that dies between reconciliation runs (crash, OOM
// kill, manual `docker stop` outside the API) updates the DB immediately
// instead of waiting for the next restart. Also watches gpu-xserver's own
// die/start events to auto-resume instances that crashed because of it (see
// GPU_XSERVER_CONTAINER_NAME above). Reconnects on stream errors/EOF since a
// dropped connection would otherwise silently stop all live updates.
export function startEventListener(): void {
  docker.getEvents(
    { filters: JSON.stringify({ type: ["container"], event: ["die", "start"] }) },
    (err, stream) => {
      if (err || !stream) {
        log("error", "failed to attach docker event listener, retrying", {
          error: err?.message,
          retryMs: EVENT_RECONNECT_DELAY_MS,
        });
        setTimeout(startEventListener, EVENT_RECONNECT_DELAY_MS);
        return;
      }

      log("info", "docker event listener attached");

      stream.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          handleGpuXserverEvent(line).catch((e) =>
            debug("docker", `failed to handle gpu-xserver event: ${e?.message ?? e}`)
          );
          handleContainerDieEvent(line).catch((e) =>
            debug("docker", `failed to handle container die event: ${e?.message ?? e}`)
          );
        }
      });

      stream.on("error", (streamErr: Error) => {
        log("warn", "docker event stream errored, reconnecting", {
          error: streamErr.message,
          retryMs: EVENT_RECONNECT_DELAY_MS,
        });
        setTimeout(startEventListener, EVENT_RECONNECT_DELAY_MS);
      });

      stream.on("end", () => {
        log("warn", "docker event stream ended, reconnecting", { retryMs: EVENT_RECONNECT_DELAY_MS });
        setTimeout(startEventListener, EVENT_RECONNECT_DELAY_MS);
      });
    }
  );
}

async function handleContainerDieEvent(rawLine: string): Promise<void> {
  const event = JSON.parse(rawLine);
  // The event stream now also carries "start" events (for gpu-xserver
  // recovery, see handleGpuXserverEvent/startEventListener) -- this handler
  // only cares about "die".
  if (event.Action !== "die") return;

  const containerName: string = (event.Actor?.Attributes?.name ?? "").replace(/^\//, "");
  if (!containerName.startsWith("obs-instance-")) return;

  const containerId: string | undefined = event.Actor?.ID;
  if (!containerId) return;

  const exitCode = Number(event.Actor?.Attributes?.exitCode ?? -1);
  // 0 = clean exit, 143 = SIGTERM (docker stop), both are normal stops.
  const status: InstanceStatus = exitCode === 0 || exitCode === 143 ? "stopped" : "error";

  const updated = await updateInstanceByContainerId(containerId, { status, container_id: null });
  if (!updated) return;

  log("info", "instance container exited, synced status", {
    instanceId: updated.id,
    containerId,
    exitCode,
    status,
  });

  // If this died shortly after gpu-xserver itself went down, its crash is
  // almost certainly a side effect of losing the shared X/VirtualGL
  // connection rather than something wrong with the instance itself -- queue
  // it for auto-resume once gpu-xserver is confirmed back (see
  // handleGpuXserverEvent).
  const gpuCorrelated =
    status === "error" &&
    gpuXserverDownSince !== null &&
    Date.now() - gpuXserverDownSince <= GPU_XSERVER_DIE_CORRELATION_WINDOW_MS;

  trackInstanceEvent(updated.node_id, updated.id, updated.user_id, status === "error" ? "crash" : "stopped", {
    exitCode,
    reason: gpuCorrelated ? "gpu_xserver_outage" : undefined,
  });

  if (gpuCorrelated) {
    pendingGpuRecovery.set(updated.id, updated.node_id);
    log("info", "instance crash attributed to gpu-xserver outage, queued for auto-resume", {
      instanceId: updated.id,
    });
  }

  // Push config to S3 for containers that died out-of-band (not via the
  // /stop route, which handles this itself). If container_id was already
  // null the record wasn't found above, so this only runs for genuine
  // out-of-band exits.
  if (_pushObsConfig && _removeLocalConfig) {
    await _pushObsConfig(updated.user_id, updated.id).catch((e) =>
      log("warn", "obs config push failed after out-of-band container exit", {
        instanceId: updated.id,
        error: (e as Error).message,
      })
    );
    await _removeLocalConfig(updated.id).catch((e) =>
      log("warn", "failed to remove local config dir after out-of-band exit", {
        instanceId: updated.id,
        error: (e as Error).message,
      })
    );
  }
}

// Tracks gpu-xserver's own lifecycle (die/start) to correlate and auto-heal
// the instance crashes it causes -- see GPU_XSERVER_CONTAINER_NAME,
// GPU_XSERVER_DIE_CORRELATION_WINDOW_MS and the queuing logic at the end of
// handleContainerDieEvent above.
async function handleGpuXserverEvent(rawLine: string): Promise<void> {
  const event = JSON.parse(rawLine);

  const containerName: string = (event.Actor?.Attributes?.name ?? "").replace(/^\//, "");
  if (containerName !== GPU_XSERVER_CONTAINER_NAME) return;

  if (event.Action === "die") {
    gpuXserverDownSince = Date.now();
    log("warn", "gpu-xserver died, instance crashes over the next window will be attributed to it", {
      correlationWindowMs: GPU_XSERVER_DIE_CORRELATION_WINDOW_MS,
    });
    return;
  }

  if (event.Action !== "start") return;

  log("info", "gpu-xserver restarted, will attempt to resume affected instances after grace period", {
    graceMs: GPU_XSERVER_RECOVERY_GRACE_MS,
    pending: pendingGpuRecovery.size,
  });
  gpuXserverDownSince = null;

  setTimeout(() => {
    recoverInstancesAfterGpuXserverRestart().catch((e) =>
      log("error", "gpu-xserver recovery pass failed", { error: (e as Error).message })
    );
  }, GPU_XSERVER_RECOVERY_GRACE_MS);
}

async function recoverInstancesAfterGpuXserverRestart(): Promise<void> {
  if (pendingGpuRecovery.size === 0) return;
  if (!_restartInstance) {
    log("warn", "gpu-xserver recovery skipped, no restart handler registered", {
      pending: pendingGpuRecovery.size,
    });
    return;
  }

  const instanceIds = [...pendingGpuRecovery.keys()];
  pendingGpuRecovery.clear();

  for (const instanceId of instanceIds) {
    const instance = await getInstanceByIdAdmin(instanceId);
    // Already handled some other way (manually restarted, deleted, etc.)
    // since it was queued -- nothing to do.
    if (!instance || instance.status === "running") continue;

    try {
      await _restartInstance(instance);
      log("info", "instance auto-resumed after gpu-xserver recovery", { instanceId });
      trackInstanceEvent(instance.node_id, instanceId, instance.user_id, "auto_restarted", {
        reason: "gpu_xserver_recovery",
      });
    } catch (e) {
      log("error", "instance auto-resume after gpu-xserver recovery failed", {
        instanceId,
        error: (e as Error).message,
      });
      trackInstanceEvent(instance.node_id, instanceId, instance.user_id, "restart_failed", {
        reason: "gpu_xserver_recovery",
      });
    }
    await new Promise((resolve) => setTimeout(resolve, RESTART_STAGGER_MS));
  }
}
