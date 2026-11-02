import type { ContainerCreateOptions } from "dockerode";

// What an instance container looks like on this node. Production is noVNC +
// the shared gpu-xserver (VirtualGL); the other values exist for running the
// whole stack on a dev box, e.g. WSL2 + Docker Desktop, where there is no
// NVIDIA DRM driver for a real Xorg. The viewer is always noVNC. Everything
// defaults to production, so a node with none of these env vars set creates
// exactly the containers it always has.

// xserver: render through VirtualGL on the node's shared gpu-xserver
//   (docker-compose.yml), OBS jailed in bwrap. Production.
// direct: hand the GPU straight to the container and let the image pick its
//   GL path (OBS_GL_MODE=d3d12 on WSL2). No gpu-xserver, no bwrap.
export type GpuMode = "xserver" | "direct";

export interface InstanceRuntime {
  image: string;
  gpuMode: GpuMode;
  // Passed to the container as OBS_GL_MODE in direct mode (software|d3d12).
  glMode: string;
  // Host dir bind-mounted read-only at /usr/lib/wsl for d3d12 (libd3d12.so);
  // Docker Desktop's GPU support brings CUDA/NVENC libs but not these.
  wslLibDir: string;
  configBase: string;
  pluginsDir: string;
}

export const DEFAULT_IMAGE = "ghcr.io/streamwizard/obs-cloud-container:latest";

export const VNC_PORT_INTERNAL = 5900;
export const NOVNC_PORT_INTERNAL = 6080;
export const OBS_WS_PORT_INTERNAL = 4455;

// Named volume backing the shared gpu-xserver's X11 socket directory --
// gpu-xserver itself is a plain static service in this repo's own
// docker-compose.yml (one per machine/GPU, alongside `api`/`cadvisor`), not
// something this API provisions at runtime. Read-only here since every
// instance container only ever consumes that socket via VirtualGL, never
// creates it.
const GPU_XSOCKET_VOLUME = "gpu-x11-socket";

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === "") return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${name} must be one of ${allowed.join("|")}, got "${value}"`);
}

export function runtimeFromEnv(env: Record<string, string | undefined> = process.env): InstanceRuntime {
  return {
    image: env.OBS_INSTANCE_IMAGE || DEFAULT_IMAGE,
    gpuMode: oneOf("OBS_GPU_MODE", env.OBS_GPU_MODE, ["xserver", "direct"], "xserver"),
    glMode: env.OBS_GL_MODE || "d3d12",
    wslLibDir: env.OBS_WSL_LIB_DIR || "/usr/lib/wsl",
    configBase: env.OBS_CONFIG_BASE || "/data/obs-configs",
    pluginsDir: env.PLUGINS_PATH || "/data/obs-plugins",
  };
}

export interface ContainerSpecInput {
  instanceId: string;
  containerName: string;
  resolution: string;
  obsWsPassword: string;
  vncPassword: string;
  memory_mb: number;
  cpu_quota: number;
  shmBytes: number;
  networkName: string;
  cpusetCpus?: string;
}

export function buildContainerSpec(input: ContainerSpecInput, rt: InstanceRuntime): ContainerCreateOptions {
  const { instanceId, containerName, resolution, obsWsPassword, vncPassword, memory_mb, cpu_quota } = input;
  const memoryBytes = memory_mb * 1024 * 1024;
  const xserver = rt.gpuMode === "xserver";
  const d3d12 = !xserver && rt.glMode === "d3d12";

  const env = [
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
    ...(xserver ? [] : [`OBS_GL_MODE=${rt.glMode}`, `NVIDIA_DRIVER_CAPABILITIES=all`]),
  ];

  const exposedPorts = [VNC_PORT_INTERNAL, NOVNC_PORT_INTERNAL, OBS_WS_PORT_INTERNAL];

  return {
    name: containerName,
    Image: rt.image,
    Env: env,
    HostConfig: {
      // Direct mode gets the GPU from DeviceRequests alone (`--gpus all`),
      // which is also all Docker Desktop needs.
      ...(xserver ? { Runtime: "nvidia" } : {}),
      ShmSize: input.shmBytes,
      ...(xserver
        ? {
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
          }
        : {}),
      // Pin swap to the memory limit so a container can't exceed it by swapping.
      Memory: memoryBytes,
      MemoryReservation: memoryBytes,
      MemorySwap: memoryBytes,

      NanoCpus: Math.round(cpu_quota * 1000000000),
      // NanoCpus alone caps CPU *time* but leaves affinity at every host core,
      // so OBS/Chromium/Qt size their thread pools for the whole node. Pinning
      // the same core count the quota buys keeps nproc honest -- see
      // allocateCpuset in docker.ts.
      ...(input.cpusetCpus ? { CpusetCpus: input.cpusetCpus } : {}),

      Binds: [
        `${rt.configBase}/${instanceId}/obs-studio:/home/app/.config/obs-studio`,
        // Shared, read-only across all instances on this node — synced once via
        // syncPlugins() instead of duplicating plugin binaries per instance.
        `${rt.pluginsDir}:/home/app/.config/obs-studio/plugins:ro`,
        // Read-only: this instance only ever consumes the shared gpu-xserver's
        // X11 socket (a static service in docker-compose.yml), never creates it.
        ...(xserver ? [`${GPU_XSOCKET_VOLUME}:/opt/gpu-xsocket:ro`] : []),
        ...(d3d12 ? [`${rt.wslLibDir}:/usr/lib/wsl:ro`] : []),
        // Persists whatever the user drops into OBS's media folder (Add
        // Source > local files, etc.) across stop/start -- synced to S3
        // alongside the obs-studio config, see obs-config.ts.
        `${rt.configBase}/${instanceId}/media:/home/app/media`,
      ],

      DeviceRequests: [
        {
          Driver: "nvidia",
          Count: -1,
          // FIX: Wrap the strings in a nested array to satisfy the string[][] type definition
          Capabilities: [xserver ? ["gpu", "utility", "video", "display"] : ["gpu"]],
        },
      ],
    },
    ExposedPorts: Object.fromEntries(exposedPorts.map((p) => [`${p}/tcp`, {}])),
    NetworkingConfig: {
      EndpointsConfig: {
        [input.networkName]: {},
      },
    },
  };
}
