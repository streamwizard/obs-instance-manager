# OBS Cloud Panel API

REST API backend that manages OBS cloud containers on demand. Each container runs a headless OBS Studio instance (Xorg, NVIDIA GPU, x11vnc, noVNC) and is owned by a single Supabase-authenticated user. The backend also streams per-container and host resource metrics in real time over SSE.

## Prerequisites

- [Bun](https://bun.sh) (v1.3+)
- Docker, with the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) installed and the `nvidia` runtime registered with the Docker daemon
- `nvidia-smi` available on the host running this API (used directly via the CLI for GPU metrics)
- [cAdvisor](https://github.com/google/cadvisor) running on the host, used for per-container CPU/RAM metrics (see below)
- A Supabase project (local or hosted)

## Running cAdvisor

Per-container CPU and RAM metrics come from cAdvisor's REST API rather than polling `docker stats` directly. Run it alongside the Docker daemon it should monitor:

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

GPU/VRAM metrics are unaffected — cAdvisor has no per-process GPU support, so VRAM-per-container still comes from cross-referencing `nvidia-smi --query-compute-apps` PIDs against each container's process list (via Docker `top`).

## Setup

```bash
bun install
cp .env.example .env
# fill in .env with your Supabase project values
```

## Running the migration

Using the Supabase CLI:

```bash
supabase db push
# or, for local development:
supabase start
supabase migration up
```

This creates the `nodes` and `instances` tables, enables RLS on `instances`, and seeds one default `nodes` row. Before going to production, update the seeded `gpu_bus_id` to match the actual host:

```bash
nvidia-smi --query-gpu=pci.bus_id --format=csv,noheader
```

## Running the dev server

```bash
bun run src/index.ts
```

The server listens on `PORT` (default `3000`) and logs the port on startup.

## Environment variables

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key, used by the backend to bypass RLS for all writes |
| `SUPABASE_JWT_SECRET` | Used to verify user JWTs in the auth middleware |
| `PORT` | Port the API listens on (default `3000`) |
| `CADVISOR_URL` | Base URL of the cAdvisor instance used for container CPU/RAM metrics (default `http://localhost:8080`) |

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
- **Behavior:** loads the node config, checks `max_instances` and `total_vram_mb` capacity, allocates free ports, creates and starts the Docker container, and persists the instance row.
- **Response:** `201` with the full instance row (includes `vnc_port`, `novnc_port`, `obs_ws_port`). `409` if the node is at capacity, VRAM would be exceeded, or no ports are free.

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
