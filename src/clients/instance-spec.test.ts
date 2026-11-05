import { test, expect } from "bun:test";
import { buildContainerSpec, runtimeFromEnv, type ContainerSpecInput } from "./instance-spec";

const input: ContainerSpecInput = {
  instanceId: "inst-1",
  containerName: "obs-instance-inst-1",
  resolution: "1920x1080",
  obsWsPassword: "ws-pw",
  viewerPassword: "viewer-pw",
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
      "OBS_WEBSOCKET_PORT=4455",
      "OBS_WEBSOCKET_PASSWORD=ws-pw",
      "DISPLAY_NUM=:10",
      "SELKIES_ENCODER=h264enc-striped",
      "SELKIES_FRAMERATE=60-60",
      "SELKIES_VIDEO_STREAMING_MODE=false|locked",
      "SELKIES_UI_SHOW_SIDEBAR=false",
      "SELKIES_UI_SHOW_CORE_BUTTONS=false",
      "SELKIES_ENABLE_SHARING=false",
      "SELKIES_GAMEPAD_ENABLED=false",
      "SELKIES_MICROPHONE_ENABLED=false",
      "SELKIES_WEBCAM_ENABLED=false",
      "SELKIES_FILE_TRANSFERS=",
      "SELKIES_AUDIO_DEVICE_NAME=obs_sink.monitor",
      "SELKIES_AUDIO_REDUNDANCY=true",
      "SELKIES_MANUAL_RESOLUTION=true|locked",
      "SELKIES_MANUAL_WIDTH=1920",
      "SELKIES_MANUAL_HEIGHT=1080",
      "SELKIES_PORT=8080",
      "SELKIES_BASIC_AUTH_PASSWORD=viewer-pw",
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
    ExposedPorts: { "8080/tcp": {}, "4455/tcp": {} },
    NetworkingConfig: { EndpointsConfig: { "obs-net": {} } },
  });
});

test("direct GPU: no gpu-xserver, no bwrap privileges, WSL libs mounted, node overrides", () => {
  const rt = runtimeFromEnv({
    OBS_INSTANCE_IMAGE: "obs-cloud-container-local:selkies",
    OBS_GPU_MODE: "direct",
    OBS_CONFIG_BASE: "/work/.local-data/obs-configs",
    PLUGINS_PATH: "/work/.local-data/obs-plugins",
    SELKIES_VIDEO_BITRATE: "4000",
    SELKIES_BASIC_AUTH_PASSWORD: "node-wide",
  });
  const spec = buildContainerSpec({ ...input, resolution: "1280x720" }, rt);
  const env = spec.Env ?? [];
  const host = spec.HostConfig ?? {};

  expect(spec.Image).toBe("obs-cloud-container-local:selkies");
  expect(env).toContain("OBS_GL_MODE=d3d12");
  expect(env).toContain("SELKIES_MANUAL_WIDTH=1280");
  expect(env).toContain("SELKIES_MANUAL_HEIGHT=720");
  // Fixed viewer: no sidebar, no sharing links, no file transfer.
  expect(env).toContain("SELKIES_UI_SHOW_SIDEBAR=false");
  expect(env).toContain("SELKIES_ENABLE_SHARING=false");
  expect(env).toContain("SELKIES_FILE_TRANSFERS=");
  // Locks in the syntax Selkies parses; "|locked" on a range or list is
  // rejected and replaced by the default.
  expect(env).toContain("SELKIES_ENCODER=h264enc-striped");
  expect(env).toContain("SELKIES_FRAMERATE=60-60");
  expect(env).toContain("SELKIES_VIDEO_STREAMING_MODE=false|locked");
  expect(env.filter((e) => /^SELKIES_(ENCODER|FRAMERATE)=.*\|locked/.test(e))).toEqual([]);
  // Overrides win over the defaults...
  expect(env).toContain("SELKIES_VIDEO_BITRATE=4000");
  // ...except the password, which is always the instance's own.
  expect(env.filter((e) => e.startsWith("SELKIES_BASIC_AUTH_PASSWORD="))).toEqual([
    "SELKIES_BASIC_AUTH_PASSWORD=viewer-pw",
  ]);

  expect(host.Runtime).toBeUndefined();
  expect(host.CapAdd).toBeUndefined();
  expect(host.SecurityOpt).toBeUndefined();
  expect(host.Binds).toEqual([
    "/work/.local-data/obs-configs/inst-1/obs-studio:/home/app/.config/obs-studio",
    "/work/.local-data/obs-plugins:/home/app/.config/obs-studio/plugins:ro",
    "/usr/lib/wsl:/usr/lib/wsl:ro",
    "/work/.local-data/obs-configs/inst-1/media:/home/app/media",
  ]);
  expect(spec.ExposedPorts).toEqual({ "8080/tcp": {}, "4455/tcp": {} });
});

test("software GL in direct mode skips the WSL mount", () => {
  const rt = runtimeFromEnv({ OBS_GPU_MODE: "direct", OBS_GL_MODE: "software" });
  const binds = buildContainerSpec(input, rt).HostConfig?.Binds ?? [];
  expect(binds.some((b) => b.includes("/usr/lib/wsl"))).toBe(false);
});

test("a typo in a mode fails loudly instead of silently falling back", () => {
  expect(() => runtimeFromEnv({ OBS_GPU_MODE: "wsl" })).toThrow(/OBS_GPU_MODE/);
});
