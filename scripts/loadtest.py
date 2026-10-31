#!/usr/bin/env python3
"""Spin up throwaway OBS instance containers on a node and stream them to a
MediaMTX server, to generate real NVENC/network load for testing.

Containers are named <prefix>N (default loadtest-obs-N) so the panel API never
tries to reconcile them, and they get no Supabase rows — pure throwaways.
Everything runs over plain `ssh <host> ...`, so the only local requirement is
key-based SSH access to the node; the node needs Docker, the running
gpu-xserver container, and the obs-net network (i.e. a normal provisioned node).

Run with no arguments for an interactive wizard (arrow-key menus + inputs);
subcommands remain available for scripting:
  scripts/loadtest.py
  scripts/loadtest.py start --host jochemwhite@10.10.10.185 --count 5
  scripts/loadtest.py start --count 8 --resolution 1280x720 --fps 60 --bitrate 4500
  scripts/loadtest.py status
  scripts/loadtest.py stop
"""

import argparse
import secrets
import shlex
import subprocess
import sys
import termios
import tty

DEFAULT_HOST = "jochemwhite@10.10.10.185"
DEFAULT_MTX = "rtmp://10.10.10.73:1935"
DEFAULT_PREFIX = "loadtest-obs-"
DEFAULT_KEY_PREFIX = "loadtest-"

IMAGE = "ghcr.io/streamwizard/obs-cloud-container:latest"
CONFIG_BASE = "/data/obs-configs"
PLUGINS_DIR = "/data/obs-plugins"
GPU_XSOCKET_VOLUME = "gpu-x11-socket"
NETWORK = "obs-net"
STATE_DIR = "~/.obs-loadtest"  # ctl.mjs + websocket password live here on the node

# Minimal obs-websocket v5 client, run on the node in a node:22-alpine
# container attached to obs-net (instance ports are never published to the
# host, so this is the only way in). Modes: "start" starts the stream and
# polls until bytes flow; "status" prints a one-shot GetStreamStatus.
CTL_MJS = r"""
import { createHash } from "node:crypto";

const [host, password, mode = "start"] = process.argv.slice(2);
const url = `ws://${host}:4455`;
const deadline = Date.now() + (mode === "start" ? 180_000 : 30_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64sha = (s) => createHash("sha256").update(s).digest("base64");

function attempt() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let reqId = 0;
    const pending = new Map();
    const send = (obj) => ws.send(JSON.stringify(obj));
    const request = (requestType, requestData = {}) =>
      new Promise((res, rej) => {
        const id = String(++reqId);
        pending.set(id, { res, rej });
        send({ op: 6, d: { requestType, requestId: id, requestData } });
      });
    const finish = (value) => {
      ws.onclose = null;
      ws.close();
      resolve(value);
    };

    ws.onerror = () => reject(new Error("connect failed"));
    ws.onclose = (ev) => reject(new Error(`closed (${ev.code})`));
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.op === 0) {
        const d = { rpcVersion: 1 };
        const a = msg.d.authentication;
        if (a) d.authentication = b64sha(b64sha(password + a.salt) + a.challenge);
        send({ op: 1, d });
      } else if (msg.op === 2) {
        try {
          if (mode === "status") {
            const st = await request("GetStreamStatus");
            const mbit = ((st.outputBytes * 8) / 1e6).toFixed(1);
            console.log(
              `${host}: active=${st.outputActive} sent=${mbit}Mbit ` +
                `frames=${st.outputTotalFrames} skipped=${st.outputSkippedFrames}`
            );
            return finish(true);
          }
          await request("StartStream").catch((e) => {
            console.log(`${host}: StartStream: ${e.message} (continuing, may already be live)`);
          });
          for (let i = 0; i < 15; i++) {
            await sleep(3000);
            const st = await request("GetStreamStatus");
            if (st.outputActive && st.outputBytes > 0) {
              console.log(`${host}: STREAMING (${st.outputBytes} bytes sent so far)`);
              return finish(true);
            }
          }
          console.log(`${host}: stream never became active`);
          finish(false);
        } catch (e) {
          reject(e);
        }
      } else if (msg.op === 7) {
        const p = pending.get(msg.d.requestId);
        if (!p) return;
        pending.delete(msg.d.requestId);
        if (msg.d.requestStatus.result) p.res(msg.d.responseData ?? {});
        else p.rej(new Error(`${msg.d.requestType} -> ${msg.d.requestStatus.code} ${msg.d.requestStatus.comment ?? ""}`));
      }
    };
  });
}

let ok = false;
let lastErr;
while (Date.now() < deadline) {
  try {
    ok = await attempt();
    break;
  } catch (e) {
    lastErr = e;
    await sleep(3000);
  }
}
if (!ok) {
  console.error(`${host}: FAILED (${lastErr?.message ?? "stream inactive"})`);
  process.exit(1);
}
"""


