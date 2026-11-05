# OBS Cloud Panel API

REST API backend that manages OBS cloud containers on demand. Each container runs a headless OBS Studio instance (Xvfb, NVIDIA GPU, Selkies viewer) and is owned by a single StreamWizard user. The backend also streams per-container and host resource metrics in real time over SSE.

Instance containers publish no ports to the host at all — the Selkies viewer
and the OBS websocket are reached by proxying through this API itself
(`/instances/:id/selkies/`, `/instances/:id/obsws`) over a Docker-internal
network. The only port a node exposes is the API's own (`3000`), bound to
loopback and to the node's Tailscale address — never the LAN or a public
interface. Browsers and the panel apps reach it through a Cloudflare Tunnel
running on the node (`cloudflared` origin `http://localhost:3000`, hostname
set as the node's `api_url` in web-admin); tailnet hosts such as the alert
worker reach it over Tailscale. Tailscale is also what lets the OBS
containers pull SRT from an ingest node.

## Setting up a new node

`scripts/install.sh` provisions a fresh Ubuntu host end to end (Docker, the
NVIDIA Container Toolkit, Tailscale, the `obs-net` Docker network, ufw rules,
and a dedicated `obs` service account):

```bash
sudo bash scripts/install.sh --start
```

A node never gets a copy of this source. The installer fetches just
`docker-compose.yml` and `.env.example` from GitHub into
`/opt/obs-instance-manager` and pulls the prebuilt API image from GHCR
(`ghcr.io/streamwizard/obs-instance-manager`), which CI builds on every merge
to `main` (see `.github/workflows/build-images.yml`). Pass `--ref` to install
from a branch or tag other than `main`.

By default it only opens SSH to your auto-detected LAN network (override with
`--ssh-cidr`), allows the API port in on `tailscale0` only, and expects you
to fill in `.env` by hand afterward (`NODE_ID`, `NODE_API_KEY`,
`REST_API_URL`, `TAILSCALE_IP`). Pass `--tailscale-authkey`
to have it join the tailnet for you in this manual mode. If a panel
implementing the claim handshake in `docs/PANEL_INTEGRATION.md` exists, pass
`--rest-api-url` and `--token` instead: the script links itself, joins
Tailscale with a key the panel mints, and reports its Tailscale IP back so
the panel knows where to reach it. It refuses `--start` until the node has a
Tailscale IP, since `docker-compose.yml` binds the API to that address. It
also points systemd-resolved at Cloudflare DNS and, on request, gives the
primary NIC a static address via netplan: pass `--static-ip=10.0.0.5/24`
(and `--gateway=` if the current default route isn't right), or answer the
question it asks on the terminal (`--no-prompt` skips it for unattended
runs). The static address is applied as the very last step because a changed
address drops your SSH session. Run `scripts/install.sh --help` for all
options.

This requires GPU passthrough already configured at the hypervisor level (the
script checks `lspci` and exits if no NVIDIA GPU is visible). The NVIDIA
driver itself is installed when missing: `ubuntu-drivers install` picks the
recommended package (override with `--nvidia-driver=nvidia-driver-550`, or
`--skip-nvidia-driver` to fail instead). The kernel module only loads after
a reboot, so the box reboots once and the install resumes by itself through
a oneshot systemd unit with the same arguments; follow it with
`tail -f /var/log/streamwizard-install.log`. Secure Boot must be off, since
an unattended run can't enrol a MOK key for the module.

### Updating a node

```bash
sudo -u obs bash -c 'cd /opt/obs-instance-manager && docker compose pull && docker compose up -d'
```

Nodes track the `:latest` tag, so this picks up whatever CI last built from
`main`. Note that a plain restart or host reboot re-uses the cached image — a
node only moves forward on an explicit `pull`.

To pin a node to a specific build instead, set `OBS_IMAGE_TAG` in
`/opt/obs-instance-manager/.env` to a tag CI published (e.g.
`OBS_IMAGE_TAG=sha-abc1234`) and re-run the command above. Leave it blank to
go back to tracking `:latest`. This never requires editing
`docker-compose.yml`.

### Removing a node

`scripts/uninstall.sh` reverses `install.sh`: it stops the stack, removes the
OBS containers/images and the `obs-net` network, deletes `/data/obs-configs`,
`/data/obs-plugins` and `/opt/obs-instance-manager`, and removes the `obs`
service account. The installer drops a copy at
`/opt/obs-instance-manager/uninstall.sh`, so teardown needs no network access.

```bash
sudo bash scripts/uninstall.sh
```

By default it leaves Docker, the NVIDIA Container Toolkit, Tailscale, and ufw
installed (other things on the host may depend on them). Pass
`--purge-docker`, `--purge-nvidia-toolkit`, `--purge-tailscale`,
`--remove-ufw-rule`, `--remove-dns`, and/or `--disable-ufw` (or `--all` for
all six) to fully reset a host back to a pre-`install.sh` state — useful when
testing the installer itself. `--remove-static-ip` (never part of `--all`,
since the address may change under your SSH session) drops the netplan file
`--static-ip` wrote. Run `scripts/uninstall.sh --help` for all options; it
always asks for confirmation first unless `--yes` is given.

## Prerequisites

- [Bun](https://bun.sh) (v1.3+) — only needed for local dev outside Docker
- Docker, with the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) installed and the `nvidia` runtime registered with the Docker daemon
- `nvidia-smi` available on the host running this API (used directly via the CLI for GPU metrics)
- [cAdvisor](https://github.com/google/cadvisor) running on the host, used for per-container CPU/RAM metrics (see below)

`scripts/install.sh` handles all of the above.

## Running everything with Docker Compose

The included `docker-compose.yml` pulls the prebuilt API image and runs it alongside cAdvisor — this is the recommended way to run on the host.

```bash
cp .env.example .env
# fill in .env with this node's NODE_ID, NODE_API_KEY and REST_API_URL
docker compose up -d
```

In a checkout, `docker-compose.override.yml` sits next to `docker-compose.yml`
and adds `build: .` back to the `api` service, so `docker compose up -d --build`
still builds from local source for development. Compose merges that file
automatically and only ever finds it in a checkout — nodes receive just
`docker-compose.yml`, so they always run the prebuilt image.

This starts:

- **`api`** — the REST API, from `ghcr.io/streamwizard/obs-instance-manager` (built from the included `Dockerfile`), with the host's Docker socket mounted (so it can manage sibling OBS containers) and GPU access passed through (`gpus: all`) for `nvidia-smi`. It joins both the internal-only `internal` network (to reach cAdvisor) and `obs-net` (to reach the instance containers it creates).
- **`cadvisor`** — used for per-container CPU/RAM metrics. It sits on an internal-only `internal` Docker network shared with `api` and has no port published to the host — only the `api` container can reach it, at `http://cadvisor:8080` (already wired up via the `CADVISOR_URL` env var in the compose file).

Requirements on the host: Docker with the NVIDIA Container Toolkit installed (so `gpus: all` and `nvidia-smi` work inside the `api` container), `nvidia-smi`-capable drivers installed on the host itself, and the `obs-net` Docker network created (`docker network create obs-net` — `scripts/install.sh` does this for you).

GPU/VRAM metrics are unaffected by any of this — cAdvisor has no per-process GPU support, so VRAM-per-container still comes from cross-referencing `nvidia-smi --query-compute-apps` PIDs against each container's process list (via Docker `top`), run directly inside the `api` container.

## Running the whole stack on a dev box (WSL2 + Docker Desktop)

Runs the manager against the local StreamWizard stack (local Supabase,
rest-api, web panel) with instance containers that use the box's NVIDIA GPU
directly. Every setting below defaults to the production value.

WSL2 has no NVIDIA DRM driver, so the shared `gpu-xserver` (real Xorg +
VirtualGL) cannot run. Instances get the GPU directly instead and OBS renders
through Mesa's d3d12 driver (`/dev/dxg`); NVENC works as usual. The Selkies
viewer stream is CPU x264, as in production.

1. Build the instance image in the `obs-cloud-selkies` repo:
   `docker compose build` (tags `obs-cloud-container-local:selkies`).
2. Start local Supabase and rest-api in the monorepo
   (`supabase start`, `cd apps/rest-api && bun run dev`).
3. Link this box as a node and write `.env.local`:
   `scripts/local/register-node.sh --park-other-nodes`.
4. Start the manager: `scripts/local/up.sh` (API on `http://localhost:3100`).
   `scripts/local/up.sh logs -f api` follows its logs.

| Variable | Production default | Local | Meaning |
|---|---|---|---|
| `OBS_INSTANCE_IMAGE` | `ghcr.io/streamwizard/obs-cloud-container:latest` | `obs-cloud-container-local:selkies` | Instance image. |
| `OBS_GPU_MODE` | `xserver` | `direct` | `xserver`: VirtualGL on `gpu-xserver`, bwrap jail. `direct`: GPU handed to the container, no jail privileges. |
| `OBS_GL_MODE` | (n/a) | `d3d12` | Direct mode only: `d3d12` (WSL2 GPU, mounts `OBS_WSL_LIB_DIR`, default `/usr/lib/wsl`) or `software`. |
| `SELKIES_*` | | | Forwarded to every instance's Selkies, overriding the defaults in `src/clients/instance-spec.ts`. `SELKIES_BASIC_AUTH_PASSWORD` is ignored: each instance gets its own. |
| `ALLOW_MISSING_STREAM_KEY` | `false` | `true` | Boot without a Twitch stream key instead of refusing. Never on a real node. |

## Running without Docker Compose

If you'd rather run the API directly with Bun and cAdvisor as a separate container:

```bash
docker run \
  --volume=/:/rootfs:ro \
  --volume=/var/run:/var/run:ro \
  --volume=/sys:/sys:ro \
  --volume=/var/lib/docker/:/var/lib/docker:ro \
  --volume=/dev/disk/:/dev/disk:ro \
  --publish=8080:8080 \
  --detach=true \
  --name=cadvisor \
  gcr.io/cadvisor/cadvisor:latest
```

Set `CADVISOR_URL` (default `http://localhost:8080`) if it's reachable somewhere other than localhost.

## Setup

```bash
bun install
cp .env.example .env
# fill in .env with this node's NODE_ID, NODE_API_KEY and REST_API_URL
```

## Database schema

This API shares its Supabase database with the main [streamwizard](https://github.com/streamwizard/streamwizard) monorepo, so the `obs_nodes` and `obs_instances` table migration lives there: `supabase/migrations/20260623000000_obs_instances.sql`. Apply it via that repo's Supabase CLI workflow (`supabase db push` / `supabase migration up`), not from this repo.

It creates the `obs_nodes` and `obs_instances` tables, enables RLS on both (`obs_nodes` is service-role only; `obs_instances` allows owners to read/delete their own rows), and seeds one default `obs_nodes` row. Before going to production, update the seeded `gpu_bus_id` to match the actual host:

```bash
nvidia-smi --query-gpu=pci.bus_id --format=csv,noheader
```

For multi-node setups, see `docs/PANEL_INTEGRATION.md` — it documents the
schema changes (dropping the now-unused per-instance port-range columns) and
the node-claim handshake a future panel would implement.

## Running the dev server

```bash
bun run src/index.ts
```

The server listens on `PORT` (default `3000`) and logs the port on startup.

## Environment variables

| Variable | Description |
|---|---|
| `NODE_ID` | The `obs_nodes.id` row this process represents. Required — every instance-manager process serves exactly one node. |
| `NODE_API_KEY` | This node's key for authenticating to `streamwizard-api` (issued by the panel at claim time) |
| `REST_API_URL` | Base URL of the panel's `streamwizard-api` |
| `PORT` | Port the API listens on (default `3000`) |
| `OBS_IMAGE_TAG` | Read by `docker-compose.yml`, not the app. Blank tracks `:latest`; set to `sha-<short>` to pin the node to a specific build |
| `CADVISOR_URL` | Base URL of the cAdvisor instance used for container CPU/RAM metrics (default `http://localhost:8080`) |
| `OBS_NETWORK` | Docker network shared with instance containers for the websocket proxy (default `obs-net`) |
| `PANEL_ORIGIN` | Comma-separated origin(s) allowed to call the REST API directly from a browser (CORS). Default `*` |

## API reference

All `/instances`, `/metrics` and `/admin` REST routes require `Authorization: Bearer <node token>`. A node token is a 60-second Ed25519 JWT that web-admin or web-streamwizard signs for one call: `aud` is this node's id, `scope` is the one action it allows (`instances:control`, `files`, `ws-ticket`, `admin:instances`, ...) and `iid` names the instance on any route with an `:id`. The node verifies it with the public keys it gets from `GET /api/obs-nodes/me` (one key set per environment, so a new node needs no extra config). A token for another node, another scope or another instance is refused (`401`/`403`). `/admin` routes also need `role: "admin"` in the token and the admin role in `user_roles`.

A Supabase session JWT is not accepted: every call needs a node token.

WebSocket upgrades (obs-websocket, the admin metrics stream) can't send headers, so they use a 30-second single-use `?ticket=` from the matching `POST .../ws-ticket` route instead. The Selkies viewer carries its ticket in the URL fragment (see below).

### `GET /health`

- **Auth:** none
- **Response:** `{ "ok": true, "timestamp": "<ISO 8601>" }`

### `GET /instances`

- **Auth:** required
- **Response:** array of the user's instances, each with a live `docker_status` field (`running` / `stopped` / `not_found`) merged in.

### `GET /instances/:id`

- **Auth:** required
- **Response:** the instance (only if owned by the caller) with a live `docker_status` field. `404` if not found or not owned by the caller.

### `POST /instances`

- **Auth:** required
- **Body:** `{ "resolution"?: string }` — defaults to `"1920x1080"`.
- **Behavior:** loads this node's config (`NODE_ID`), checks `max_instances` and `total_vram_mb` capacity, creates and starts the Docker container on the shared `obs-net` network (no host ports published), and persists the instance row.
- **Response:** `201` with the full instance row. `409` if the node is at capacity or VRAM would be exceeded.

### `GET /instances/:id/obsws`

- **Auth:** a ws-ticket with scope `obsws` (`?ticket=`), minted by `POST /instances/:id/ws-ticket`
- **Behavior:** upgrades to a WebSocket and bridges it 1:1 to the instance's internal OBS websocket port (`4455`) over `obs-net`, for OBS Studio scene/source control. It's never published to the host.
- Closes with code `4404` immediately after upgrading if the instance isn't found or isn't owned by the caller.

### `GET /instances/:id/selkies/`

- **Auth:** a ws-ticket with scope `selkies` (2-minute TTL), minted by `POST /instances/:id/ws-ticket`, in the URL fragment: the panel opens `/instances/:id/selkies/#token=<ticket>` as its own window. Browsers never send the fragment to a server.
- **Behavior:** everything under the prefix is proxied to the container's port `8080` over `obs-net`.
  - Static client files (anything outside `/api/`, GET only) load without the ticket: they are the stock Selkies client.
  - `/api/*` needs the ticket, which the Selkies client sends as `Authorization: Bearer` on fetches and as the `selkies.token.<base64url>` WebSocket subprotocol. The first use spends the ticket and opens a viewer session (`services/auth/selkies-viewer-sessions.ts`) that lives while a socket is open plus 2 minutes after the last one closes, capped at 12 hours. Every WebSocket connect checks instance ownership again (the admin role on the admin route), so revoked access ends with the socket. There is no cookie.
  - Incoming cookies and `Authorization` are never forwarded; the proxy adds the instance's own Selkies basic auth (rest-api's per-instance `vnc_password`), so the browser never sees it.
  - `/admin/instances/:id/selkies/` is the same for admins.

### `POST /instances/:id/start`

- **Auth:** required
- **Behavior:** starts the container and sets `status` to `running`.
- **Response:** the updated instance row. `404` if not found/owned.

### `POST /instances/:id/stop`

- **Auth:** required
- **Behavior:** stops the container (10s grace period) and sets `status` to `stopped`.
- **Response:** the updated instance row. `404` if not found/owned.

### `DELETE /instances/:id`

- **Auth:** required
- **Behavior:** stops (ignoring errors) and force-removes the container, then deletes the instance row.
- **Response:** `{ "success": true }`. `404` if not found/owned.

### `GET /metrics/snapshot`

- **Auth:** required
- **Behavior:** one-shot metrics collection across all of the caller's running instances plus the host.
- **Response:** a `MetricsPayload`:

```json
{
  "timestamp": "2024-01-01T00:00:00.000Z",
  "host": {
    "gpu_name": "string",
    "vram_used_mb": 0,
    "vram_total_mb": 0,
    "gpu_util_pct": 0,
    "mem_controller_util_pct": 0,
    "nvenc_avg_fps": 0,
    "gpu_temp_c": 0,
    "cpu_pct": 0,
    "ram_used_mb": 0,
    "ram_total_mb": 0
  },
  "containers": {
    "<instance_id>": {
      "cpu_pct": 0,
      "ram_used_mb": 0,
      "ram_limit_mb": 0,
      "vram_used_mb": 0
    }
  }
}
```

### `GET /metrics/stream`

- **Auth:** required (use `?token=` for `EventSource`)
- **Behavior:** Server-Sent Events stream. Sends one `metrics` event immediately on connect, then every 3 seconds for as long as the client stays connected. Each event's `data` is a JSON-encoded `MetricsPayload` (same shape as `/metrics/snapshot`).

### `GET /admin/metrics/stream`

- **Auth:** a single-use `?ticket=` from `POST /admin/ws-ticket` (scope `metrics`), which itself needs an `admin:ws-ticket` node token and the `admin` role in `user_roles`.
- **Behavior:** WebSocket. Pushes a `MetricsPayload` immediately on connect and then every 3 seconds, covering **every** instance on this node (not scoped to one user) — this is what a panel's admin Nodes page consumes. Since the ticket is minted per admin, the admin's browser can connect directly — no server-side relay needed.
