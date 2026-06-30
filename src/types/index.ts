export type InstanceStatus = "creating" | "running" | "stopped" | "error";

export interface Node {
  id: string;
  name: string;
  max_instances: number;
  memory_mb: number;
  cpu_quota: number;
  vram_mb: number;
  total_vram_mb: number;
  shm_size: string;
  gpu_bus_id: string;
  created_at: string;
}

export interface Instance {
  id: string;
  user_id: string;
  node_id: string;
  container_id: string | null;
  container_name: string;
  resolution: string;
  status: InstanceStatus;
  vram_allocated_mb: number;
  memory_mb: number;
  cpu_quota: number;
  shm_size: string;
  subscription_id: string | null;
  obs_ws_password_ciphertext: string | null;
  obs_ws_password_iv: string | null;
  obs_ws_password_tag: string | null;
  created_at: string;
}

export interface CloudObsPlanLimits {
  resolution: string;
  fps: number;
  max_instances: number;
  memory_mb: number;
  cpu_quota: number;
  shm_size: string;
  vram_mb: number;
}

export interface CreateInstanceBody {
  subscription_id: string;
  template?: string;
  obs_ws_password?: string;
  obs_ws_password_ciphertext?: string;
  obs_ws_password_iv?: string;
  obs_ws_password_tag?: string;
}

export interface HostMetrics {
  gpu_name: string;
  vram_used_mb: number;
  vram_total_mb: number;
  gpu_util_pct: number;
  mem_controller_util_pct: number;
  nvenc_avg_fps: number;
  gpu_temp_c: number;
  cpu_pct: number;
  ram_used_mb: number;
  ram_total_mb: number;
}

export interface ContainerMetrics {
  cpu_pct: number;
  ram_used_mb: number;
  ram_limit_mb: number;
  vram_used_mb: number;
}

export interface MetricsPayload {
  timestamp: string;
  host: HostMetrics;
  containers: Record<string, ContainerMetrics>;
}

export interface AppVariables {
  userId: string;
}

