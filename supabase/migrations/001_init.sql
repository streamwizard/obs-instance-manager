-- nodes: Docker host configuration
create table if not exists nodes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  max_instances integer not null,
  vnc_port_start integer not null,
  vnc_port_end integer not null,
  novnc_port_start integer not null,
  novnc_port_end integer not null,
  obs_ws_port_start integer not null,
  obs_ws_port_end integer not null,
  memory_mb integer not null,
  cpu_quota numeric not null,
  vram_mb integer not null,
  total_vram_mb integer not null,
  shm_size text not null,
  gpu_bus_id text not null,
  created_at timestamptz not null default now()
);

-- instances: every container created, linked to a user
create table if not exists instances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  node_id uuid not null references nodes (id) on delete cascade,
  container_id text,
  container_name text not null,
  vnc_port integer not null,
  novnc_port integer not null,
  obs_ws_port integer not null,
  resolution text not null,
  status text not null default 'creating' check (status in ('creating', 'running', 'stopped', 'error')),
  vram_allocated_mb integer not null,
  created_at timestamptz not null default now()
);

create index if not exists instances_user_id_idx on instances (user_id);
create index if not exists instances_node_id_idx on instances (node_id);

-- RLS: users may only read/delete their own instances.
-- All inserts/updates are performed by the backend with the service role key, which bypasses RLS.
alter table instances enable row level security;

create policy "Users can view their own instances"
  on instances for select
  using (auth.uid() = user_id);

create policy "Users can delete their own instances"
  on instances for delete
  using (auth.uid() = user_id);

-- Seed default node.
-- NOTE: update gpu_bus_id to match the actual production host's GPU PCI bus ID
-- (run `nvidia-smi --query-gpu=pci.bus_id --format=csv,noheader` on that host).
insert into nodes (
  name,
  max_instances,
  vnc_port_start,
  vnc_port_end,
  novnc_port_start,
  novnc_port_end,
  obs_ws_port_start,
  obs_ws_port_end,
  memory_mb,
  cpu_quota,
  vram_mb,
  total_vram_mb,
  shm_size,
  gpu_bus_id
) values (
  'default-node',
  10,
  5900,
  5909,
  6080,
  6089,
  4455,
  4464,
  4096,
  1,
  2048,
  8192,
  '2g',
  '00000000:01:00.0'
);
