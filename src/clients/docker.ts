import Docker from "dockerode";
import { debug, log } from "../utils/logger";
import { listNodeInstances, updateInstance, updateInstanceByContainerId } from "./supabase";
import type { InstanceStatus, Node } from "../types";

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
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (followErr: Error | null) => {
        if (followErr) return reject(followErr);
        resolve();
      });
    });
  });
}

export interface CreateContainerOptions {
  instanceId: string;
  containerName: string;
  node: Node;
  resolution: string;
  obsWsPassword: string;
}

export async function createContainer(
  opts: CreateContainerOptions
): Promise<string> {
  const { instanceId, containerName, node, resolution, obsWsPassword } = opts;

  await ensureImagePulled(IMAGE);

  const memoryBytes = node.memory_mb * 1024 * 1024;

  const container = await docker.createContainer({
    name: containerName,
    Image: IMAGE,
    Env: [
      `RESOLUTION=${resolution}`,
      `GPU_BUSID=${node.gpu_bus_id}`,
      `VNC_PORT=${VNC_PORT_INTERNAL}`,
      `NOVNC_PORT=${NOVNC_PORT_INTERNAL}`,
      `OBS_WEBSOCKET_PORT=${OBS_WS_PORT_INTERNAL}`,
      `OBS_WEBSOCKET_PASSWORD=${obsWsPassword}`,
      `DISPLAY_NUM=:0`,
    ],
    HostConfig: {
      Runtime: "nvidia",
      ShmSize: parseShmSize(node.shm_size),
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
      NanoCpus: Math.round(node.cpu_quota * 1_000_000_000),
      Binds: [`/data/obs-configs/${instanceId}/obs-studio:/home/app/.config/obs-studio`],
      DeviceRequests: [
        {
          Driver: "nvidia",
          Count: -1,
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

// Boot-time reconciliation: cross-checks running OBS containers against
// the DB so a restarted API process doesn't operate on stale state (e.g.
// after a crash mid-create, or a container stopped/removed out-of-band).
export async function reconcileContainers(nodeId: string): Promise<void> {
  const nodeInstances = await listNodeInstances(nodeId);
  const knownContainerIds = new Set(
    nodeInstances.map((i) => i.container_id).filter((id): id is string => !!id)
  );

  const dockerContainers = await docker.listContainers({
    all: true,
    filters: { name: ["obs-instance-"] },
  });

  for (const container of dockerContainers) {
    if (!knownContainerIds.has(container.Id)) {
      log("warn", "orphaned container with no matching DB record", {
        containerId: container.Id,
        names: container.Names,
      });
    }
  }

  for (const instance of nodeInstances) {
    if (!instance.container_id) continue;

    const status = await getContainerStatus(instance.container_id);
    if (status === "unknown") continue;

    if (status === "not_found" && instance.status !== "error") {
      await updateInstance(instance.id, { status: "error" });
      log("warn", "instance container missing, marked error", { instanceId: instance.id });
    } else if (status === "running" && instance.status !== "running") {
      await updateInstance(instance.id, { status: "running" });
      log("info", "instance container running, resynced status", { instanceId: instance.id });
    } else if (status === "stopped" && instance.status === "running") {
      await updateInstance(instance.id, { status: "stopped" });
      log("info", "instance container stopped, resynced status", { instanceId: instance.id });
    }
  }
}

const EVENT_RECONNECT_DELAY_MS = 5000;

// Live counterpart to reconcileContainers: subscribes to Docker's event
// stream so a container that dies between reconciliation runs (crash, OOM
// kill, manual `docker stop` outside the API) updates the DB immediately
// instead of waiting for the next restart. Reconnects on stream errors/EOF
// since a dropped connection would otherwise silently stop all live updates.
export function startEventListener(): void {
  docker.getEvents(
    { filters: JSON.stringify({ type: ["container"], event: ["die"] }) },
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
