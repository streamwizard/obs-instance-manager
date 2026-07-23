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
  // Consumer NVIDIA drivers cap concurrent NVENC sessions (8 as of the 500+
  // driver series) independent of VRAM headroom; Quadro/RTX-A cards have no
  // such cap. null means unlimited (pro-card nodes).
  max_encoder_sessions: number | null;
  // SHA-256 hash of this node's obs_command key. The obs-auto-switcher presents
  // the plaintext as a Bearer on the /obs route; we only ever hold the hash.
  // null when no command key has been provisioned yet.
  command_key_hash: string | null;
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
  vnc_password_ciphertext: string | null;
  vnc_password_iv: string | null;
  vnc_password_tag: string | null;
  storage_quota_mb: number;
  used_storage_bytes: number;
  // Names the plan-owned OBS template folder in S3 (obs-templates/<name>/) whose
  // profile (resolution/fps/encoder) is pulled fresh on every start. Null on rows
  // created before this column existed -- callers fall back to DEFAULT_TEMPLATE.
  config_template: string | null;
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
  // Plan-owned OBS template folder under obs-templates/. Optional: plans seeded
  // before this key exists fall back to DEFAULT_TEMPLATE.
  config_template?: string;
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
  // Active NVENC encode sessions. Distinguishes idle from streaming
  // instances: averageFps reads 0 with zero sessions, so alerting on encode
  // FPS is only meaningful while this is > 0.
  nvenc_sessions: number;
  gpu_temp_c: number;
  cpu_pct: number;
  ram_used_mb: number;
  ram_total_mb: number;
  rx_bytes_per_sec: number;
  tx_bytes_per_sec: number;
  /** Root filesystem usage; omitted when statfs fails. */
  disk_used_pct?: number;
  // gpu_util_pct above is time-occupancy: it DROPS when clocks boost under
  // encode load and excludes the NVENC ASIC entirely. These three are the
  // honest load signals; omitted when the board reports "[N/A]".
  /** NVENC ASIC busy %. */
  encoder_util_pct?: number;
  power_draw_w?: number;
  sm_clock_mhz?: number;
}

export interface ContainerMetrics {
  cpu_pct: number;
  ram_used_mb: number;
  ram_limit_mb: number;
  vram_used_mb: number;
  rx_bytes_per_sec: number;
  tx_bytes_per_sec: number;
}

export interface MetricsPayload {
  timestamp: string;
  host: HostMetrics;
  containers: Record<string, ContainerMetrics>;
}

export interface AppVariables {
  userId: string;
}

