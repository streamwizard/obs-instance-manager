import Docker from "dockerode";
import { debug, log } from "@/utils/logger";
import { PLUGINS_LOCAL_DIR } from "@/services/storage/plugins";
import { parseCpuset, pickLeastUsedCores } from "@/utils/cpuset";

// Thin Docker API layer: container create/start/stop/remove/inspect and the
// obs-net addressing helpers. Orchestration on top of it (boot reconcile, the
// live event stream, gpu-xserver recovery) lives in services/docker/.
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

// Container IDs currently being stopped via the API routes. The die event
// handler (services/docker/event-listener.ts) skips its own push+cleanup for
// these since the API route handles it.
const apiStoppingContainers = new Set<string>();

// Callers wrap their own stopContainer()+push+cleanup sequence in these
// (services/instances/stop-instance.ts, destroy-instance.ts, admin routes) so
// the live "die" event handler knows to stay out of the way instead of racing
// the same config push / local-dir removal / DB write for the same container.
export function markApiStopping(containerId: string): void {
  apiStoppingContainers.add(containerId);
}

export function clearApiStopping(containerId: string): void {
  apiStoppingContainers.delete(containerId);
}

export function isApiStopping(containerId: string): boolean {
  return apiStoppingContainers.has(containerId);
}

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

// Picks the CpusetCpus value for a new instance: the ceil(cpu_quota) cores that
// the fewest live instance containers are already pinned to. See utils/cpuset.ts
// for why pinning is needed at all on top of NanoCpus, and why the windows are
// allowed to overlap. Returns undefined (no pinning, the previous behaviour)
// whenever pinning can't help or the node's state can't be read -- a failure to
// balance cores must never block a start.
async function allocateCpuset(cpuQuota: number): Promise<string | undefined> {
  const want = Math.ceil(cpuQuota);
  if (!Number.isFinite(want) || want < 1) return undefined;

  try {
    const info = await docker.info();
    const total: number = info?.NCPU ?? 0;
    // Nothing to constrain: the instance may already use every core.
    if (!Number.isInteger(total) || total < 1 || want >= total) return undefined;

    const running = await docker.listContainers({
      all: false,
      filters: { name: ["obs-instance-"] },
    });

    const usage = new Array<number>(total).fill(0);
    for (const summary of running) {
      const details = await docker.getContainer(summary.Id).inspect();
      for (const core of parseCpuset(details.HostConfig?.CpusetCpus, total)) {
        usage[core] = (usage[core] ?? 0) + 1;
      }
    }

    const cpuset = pickLeastUsedCores(usage, want).join(",");
    debug("docker", `pinning new instance to cores ${cpuset} of ${total}`);
    return cpuset;
  } catch (err) {
    log("warn", "cpuset allocation failed, creating container unpinned", {
      error: (err as Error).message,
    });
    return undefined;
  }
}

export async function createContainer(
  opts: CreateContainerOptions
): Promise<string> {
  const { instanceId, containerName, resolution, obsWsPassword, vncPassword, memory_mb, cpu_quota, shm_size } = opts;

  await ensureImagePulled(IMAGE);

  const memoryBytes = memory_mb * 1024 * 1024;
  const cpusetCpus = await allocateCpuset(cpu_quota);

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
      // NanoCpus alone caps CPU *time* but leaves affinity at every host core,
      // so OBS/Chromium/Qt size their thread pools for the whole node. Pinning
      // the same core count the quota buys keeps nproc honest -- see
      // allocateCpuset above.
      ...(cpusetCpus ? { CpusetCpus: cpusetCpus } : {}),

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
        // alongside the obs-studio config, see services/storage/obs-config/.
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

// Exact-name lookup. Docker's `name` filter is a substring match and
// container names come back with a leading "/", so both are normalised here.
// Used by the start flow to adopt a container that already exists for this
// instance (a previous start that finished after the caller gave up, or a
// stale exited one) instead of racing Docker for the name and losing.
export async function findContainerByName(
  name: string
): Promise<{ id: string; running: boolean } | null> {
  const matches = await docker.listContainers({ all: true, filters: { name: [name] } });
  const exact = matches.find((c) => (c.Names ?? []).some((n) => n.replace(/^\//, "") === name));
  if (!exact) return null;
  return { id: exact.Id, running: exact.State === "running" };
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
