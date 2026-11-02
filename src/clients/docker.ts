import Docker from "dockerode";
import { debug, log } from "@/utils/logger";
import { buildContainerSpec, runtimeFromEnv } from "./instance-spec";
import { parseCpuset, pickLeastUsedCores } from "@/utils/cpuset";
import { isInstanceContainer } from "@/utils/container-name";

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

// Image and GPU wiring for instance containers.
// All default to production; see instance-spec.ts for the dev-box values.
const instanceRuntime = runtimeFromEnv();

// Shared user-defined network joined by both the api container and every
// instance container, so the api can reach instances by container name over
// Docker's embedded DNS instead of publishing per-instance ports to the host.
const NETWORK_NAME = process.env.OBS_NETWORK || "obs-net";

export {
  VNC_PORT_INTERNAL,
  NOVNC_PORT_INTERNAL,
  OBS_WS_PORT_INTERNAL,
} from "./instance-spec";

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

    // Instances only: the name filter also matches this manager's container.
    const running = (
      await docker.listContainers({
        all: false,
        filters: { name: ["obs-instance-"] },
      })
    ).filter(isInstanceContainer);

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
  await ensureImagePulled(instanceRuntime.image);

  const cpusetCpus = await allocateCpuset(opts.cpu_quota);

  const container = await docker.createContainer(
    buildContainerSpec(
      {
        instanceId: opts.instanceId,
        containerName: opts.containerName,
        resolution: opts.resolution,
        obsWsPassword: opts.obsWsPassword,
        vncPassword: opts.vncPassword,
        memory_mb: opts.memory_mb,
        cpu_quota: opts.cpu_quota,
        shmBytes: parseShmSize(opts.shm_size),
        networkName: NETWORK_NAME,
        cpusetCpus,
      },
      instanceRuntime,
    ),
  );

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