def ssh(host: str, command: str, *, input: str | None = None, capture: bool = False) -> subprocess.CompletedProcess:
    if not capture:
        # ssh writes straight to our stdout; flush our own buffered prints
        # first so progress lines don't land after the subprocess output.
        sys.stdout.flush()
    return subprocess.run(
        ["ssh", host, command],
        input=input.encode() if input is not None else None,
        capture_output=capture,
        text=False,
        check=False,
    )


def ssh_out(host: str, command: str) -> str:
    res = ssh(host, command, capture=True)
    return res.stdout.decode().strip()


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def container_names(prefix: str, count: int) -> list[str]:
    return [f"{prefix}{n}" for n in range(1, count + 1)]


def seed_script(args, names: list[str]) -> str:
    """Shell script run in an alpine container with CONFIG_BASE mounted at /cfg.

    Seeds a minimal OBS 31+ config per instance: first-run wizard suppressed,
    Simple output mode with the requested encoder/bitrate/fps, and the stream
    service pointed at the MediaMTX server. The entrypoint seeds the
    obs-websocket config itself from OBS_WEBSOCKET_PASSWORD.
    """
    width, height = args.resolution.split("x")
    parts = ["set -eu"]
    for name in names:
        key = f"{args.key_prefix}{name.removeprefix(args.prefix)}"
        parts.append(
            f"""
d="/cfg/{name}/obs-studio"
mkdir -p "$d/basic/profiles/StreamWizard" "/cfg/{name}/media"
cat > "$d/user.ini" <<'EOF'
[General]
FirstRun=true

[Basic]
Profile=StreamWizard
ProfileDir=StreamWizard
EOF
cp "$d/user.ini" "$d/global.ini"
cat > "$d/basic/profiles/StreamWizard/basic.ini" <<'EOF'
[General]
Name=StreamWizard

[Output]
Mode=Simple

[SimpleOutput]
VBitrate={args.bitrate}
StreamEncoder={args.encoder}

[Video]
BaseCX={width}
BaseCY={height}
OutputCX={width}
OutputCY={height}
FPSType=0
FPSCommon={args.fps}
EOF
cat > "$d/basic/profiles/StreamWizard/service.json" <<'EOF'
{{"type":"rtmp_custom","settings":{{"server":"{args.mtx}","key":"{key}","use_auth":false}}}}
EOF"""
        )
    parts.append(f'echo "seeded {len(names)} configs"')
    return "\n".join(parts)


def docker_run_command(args, name: str) -> str:
    # Mirrors obs-instance-manager's createContainer() (src/clients/docker.ts):
    # same caps, security opts, mounts, and memory/cpu shape.
    return " ".join(
        [
            f"docker run -d --name {name}",
            f"--runtime nvidia --network {NETWORK}",
            "--cap-add SYS_ADMIN --cap-add NET_ADMIN --cap-add SYS_PTRACE",
            "--security-opt apparmor=unconfined --security-opt seccomp=unconfined",
            f"--memory {args.memory_gb}g --memory-swap {args.memory_gb}g --shm-size 2g --cpus {args.cpus}",
            f"-v {CONFIG_BASE}/{name}/obs-studio:/home/app/.config/obs-studio",
            f"-v {PLUGINS_DIR}:/home/app/.config/obs-studio/plugins:ro",
            f"-v {GPU_XSOCKET_VOLUME}:/opt/gpu-xsocket:ro",
            f"-v {CONFIG_BASE}/{name}/media:/home/app/media",
            f"-e RESOLUTION={args.resolution} -e DISPLAY_NUM=:10",
            f'-e OBS_WEBSOCKET_PASSWORD="$(cat {STATE_DIR}/ws-password)"',
            IMAGE,
        ]
    )


