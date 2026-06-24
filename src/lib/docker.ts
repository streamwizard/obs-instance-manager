import Docker from "dockerode";
import type { Node } from "../types";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

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
}

export async function createContainer(
  opts: CreateContainerOptions
): Promise<string> {
  const { instanceId, containerName, node, resolution } = opts;

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
      `DISPLAY_NUM=:0`,
    ],
    HostConfig: {
      Runtime: "nvidia",
      ShmSize: parseShmSize(node.shm_size),
      // SYS_ADMIN is required by OBS's browser-source plugin, which ships a
      // setuid-root chrome-sandbox binary (standard Chromium sandboxing).
      CapAdd: ["SYS_ADMIN"],
      // Docker's default AppArmor profile blocks the mount/userns syscalls
      // bwrap needs to jail OBS (entrypoint.sh), independent of CapAdd above.
      // Unconfined here only relaxes MAC inside this already-isolated container.
      SecurityOpt: ["apparmor=unconfined"],
      // Pin swap to the memory limit so a container can't exceed it by swapping.
      Memory: memoryBytes,
      MemoryReservation: memoryBytes,
      MemorySwap: memoryBytes,
      NanoCpus: Math.round(node.cpu_quota * 1_000_000_000),
      Binds: [
        `/data/obs-configs/${instanceId}/obs-studio:/data/obs-configs/${instanceId}/obs-studio`,
      ],
      DeviceRequests: [
        {
          Driver: "nvidia",
          Count: -1,
          Capabilities: [["gpu"]],
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

function parseShmSize(shmSize: string): number {
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

export type DockerStatus = "running" | "stopped" | "not_found";

export async function getContainerStatus(containerId: string): Promise<DockerStatus> {
  try {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    return info.State.Running ? "running" : "stopped";
  } catch (err: any) {
    if (err?.statusCode === 404) return "not_found";
    throw err;
  }
}
