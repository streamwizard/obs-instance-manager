# Panel integration: node linking

This describes the Wings-style "add a node, get an install command, run it,
node links itself" flow for obs-instance-manager. The panel side (the piece
that creates `obs_nodes` rows and issues claim tokens) lives in the
`streamwizard` monorepo's `rest-api` app, not in this repo — this doc is the
contract that app needs to implement against. `scripts/install.sh` in this
repo speaks this protocol on the node side (`--rest-api-url` / `--token`
flags) and falls back to manual `.env` setup when they're omitted.

## Why a node needs to know who it is

A single obs-instance-manager process now serves exactly one `obs_nodes` row,
identified by the `NODE_ID` env var (see `.env.example`). With one node this
was implicit (`getDefaultNode()` just grabbed the only row); with multiple
nodes each process must be told which row is "self". The panel is what hands
out that `NODE_ID`, along with the rest of the node's `.env`, during linking.

## Flow

1. **Admin creates a node in the panel UI.** Panel inserts a row into
   `obs_nodes` with `status = 'pending'`, the admin-chosen fields (`name`,
   `max_instances`, and optionally `api_url`), and a freshly generated
   **claim token**. Store only a hash of the token (e.g. SHA-256), with an
   expiry (suggest 15–30 minutes, matching Wings' UX) — the same way you'd
   store a password reset token.

   `api_url` is normally left blank: the node fills it in itself as
   `http://<tailscale-ip>:3000` once it has joined Tailscale (step 5). Set it
   by hand only to override that, e.g. with a Cloudflare Tunnel hostname when
   browsers outside the tailnet need to reach the node.

   Everything else about the physical node — `gpu_bus_id`, `total_vram_mb`,
   `ram_total_mb`, `cpu_cores`, `gpu_model`, `storage_total_mb`, `hostname`,
   `tailscale_ip` — is left blank at creation time; the node reports these
   facts about itself during claim, since it can't be known until the node
   calls in. (Per-instance
   Docker resource limits — memory/CPU/shm — are **not** node-level fields at
   all; they come from the calling user's subscription plan at instance
   creation time, so there's nothing to collect here for them.)

2. **Panel shows an install command**, e.g.:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/streamwizard/obs-instance-manager/main/scripts/install.sh \
     | sudo bash -s -- --rest-api-url=https://api.example.com --token=<claim-token>
   ```

   Add `--ref=<branch-or-tag>` to install a node from something other than
   `main`. It selects which `docker-compose.yml` / `.env.example` the script
   fetches; the image tag itself is controlled separately by `OBS_IMAGE_TAG`
   in the node's `.env`.

3. **Admin runs that command on the new VM.** `install.sh` provisions the
   host (NVIDIA driver if missing — with one automatic reboot and resume —
   plus the container toolkit, Docker, Tailscale, `obs-net` network, ufw,
   `obs` service user, and `/opt/obs-instance-manager` holding the fetched
   `docker-compose.yml`) and then calls:

   ```
   POST {rest-api-url}/api/obs-nodes/claim
   Content-Type: application/json

   {
     "token": "<claim-token>",
     "gpu_bus_id": "00000000:00:10.0",
     "vram_total_mb": 8192,
     "ram_total_mb": 32768,
     "cpu_cores": 8,
     "gpu_model": "NVIDIA GeForce RTX 2070",
     "storage_total_mb": 102400
   }
   ```

   (`gpu_bus_id`/`vram_total_mb`/`gpu_model` from `nvidia-smi`, `ram_total_mb`
   from `/proc/meminfo`, `cpu_cores` from `nproc`, `storage_total_mb` from
   `df` on the root filesystem.) This lives in `rest-api` rather than the
   Next.js panel app — it's a machine-to-machine endpoint with no Supabase
   session involved, hit by a fresh, untrusted VM with nothing but a
   one-time token, which fits `rest-api`'s existing brute-force protection
   and security middleware better than the cookie/session-oriented routes
   in the web app.

4. **rest-api validates and responds.** Look up the pending node by token
   hash, reject if expired/already claimed/not found (`404`). On success:
   mark the token consumed, fill in `gpu_bus_id` and the self-reported
   hardware fields on the row, slugify the node's `name` into a `hostname`
   (e.g. `"GPU Box 1"` → `gpu-box-1`) and store that too, set
   `status = 'linked'`, and return (actual current shape, see
   `apps/rest-api/src/routes/nodes.ts`):

   ```json
   {
     "node_id": "<uuid, the obs_nodes.id>",
     "node_api_key": "<node's long-lived bearer credential>",
     "hostname": "gpu-box-1",
     "tailscale_authkey": "<single-use, tag:obs-node key, or null>",
     "rest_api_url": "https://api.example.com",
     "S3_ENDPOINT": "...", "S3_ACCESS_KEY": "...", "S3_SECRET_KEY": "...",
     "S3_BUCKET": "...", "S3_REGION": "..."
   }
   ```

5. **Node joins Tailscale** using `tailscale_authkey` (if present), then
   reports its address back on its own authenticated round trip:

   ```
   PATCH {rest-api-url}/api/obs-nodes/me
   Authorization: Bearer <node_api_key>
   Content-Type: application/json

   { "tailscale_ip": "100.64.0.10" }
   ```

   rest-api stores `tailscale_ip` on the row and, if `api_url` is still
   blank, sets it to `http://<tailscale_ip>:3000`. An admin-set `api_url` is
   never overwritten. The node then **writes `.env`** from the claim response
   (including `TAILSCALE_IP`) and **sets its own hostname** to the returned
   `hostname` (`hostnamectl set-hostname`, `/etc/hosts`' `127.0.1.1` line, and
   `tailscale set --hostname`) before bringing the stack up. This is what
   makes a freshly imaged, generically-named VM identify itself correctly —
   matching what the panel already calls it — with no manual rename step.

## Automated Tailscale join

A node joins Tailscale first of all so its OBS containers can pull SRT from
an ingest node's tailnet-only output port. It also decides where the node's
own API (port 3000) is reachable: `docker-compose.yml` publishes it on
`127.0.0.1:3000` and `${TAILSCALE_IP}:3000` — never the LAN, never a public
interface — and refuses to start while `TAILSCALE_IP` is blank. ufw allows
the port in on `tailscale0` (loopback is allowed by default). The ufw rule is
belt-and-braces: Docker-published ports bypass ufw, so the bind addresses
are the real control.

The loopback binding is for a Cloudflare Tunnel running on the node
(`cloudflared` origin `http://localhost:3000`): that is how browsers (the Selkies viewer,
obs-websocket) and the panel apps reach the node, and it has no dependency
on Tailscale being up. The admin sets the tunnel hostname as the node's
`api_url`. The Tailscale binding is for tailnet hosts — the alert worker,
web-admin health probes, admins — and is what the auto-filled `api_url`
points at until the admin overrides it.

So a node can join the tailnet without an admin generating and pasting a key,
`/claim` mints one: rest-api holds a Tailscale OAuth client
(`TAILSCALE_OAUTH_CLIENT_ID` / `TAILSCALE_OAUTH_CLIENT_SECRET`, the same one
`/api/ingest-nodes/claim` uses) scoped to `auth_keys` for `tag:obs-node` and
`tag:ingest-node`, and creates a single-use, pre-authorized, 1-hour key tagged
`tag:obs-node` per claim (`apps/rest-api/src/lib/tailscale.ts`). Minting is
non-fatal: if the Tailscale API is unreachable or the OAuth client isn't
scoped for the tag, `/claim` still succeeds and returns
`tailscale_authkey: null`; `install.sh` then warns and tells the admin to run
`tailscale up` by hand, add the ufw rule, set `TAILSCALE_IP` in `.env`, and
call `PATCH /api/obs-nodes/me` themselves.

Tailnet prerequisites (one-off, in the Tailscale admin console):

- `tag:obs-node` in `tagOwners`, with the same owner as `tag:ingest-node`.
- An ACL rule letting admins and the hosts that call nodes reach
  `tag:obs-node:3000`; add `tag:obs-node` to the `ssh` rule too if you rely
  on Tailscale SSH (install.sh runs `tailscale up --ssh`).
- The OAuth client must be allowed to mint keys for `tag:obs-node`. Tailscale
  fixes an OAuth client's tags at creation, so this usually means creating a
  replacement client and rotating both env vars.

## Realtime admin metrics

Every node exposes `GET /admin/metrics/stream` — a WebSocket. Like every
other WebSocket on the node it authenticates with a 30-second single-use
`?ticket=`, minted by `POST /admin/ws-ticket` (see `src/routes/admin.ts`).
That mint route needs a node token with scope `admin:ws-ticket` and
`role: "admin"`; `403` otherwise. On connect the stream pushes a
`MetricsPayload` (same shape as `/metrics/snapshot`, but for **every**
instance on the node, not scoped to one end user) immediately and then
every 3 seconds for as long as the connection stays open.

Because the ticket comes from the admin's own node token rather than a
separate node-wide secret, an admin's browser can open this websocket
**directly** — `ws://{api_url}/admin/metrics/stream?ticket={ticket}` —
the same way an end user's browser connects directly to `/metrics/stream`,
`/instances/:id/selkies/`, and `/instances/:id/obsws`. No panel-side relay or
node-wide credential is needed. `api_url` defaults to the node's tailnet
address (`http://100.64.0.10:3000`, filled in at link time — see "Automated
Tailscale join"), which only works from a machine on the tailnet. For
browsers, the admin overrides `api_url` with the node's Cloudflare Tunnel
hostname in the panel UI (the tunnel's origin is the loopback binding,
`http://localhost:3000`) — it's just "where do I reach this node's API".

## Selkies viewer in a panel frame

The apps (web-streamwizard `/obs-viewer`, web-admin `/obs-desktop`) show an
instance's Selkies viewer in a cross-origin `<iframe>` and draw their own
header and controls around it. Nothing from the container runs on an app's
origin: the Selkies client stays on the node's origin, which holds nothing
but a spent ticket.

**Opening it**

1. `HEAD {api_url}/instances/:id/selkies/` (admins: `/admin/instances/...`)
   until it answers `200`. It needs no ticket; `503` means OBS is still
   starting.
2. Mint a ticket (`POST .../ws-ticket` with `{ "scope": "selkies" }`) and
   set the frame's `src` to `.../selkies/#token=<ticket>`, with
   `allow="clipboard-read; clipboard-write; autoplay; fullscreen"`. No
   `sandbox`: Selkies needs scripts and its own origin.
3. On every frame `load`, post `{ type: "sw-hello" }` to the node's origin.

**The relay** (`services/proxy/viewer-relay/relay.ts`) pairs only with a
`sw-hello` from the frame's direct parent whose origin is in `PANEL_ORIGIN`
(injected into the page on each request, never fetched). With
`PANEL_ORIGIN=*` or unset it refuses to pair and logs once; the viewer still
works, without the app's controls. Messages:

| Direction | `type` | Fields |
|-----------|--------|--------|
| relay → app | `sw-ready` | `version` (1). Followed by the last `pipelineStatusUpdate` the client sent. |
| relay → app | `viewer-expired` | Sent once when the viewer session is dead. |
| relay → app | `pipelineStatusUpdate` | `video?`, `audio?` (booleans) |
| relay → app | `clientRoleUpdate` | `role`. Only sent in Selkies' secure mode, which instances don't run. |
| app → client | `setMute` | `value` (boolean) |
| app → client | `setVolume` | `value` (0 to 1) |
| app → client | `pipelineControl` | `pipeline: "audio"`, `enabled` (boolean) |

Everything else is dropped in both directions, clipboard text included
(Selkies syncs the clipboard itself inside the frame, with Ctrl+C and
Ctrl+V), and the relay rebuilds each message from the fields above. In a frame the relay also stops
`pointerrawupdate` before Selkies sees it: Chromium gives those events
top-window coordinates, so hover landed below the pointer by the frame's
offset. Selkies then sends motion from `mousemove`, as in Safari. The relay posts to the app with the app's
origin as the target, never `*`. Selkies' `stats` reply can't be relayed: the
client posts it to `window.parent` with its own origin as the target.

**Expiry.** The viewer session dies 2 minutes after the last socket closes, or
after 12 hours. The Selkies client then probes `GET .../api/websockets`, which
answers `401`; the relay catches that, posts `viewer-expired` and from then
on answers the client's API calls with `503` itself, so the client stops
reloading the page. The app mints a new ticket and loads a **new frame** with
it. Changing only the `#token` of the same frame is not enough: the client
reads the token for its socket once per page load.

A dead ticket on the WebSocket upgrade keeps getting HTTP `401` rather than an
accepted socket closed with `4001`: the `4001` would stop the client, but it
also skips the probe the relay watches.

Opened at the top level (no frame), the page shows "Viewer session ended.
Reopen it from your dashboard." on expiry instead of looping.

## Target architecture: nodes hold no real state

Pterodactyl Wings' core design principle is worth adopting wholesale here:
the node agent holds no relational state of its own and never touches the
Panel's database directly — it only talks to the Panel over a REST API, and
rebuilds an in-memory view of "its" data at boot. obs-instance-manager
currently violates this (see below) by calling Supabase directly with the
service-role key. That's an acceptable shortcut for a single trusted node,
but it's the thing to fix before this scales past a handful of nodes:
replace `src/lib/supabase.ts`'s direct Supabase calls with calls to
panel-owned, node-scoped endpoints instead.

One concrete piece of that worth building early: a **deauthorize push**.
Wings had a real vulnerability (CVE-2025-68954) where revoking a user's
access didn't close their already-open sessions. The fix was a Panel→Wings
`POST /api/deauthorize-user` call that force-closes that user's live
connections immediately. We have the same exposure: a user's Selkies viewer or `/instances/:id/obsws`
websocket stays open until it closes, even if their access is revoked in the
meantime (ownership is only checked at each upgrade). The node-side fix
is straightforward once there's a reason to add an authenticated
node-control endpoint — track open proxy connections by `userId` in memory
and expose a way to force-close them.

## Resolved: nodes no longer talk to Supabase directly

An earlier version of this doc flagged that every node received the global
Supabase service-role key and called Supabase directly, bypassing RLS. That's
no longer the case: all database access goes through
`src/clients/streamwizard-api/` (one module per domain: `nodes`, `instances`,
`users`, `subscriptions`), which calls the panel's `/api/obs-nodes/*` endpoints
using the node's own `NODE_API_KEY` instead. Each node's blast
radius is now whatever those node-scoped endpoints expose, not the whole
database.

## Schema changes needed in the streamwizard repo

The per-instance VNC/noVNC/OBS-websocket port-range model is gone — instances
are no longer published to the host at all, they're reached through
obs-instance-manager's own proxy (`/instances/:id/selkies/`,
`/instances/:id/obsws`) over a Docker-internal network. Run this migration
(adjust name/timestamp to the repo's convention) against the existing
`20260623000000_obs_instances.sql`:

```sql
alter table obs_nodes
  drop column if exists vnc_port_start,
  drop column if exists vnc_port_end,
  drop column if exists novnc_port_start,
  drop column if exists novnc_port_end,
  drop column if exists obs_ws_port_start,
  drop column if exists obs_ws_port_end,
  add column if not exists status text not null default 'linked',
  add column if not exists claim_token_hash text,
  add column if not exists claim_token_expires_at timestamptz,
  add column if not exists api_url text;

alter table obs_instances
  drop column if exists vnc_port,
  drop column if exists novnc_port,
  drop column if exists obs_ws_port;
```

Existing `obs_nodes` rows (including the seeded default one) should have
`status` backfilled to `'linked'` since they're already running.

Two more columns are needed for the VNC-password and NVENC-session-budget
work in this repo:

```sql
alter table obs_nodes
  add column if not exists max_encoder_sessions integer;

alter table obs_instances
  add column if not exists vnc_password_ciphertext text,
  add column if not exists vnc_password_iv text,
  add column if not exists vnc_password_tag text;
```

`max_encoder_sessions` should be set to `8` for consumer (GeForce) GPU nodes
— the concurrent-NVENC-session cap the driver enforces regardless of VRAM
headroom — and left `null` (unlimited) for Quadro/RTX-A nodes, which have no
such cap. `vnc_password_*` mirrors the existing `obs_ws_password_*` columns'
shape. rest-api generates and encrypts it when the node creates the row; the
password is purely an obs-net isolation measure that the end user never
needs to see. Despite the name it is now the Selkies viewer's basic-auth
password: the manager passes it to the container and adds it as the
Authorization header on its own proxy.

The node never holds `TOKEN_ENCRYPTION_KEY` and never sees these encrypted
columns. It sends the plaintext OBS WebSocket password on create and reads
both passwords back, in plaintext and only for its own instances, from
`GET /api/obs-nodes/instances/:id/secrets`.

Note: an earlier version of this doc also had this migration add an
`admin_token` column, used to authenticate a panel-side relay for
`/admin/metrics/stream`. That's gone now — see "Realtime admin metrics"
above — the admin browser connects directly with a ws-ticket from its own node token,
so no separate node-wide secret or relay is needed.