def ctl_command(name: str, mode: str) -> str:
    return (
        f"docker run --rm --network {NETWORK} -v $HOME/.obs-loadtest:/s:ro "
        f'node:22-alpine node /s/ctl.mjs {name} "$(cat {STATE_DIR}/ws-password)" {mode}'
    )


def cmd_start(args) -> None:
    names = container_names(args.prefix, args.count)

    if ssh_out(args.host, "docker inspect -f '{{.State.Running}}' gpu-xserver 2>/dev/null") != "true":
        die("gpu-xserver container is not running on the node — instances can't render without it")

    existing = ssh_out(args.host, f"docker ps -aq --filter name={args.prefix}")
    if existing:
        die(f"containers matching '{args.prefix}*' already exist on the node — run `{sys.argv[0]} stop` first")

    mtx_hostport = args.mtx.split("://", 1)[-1].split("/", 1)[0]
    mtx_host, _, mtx_port = mtx_hostport.partition(":")
    mtx_port = mtx_port or "1935"
    reachable = ssh_out(args.host, f"timeout 3 bash -c '</dev/tcp/{mtx_host}/{mtx_port}' && echo ok || echo no")
    if reachable != "ok":
        die(f"MediaMTX at {mtx_host}:{mtx_port} is not reachable from the node")

    if args.count > 8 and args.encoder.startswith("nvenc"):
        print(f"warning: {args.count} NVENC sessions — consumer GPUs cap concurrent NVENC sessions (typically 8)")

    print(f"==> writing control script + websocket password to {STATE_DIR} on the node")
    password = secrets.token_urlsafe(18)
    res = ssh(
        args.host,
        f"mkdir -p {STATE_DIR} && cat > {STATE_DIR}/ctl.mjs && "
        f"printf '%s' {shlex.quote(password)} > {STATE_DIR}/ws-password && chmod 600 {STATE_DIR}/ws-password",
        input=CTL_MJS,
    )
    if res.returncode != 0:
        die("failed to write state files on the node")

    print(f"==> seeding {args.count} OBS configs ({args.resolution}@{args.fps}, {args.encoder} {args.bitrate}kbps -> {args.mtx})")
    res = ssh(args.host, f"docker run --rm -i -v {CONFIG_BASE}:/cfg alpine sh -s", input=seed_script(args, names))
    if res.returncode != 0:
        die("config seeding failed")

    print(f"==> launching {args.count} containers")
    launch = "set -e\n" + "\n".join(docker_run_command(args, name) for name in names)
    res = ssh(args.host, launch)
    if res.returncode != 0:
        die("container launch failed (already-created containers are left in place; run stop to clean up)")

    print("==> starting streams (waits for OBS to boot; this can take a minute)")
    start_all = "\n".join(f"{ctl_command(name, 'start')} &" for name in names) + "\nwait"
    res = ssh(args.host, start_all)

    keys = ", ".join(f"{args.key_prefix}{n}" for n in range(1, args.count + 1))
    print(f"\ndone — MediaMTX paths: {keys}")
    if res.returncode != 0:
        print("note: at least one stream reported a problem above", file=sys.stderr)


def cmd_status(args) -> None:
    ps = ssh_out(args.host, f"docker ps -a --filter name={args.prefix} --format '{{{{.Names}}}}\\t{{{{.Status}}}}'")
    if not ps:
        print("no loadtest containers on the node")
        return
    print(ps)

    gpu = ssh_out(
        args.host,
        "nvidia-smi --query-gpu=encoder.stats.sessionCount,encoder.stats.averageFps,utilization.gpu,memory.used "
        "--format=csv,noheader 2>/dev/null",
    )
    if gpu:
        sessions, avg_fps, util, mem = [f.strip() for f in gpu.split(",")]
        print(f"\nGPU: {sessions} NVENC sessions @ {avg_fps} avg fps, {util} util, {mem} VRAM used")

    names = [line.split("\t")[0] for line in ps.splitlines() if "\tUp" in line]
    if names:
        print("\nstream status:")
        status_all = "\n".join(f"{ctl_command(name, 'status')} &" for name in names) + "\nwait"
        ssh(args.host, status_all)


