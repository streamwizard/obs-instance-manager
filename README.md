# OBS Cloud Panel API

REST API backend that manages OBS cloud containers on demand. Each container runs a headless OBS Studio instance (Xorg, NVIDIA GPU, x11vnc, noVNC) and is owned by a single Supabase-authenticated user. The backend also streams per-container and host resource metrics in real time over SSE.

Instance containers publish no ports to the host at all — noVNC and the OBS
websocket are reached by proxying through this API itself
(`/instances/:id/novnc`, `/instances/:id/obsws`) over a Docker-internal
network. The only port a node needs open is the API's own (`3000` by
default). This is what lets a node be added to the firewall once, regardless
of how many concurrent OBS instances it runs.

## Setting up a new node

`scripts/install.sh` provisions a fresh Ubuntu host end to end (Docker, the
NVIDIA Container Toolkit, the `obs-net` Docker network, ufw rules, and a
dedicated `obs` service account):

```bash
sudo bash scripts/install.sh --start
```

A node never gets a copy of this source. The installer fetches just
`docker-compose.yml` and `.env.example` from GitHub into
`/opt/obs-instance-manager` and pulls the prebuilt API image from GHCR
(`ghcr.io/streamwizard/obs-instance-manager`), which CI builds on every merge
to `main` (see `.github/workflows/build-images.yml`). Pass `--ref` to install
from a branch or tag other than `main`.

By default it only opens the firewall to your auto-detected LAN `/24` and
expects you to fill in `.env` by hand afterward (`NODE_ID`, `NODE_API_KEY`,
`REST_API_URL`, `SUPABASE_URL`). If a panel implementing the claim handshake
in `docs/PANEL_INTEGRATION.md` exists, pass `--rest-api-url` and `--token`
instead and the script links itself automatically. Run
`scripts/install.sh --help` for all options.

This requires GPU passthrough already configured at the hypervisor level and
the NVIDIA driver already installed on the host — the script checks for both
and exits with instructions rather than attempting to install kernel drivers
itself.

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
OBS containers/images and the `obs-net` network, deletes `/data/obs-configs`
and `/opt/obs-instance-manager`, and removes the `obs` service account. The
installer drops a copy at `/opt/obs-instance-manager/uninstall.sh`, so
teardown needs no network access.

```bash
sudo bash scripts/uninstall.sh
```

By default it leaves Docker, the NVIDIA Container Toolkit, and ufw installed
(other things on the host may depend on them). Pass `--purge-docker`,
`--purge-nvidia-toolkit`, `--remove-ufw-rule`, and/or `--disable-ufw` (or
`--all` for all four) to fully reset a host back to a pre-`install.sh` state
— useful when testing the installer itself. Run `scripts/uninstall.sh --help`
for all options; it always asks for confirmation first unless `--yes` is
given.

## Prerequisites

- [Bun](https://bun.sh) (v1.3+) — only needed for local dev outside Docker
- Docker, with the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) installed and the `nvidia` runtime registered with the Docker daemon
- `nvidia-smi` available on the host running this API (used directly via the CLI for GPU metrics)
- [cAdvisor](https://github.com/google/cadvisor) running on the host, used for per-container CPU/RAM metrics (see below)
- A Supabase project (local or hosted)

`scripts/install.sh` handles all of the above except the Supabase project.

## Running everything with Docker Compose

The included `docker-compose.yml` pulls the prebuilt API image and runs it alongside cAdvisor — this is the recommended way to run on the host.

```bash
cp .env.example .env
# fill in .env with your Supabase project values and this node's NODE_ID
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
# fill in .env with your Supabase project values
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
| `SUPABASE_URL` | Supabase project URL |
| `NODE_API_KEY` | This node's key for authenticating to `streamwizard-api` (issued by the panel at claim time) |
| `REST_API_URL` | Base URL of the panel's `streamwizard-api` |
| `PORT` | Port the API listens on (default `3000`) |
| `OBS_IMAGE_TAG` | Read by `docker-compose.yml`, not the app. Blank tracks `:latest`; set to `sha-<short>` to pin the node to a specific build |
| `CADVISOR_URL` | Base URL of the cAdvisor instance used for container CPU/RAM metrics (default `http://localhost:8080`) |
| `OBS_NETWORK` | Docker network shared with instance containers for the websocket proxy (default `obs-net`) |
| `PANEL_ORIGIN` | Comma-separated origin(s) allowed to call the REST API directly from a browser (CORS). Default `*` |

## API reference

All `/instances` and `/metrics` routes require authentication: send the Supabase JWT either as `Authorization: Bearer <token>` or as a `?token=<token>` query parameter (the query param exists because the browser's native `EventSource` cannot set custom headers).

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

### `GET /instances/:id/novnc`

- **Auth:** required (`?token=` works here too, since browsers can't set headers on a WebSocket handshake)
- **Behavior:** upgrades to a WebSocket and bridges it 1:1 to the instance container's internal noVNC websocket port (`6080`) over `obs-net`. This is the only way to reach noVNC — it's never published to the host.
- Closes with code `4404` immediately after upgrading if the instance isn't found or isn't owned by the caller.

### `GET /instances/:id/obsws`

- **Auth:** required (`?token=` supported)
- **Behavior:** same bridge as above, to the instance's internal OBS websocket port (`4455`), for OBS Studio scene/source control.

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

- **Auth:** required — a Supabase JWT (`Authorization: Bearer <token>` or `?token=`), same as every other route here, but the caller must additionally have the `admin` role in `user_roles`. `403` if the JWT is valid but the user isn't an admin.
- **Behavior:** WebSocket. Pushes a `MetricsPayload` immediately on connect and then every 3 seconds, covering **every** instance on this node (not scoped to one user) — this is what a panel's admin Nodes page consumes. Since this is gated by the caller's own admin-scoped JWT rather than a node-wide secret, the admin's browser can connect directly — no server-side relay needed.
