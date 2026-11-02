import { test, expect } from "bun:test";
import { buildContainerSpec, runtimeFromEnv, type ContainerSpecInput } from "./instance-spec";

const input: ContainerSpecInput = {
  instanceId: "inst-1",
  containerName: "obs-instance-inst-1",
  resolution: "1920x1080",
  obsWsPassword: "ws-pw",
  vncPassword: "vnc-pw",
  memory_mb: 4096,
  cpu_quota: 2,
  shmBytes: 2 * 1024 ** 3,
  networkName: "obs-net",
  cpusetCpus: "0,1",
};

test("no env set: exactly the production container createContainer always built", () => {
  const spec = buildContainerSpec(input, runtimeFromEnv({}));
  const memory = 4096 * 1024 * 1024;
  expect(spec).toEqual({
    name: "obs-instance-inst-1",
    Image: "ghcr.io/streamwizard/obs-cloud-container:latest",
    Env: [
      "RESOLUTION=1920x1080",
      "VNC_PORT=5900",
      "NOVNC_PORT=6080",
      "OBS_WEBSOCKET_PORT=4455",
      "OBS_WEBSOCKET_PASSWORD=ws-pw",
      "VNC_PASSWORD=vnc-pw",
      "DISPLAY_NUM=:10",
      "OBS_BROWSER_EXTRA_FLAGS=--no-sandbox --disable-dev-shm-usage --disable-gpu",
    ],
    HostConfig: {
      Runtime: "nvidia",
      ShmSize: 2 * 1024 ** 3,
      CapAdd: ["SYS_ADMIN", "NET_ADMIN", "SYS_PTRACE"],
      SecurityOpt: ["apparmor=unconfined", "seccomp=unconfined"],
      Memory: memory,
      MemoryReservation: memory,
      MemorySwap: memory,
      NanoCpus: 2_000_000_000,
      CpusetCpus: "0,1",
      Binds: [
        "/data/obs-configs/inst-1/obs-studio:/home/app/.config/obs-studio",
        "/data/obs-plugins:/home/app/.config/obs-studio/plugins:ro",
        "gpu-x11-socket:/opt/gpu-xsocket:ro",
        "/data/obs-configs/inst-1/media:/home/app/media",
      ],
      DeviceRequests: [{ Driver: "nvidia", Count: -1, Capabilities: [["gpu", "utility", "video", "display"]] }],
    },
    ExposedPorts: { "5900/tcp": {}, "6080/tcp": {}, "4455/tcp": {} },
    NetworkingConfig: { EndpointsConfig: { "obs-net": {} } },
  });
});

test("direct GPU: noVNC, no gpu-xserver, no bwrap privileges, WSL libs mounted", () => {
  const rt = runtimeFromEnv({
    OBS_INSTANCE_IMAGE: "obs-cloud-container-local:dev",
    OBS_GPU_MODE: "direct",
    OBS_GL_MODE: "d3d12",
    OBS_CONFIG_BASE: "/work/.local-data/obs-configs",
    PLUGINS_PATH: "/work/.local-data/obs-plugins",
  });
  const spec = buildContainerSpec({ ...input, resolution: "1280x720" }, rt);
  const env = spec.Env ?? [];
  const host = spec.HostConfig ?? {};

  expect(spec.Image).toBe("obs-cloud-container-local:dev");
  expect(env).toContain("VNC_PASSWORD=vnc-pw");
  expect(env).toContain("NOVNC_PORT=6080");
  expect(env).toContain("OBS_GL_MODE=d3d12");

  expect(host.Runtime).toBeUndefined();
  expect(host.CapAdd).toBeUndefined();
  expect(host.SecurityOpt).toBeUndefined();
  expect(host.Binds).toEqual([
    "/work/.local-data/obs-configs/inst-1/obs-studio:/home/app/.config/obs-studio",
    "/work/.local-data/obs-plugins:/home/app/.config/obs-studio/plugins:ro",
    "/usr/lib/wsl:/usr/lib/wsl:ro",
    "/work/.local-data/obs-configs/inst-1/media:/home/app/media",
  ]);
  expect(spec.ExposedPorts).toEqual({ "5900/tcp": {}, "6080/tcp": {}, "4455/tcp": {} });
});

test("software GL in direct mode skips the WSL mount", () => {
  const rt = runtimeFromEnv({ OBS_GPU_MODE: "direct", OBS_GL_MODE: "software" });
  const binds = buildContainerSpec(input, rt).HostConfig?.Binds ?? [];
  expect(binds.some((b) => b.includes("/usr/lib/wsl"))).toBe(false);
});

test("a typo in a mode fails loudly instead of silently falling back", () => {
  expect(() => runtimeFromEnv({ OBS_GPU_MODE: "wsl" })).toThrow(/OBS_GPU_MODE/);
});