def cmd_stop(args) -> None:
    print("==> removing containers")
    ssh(args.host, f"docker ps -aq --filter name={args.prefix} | xargs -r docker rm -f")
    print("==> removing seeded configs and state")
    ssh(args.host, f"docker run --rm -v {CONFIG_BASE}:/cfg alpine sh -c 'rm -rf /cfg/{args.prefix}*'")
    ssh(args.host, f"rm -rf {STATE_DIR}")
    print("done")


# --- interactive wizard (stdlib-only: termios raw mode + ANSI redraws) ---


def read_key() -> str:
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        # TCSANOW: the default TCSAFLUSH discards typed-ahead input on every
        # keypress, eating keys from fast typists (and scripted tests).
        tty.setraw(fd, termios.TCSANOW)
        ch = sys.stdin.read(1)
        if ch == "\x1b":  # arrow keys arrive as ESC [ A/B
            ch += sys.stdin.read(2)
        return ch
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


def select(title: str, options: list[str], default: int = 0) -> int:
    """Arrow-key dropdown; returns the chosen index. Collapses to one line."""
    idx = default
    print(title)
    while True:
        for i, opt in enumerate(options):
            marker, color = ("❯", "\x1b[36m") if i == idx else (" ", "")
            print(f"\x1b[2K  {color}{marker} {opt}\x1b[0m")
        key = read_key()
        if key in ("\x1b[A", "k"):
            idx = (idx - 1) % len(options)
        elif key in ("\x1b[B", "j"):
            idx = (idx + 1) % len(options)
        elif key in ("\r", "\n"):
            print(f"\x1b[{len(options) + 1}A\x1b[J", end="")
            print(f"{title} \x1b[36m{options[idx]}\x1b[0m")
            return idx
        elif key == "\x03":
            raise KeyboardInterrupt
        print(f"\x1b[{len(options)}A", end="")


def ask(prompt: str, default, cast=str, validate=None):
    while True:
        raw = input(f"{prompt} \x1b[90m[{default}]\x1b[0m: ").strip()
        try:
            value = cast(raw or str(default))
        except ValueError:
            print("  not a valid value, try again")
            continue
        if validate and not validate(value):
            print("  not a valid value, try again")
            continue
        return value


ENCODERS = [
    ("nvenc", "nvenc — H.264 on the GPU (default)"),
    ("nvenc_hevc", "nvenc_hevc — HEVC on the GPU"),
    ("nvenc_av1", "nvenc_av1 — AV1 on the GPU (Ada or newer)"),
    ("x264", "x264 — H.264 on the CPU (tests CPU load instead)"),
]

RESOLUTIONS = ["1920x1080", "1280x720", "2560x1440", "3840x2160", "custom..."]
FPS_CHOICES = ["30", "60", "custom..."]


