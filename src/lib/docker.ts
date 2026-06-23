import Docker from "dockerode";
import type { AllocatedPorts, Node } from "../types";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const IMAGE = "ghcr.io/streamwizard/obs-cloud-container:latest";

const VNC_PORT_INTERNAL = "5900";
const NOVNC_PORT_INTERNAL = "6080";
const OBS_WS_PORT_INTERNAL = "4455";

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
  ports: AllocatedPorts;
  resolution: string;
}

export async function createContainer(
  opts: CreateContainerOptions
): Promise<string> {
  const { instanceId, containerName, node, ports, resolution } = opts;

  await ensureImagePulled(IMAGE);

  const container = await docker.createContainer({
    name: containerName,
    Image: IMAGE,
    Env: [
      `RESOLUTION=${resolution}`,
      `GPU_BUSID=${node.gpu_bus_id}`,
      `VNC_PORT=5900`,
      `NOVNC_PORT=6080`,
      `OBS_WEBSOCKET_PORT=4455`,
      `DISPLAY_NUM=:0`,
    ],
    HostConfig: {
      Runtime: "nvidia",
      ShmSize: parseShmSize(node.shm_size),
      Memory: node.memory_mb * 1024 * 1024,
      NanoCpus: Math.round(node.cpu_quota * 1_000_000_000),
      PortBindings: {
        [`${VNC_PORT_INTERNAL}/tcp`]: [{ HostPort: String(ports.vnc_port) }],
        [`${NOVNC_PORT_INTERNAL}/tcp`]: [{ HostPort: String(ports.novnc_port) }],
        [`${OBS_WS_PORT_INTERNAL}/tcp`]: [{ HostPort: String(ports.obs_ws_port) }],
      },
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
  });

  return container.id;
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
