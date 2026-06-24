# Panel integration: node linking

This describes the Wings-style "add a node, get an install command, run it,
node links itself" flow for obs-instance-manager. The panel side (the piece
that creates `obs_nodes` rows and issues claim tokens) lives in the
`streamwizard` monorepo, not in this repo — this doc is the contract the panel
needs to implement against. Nothing here is built yet; `scripts/install.sh` in
this repo already speaks this protocol on the node side (`--panel-url` /
`--token` flags) and falls back to manual `.env` setup when they're omitted.

## Why a node needs to know who it is

A single obs-instance-manager process now serves exactly one `obs_nodes` row,
identified by the `NODE_ID` env var (see `.env.example`). With one node this
was implicit (`getDefaultNode()` just grabbed the only row); with multiple
nodes each process must be told which row is "self". The panel is what hands
out that `NODE_ID`, along with the rest of the node's `.env`, during linking.

## Flow

1. **Admin creates a node in the panel UI.** Panel inserts a row into
   `obs_nodes` with `status = 'pending'`, the admin-chosen capacity fields
   (`max_instances`, `memory_mb`, `cpu_quota`, `vram_mb`, `total_vram_mb`,
   `shm_size`), and a freshly generated **claim token**. Store only a hash of
   the token (e.g. SHA-256), with an expiry (suggest 15–30 minutes, matching
   Wings' UX) — the same way you'd store a password reset token.

   `gpu_bus_id` is left blank; the node reports its own GPU's PCI bus id
   during claim (it can't be known until the node calls in).

2. **Panel shows an install command**, e.g.:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/streamwizard/obs-instance-manager/main/scripts/install.sh \
     | sudo bash -s -- --panel-url=https://panel.example.com --token=<claim-token>
   ```

3. **Admin runs that command on the new VM.** `install.sh` provisions the
   host (Docker, NVIDIA toolkit check, `obs-net` network, ufw, `obs` service
   user, `/opt/obs-instance-manager` checkout) and then calls:

   ```
   POST {panel-url}/api/nodes/claim
   Content-Type: application/json

   {
     "token": "<claim-token>",
     "gpu_bus_id": "00000000:00:10.0",
     "vram_total_mb": 8192,
     "ram_total_mb": 32768,
     "cpu_cores": 8
   }
   ```

   (`gpu_bus_id` from `nvidia-smi --query-gpu=pci.bus_id --format=csv,noheader`,
   the rest from `/proc/meminfo` and `nproc`.)

4. **Panel validates and responds.** Look up the pending node by token hash,
   reject if expired/already claimed/not found (`404`). On success: mark the
   token consumed, fill in `gpu_bus_id` on the row, set `status = 'linked'`,
   and return:

   ```json
   {
     "node_id": "<uuid, the obs_nodes.id>",
     "supabase_url": "https://xxxx.supabase.co",
     "supabase_service_role_key": "...",
     "supabase_jwt_secret": "..."
   }
   ```

5. **Node writes `.env`** from that response (`NODE_ID`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`) and
   brings the stack up.

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
connections immediately. We have the same exposure: a user's `/instances/:id/novnc`
or `/instances/:id/obsws` websocket stays open until their Supabase JWT
expires, even if their access is revoked in the meantime. The node-side fix
is straightforward once there's a reason to add an authenticated
node-control endpoint — track open proxy connections by `userId` in memory
and expose a way to force-close them.

## Known trade-off: every node gets the global service-role key

Step 4 hands the node the *same* Supabase service-role key every other node
gets — it bypasses RLS entirely. That's an acceptably broad trust model for a
first cut (mirrors early Wings daemon tokens), but it means a compromised
node compromises the whole database, not just its own rows. The clean fix is
to stop having obs-instance-manager talk to Supabase directly at all, and
instead have it call back through panel-owned API endpoints scoped to that
node's own `obs_nodes`/`obs_instances` rows — but that's a real rewrite of
`src/lib/supabase.ts`'s call sites, not a config change, so it's deliberately
out of scope here. Worth doing before this goes past a handful of trusted
nodes.

## Schema changes needed in the streamwizard repo

The per-instance VNC/noVNC/OBS-websocket port-range model is gone — instances
are no longer published to the host at all, they're reached through
obs-instance-manager's own websocket proxy (`/instances/:id/novnc`,
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
  add column if not exists claim_token_expires_at timestamptz;

alter table obs_instances
  drop column if exists vnc_port,
  drop column if exists novnc_port,
  drop column if exists obs_ws_port;
```

Existing `obs_nodes` rows (including the seeded default one) should have
`status` backfilled to `'linked'` since they're already running.