def wizard_start(host: str) -> None:
    count = ask("Instances", 5, int, lambda n: n > 0)
    res_idx = select("Resolution", RESOLUTIONS)
    resolution = (
        ask("Custom resolution (WxH)", "1920x1080", validate=lambda v: "x" in v)
        if RESOLUTIONS[res_idx] == "custom..."
        else RESOLUTIONS[res_idx]
    )
    fps_idx = select("FPS", FPS_CHOICES)
    fps = ask("Custom FPS", 30, int, lambda n: n > 0) if FPS_CHOICES[fps_idx] == "custom..." else int(FPS_CHOICES[fps_idx])
    encoder = ENCODERS[select("Encoder", [label for _, label in ENCODERS])][0]
    bitrate = ask("Bitrate (kbps)", 6000, int, lambda n: n > 0)
    mtx = ask("MediaMTX RTMP URL", DEFAULT_MTX)

    memory_gb, cpus, prefix, key_prefix = 4, 2, DEFAULT_PREFIX, DEFAULT_KEY_PREFIX
    if select("Advanced settings (memory/CPU limits, name prefixes)?", ["No", "Yes"]) == 1:
        memory_gb = ask("Memory limit per container (GB)", memory_gb, int, lambda n: n > 0)
        cpus = ask("CPU limit per container", cpus, int, lambda n: n > 0)
        prefix = ask("Container name prefix", prefix)
        key_prefix = ask("Stream key prefix", key_prefix)

    print(f"\n  {count}x OBS @ {resolution}@{fps}, {encoder} {bitrate}kbps -> {mtx} on {host}\n")
    if select("Launch?", ["Yes", "No"]) != 0:
        print("aborted")
        return
    cmd_start(
        argparse.Namespace(
            host=host, prefix=prefix, count=count, resolution=resolution, fps=fps,
            bitrate=bitrate, encoder=encoder, mtx=mtx, key_prefix=key_prefix,
            memory_gb=memory_gb, cpus=cpus,
        )
    )


def wizard() -> None:
    print("OBS node load tester\n")
    try:
        while True:
            action = select(
                "What do you want to do?",
                ["Start a load test", "Show status", "Stop / clean up", "Quit"],
            )
            if action == 3:
                return
            host = ask("SSH host", DEFAULT_HOST)
            ns = argparse.Namespace(host=host, prefix=DEFAULT_PREFIX)
            if action == 0:
                wizard_start(host)
            elif action == 1:
                cmd_status(ns)
            elif action == 2 and select(f"Remove all {DEFAULT_PREFIX}* containers and configs?", ["Yes", "No"]) == 0:
                cmd_stop(ns)
            print()
    except (KeyboardInterrupt, EOFError):
        print("\nbye")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default=DEFAULT_HOST, help="SSH target for the OBS node (user@host or ssh alias)")
    parser.add_argument("--prefix", default=DEFAULT_PREFIX, help="container name prefix (default: %(default)s)")
    sub = parser.add_subparsers(dest="command", required=True)

    p_start = sub.add_parser("start", help="seed configs, launch containers, start streaming")
    p_start.add_argument("--count", type=int, default=5, help="number of OBS instances (default: %(default)s)")
    p_start.add_argument("--resolution", default="1920x1080", help="canvas+output resolution WxH (default: %(default)s)")
    p_start.add_argument("--fps", type=int, default=30, help="output fps (default: %(default)s)")
    p_start.add_argument("--bitrate", type=int, default=6000, help="video bitrate in kbps (default: %(default)s)")
    p_start.add_argument(
        "--encoder",
        default="nvenc",
        choices=["nvenc", "nvenc_hevc", "nvenc_av1", "x264"],
        help="OBS simple-mode stream encoder (default: %(default)s)",
    )
    p_start.add_argument("--mtx", default=DEFAULT_MTX, help="MediaMTX RTMP base URL (default: %(default)s)")
    p_start.add_argument("--key-prefix", default=DEFAULT_KEY_PREFIX, help="stream key prefix; keys are <prefix>1..N (default: %(default)s)")
    p_start.add_argument("--memory-gb", type=int, default=4, help="memory limit per container in GB (default: %(default)s)")
    p_start.add_argument("--cpus", type=int, default=2, help="CPU limit per container (default: %(default)s)")
    p_start.set_defaults(func=cmd_start)

    p_status = sub.add_parser("status", help="show container, GPU encoder, and stream status")
    p_status.set_defaults(func=cmd_status)

    p_stop = sub.add_parser("stop", help="remove all loadtest containers and their seeded configs")
    p_stop.set_defaults(func=cmd_stop)

    if len(sys.argv) == 1:
        if sys.stdin.isatty():
            wizard()
        else:
            parser.print_help()
        return

    args = parser.parse_args()
    if args.command == "start" and "x" not in args.resolution:
        parser.error("--resolution must look like 1920x1080")
    args.func(args)


if __name__ == "__main__":
    main()
