#!/usr/bin/env bash
#
# obs-instance-manager node installer (Wings-style).
#
# Provisions an Ubuntu host to run obs-instance-manager + cAdvisor as a
# dedicated `obs` service account, then either links the node to a panel
# (if --rest-api-url/--token are given) or scaffolds a local .env for manual
# setup. See docs/PANEL_INTEGRATION.md for the linking contract.
#
# Usage:
#   sudo bash install.sh [options]
#
# Options:
#   --rest-api-url=URL    Panel's rest-api base URL, e.g. https://api.example.com
#   --token=TOKEN         One-time node claim token issued by the panel
#   --allow-cidr=CIDR     Source CIDR allowed through the firewall (default: auto-detected LAN /24)
#   --api-port=PORT       Host port for the API (default: 3000)
#   --repo-url=URL        Git URL to clone (default: streamwizard/obs-instance-manager on GitHub)
#   --repo-dir=DIR        Install directory (default: /opt/obs-instance-manager)
#   --service-user=NAME   Dedicated service account to run containers as (default: obs)
#   --start               Bring the stack up at the end (default: build only)
#   -h, --help            Show this help

set -euo pipefail

REST_API_URL=""
TOKEN=""
ALLOW_CIDR=""
API_PORT="3000"
REPO_URL="https://github.com/streamwizard/obs-instance-manager.git"
REPO_DIR="/opt/obs-instance-manager"
SERVICE_USER="obs"
DO_START="false"

log()  { echo "[install] $*"; }
warn() { echo "[install] WARNING: $*" >&2; }
die()  { echo "[install] ERROR: $*" >&2; exit 1; }

# Retries a curl call with exponential backoff (1s, 2s, 4s, ... up to 10 tries),
# the same resilience Wings applies to its own outbound panel calls so a
# transient network blip during linking doesn't fail the whole install.
curl_with_backoff() {
  local attempt=1 max_attempts=10 delay=1
  while true; do
    if curl "$@"; then return 0; fi
    if [ "$attempt" -ge "$max_attempts" ]; then return 1; fi
    warn "Request failed (attempt $attempt/$max_attempts), retrying in ${delay}s..."
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

for arg in "$@"; do
  case "$arg" in
    --rest-api-url=*) REST_API_URL="${arg#*=}" ;;
    --token=*) TOKEN="${arg#*=}" ;;
    --allow-cidr=*) ALLOW_CIDR="${arg#*=}" ;;
    --api-port=*) API_PORT="${arg#*=}" ;;
    --repo-url=*) REPO_URL="${arg#*=}" ;;
    --repo-dir=*) REPO_DIR="${arg#*=}" ;;
    --service-user=*) SERVICE_USER="${arg#*=}" ;;
    --start) DO_START="true" ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "Unknown option: $arg" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Must run as root (sudo bash install.sh ...)"

log "Checking GPU and NVIDIA stack..."
command -v lspci >/dev/null || apt-get install -y --no-install-recommends pciutils >/dev/null
lspci | grep -qi nvidia || die "No NVIDIA GPU detected via lspci. This installer requires GPU passthrough already configured at the hypervisor level."
command -v nvidia-smi >/dev/null || die "nvidia-smi not found. Install the NVIDIA driver on the host first (this installer will not install kernel drivers for you), then re-run."
nvidia-smi >/dev/null || die "nvidia-smi found but failed to run. Check the driver install before continuing."

if ! dpkg -l nvidia-container-toolkit >/dev/null 2>&1; then
  log "Installing nvidia-container-toolkit..."
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update -qq
  apt-get install -y nvidia-container-toolkit
else
  log "nvidia-container-toolkit already installed."
fi

log "Checking Docker..."
if ! command -v docker >/dev/null; then
  log "Installing Docker via get.docker.com..."
  curl -fsSL https://get.docker.com | sh
else
  log "Docker already installed ($(docker --version))."
fi
systemctl enable --now docker >/dev/null

log "Registering the nvidia runtime with the Docker daemon..."
DAEMON_JSON=/etc/docker/daemon.json
NEEDS_RESTART="false"
if [ ! -f "$DAEMON_JSON" ]; then
  echo '{}' > "$DAEMON_JSON"
fi
if ! python3 -c "import json,sys; d=json.load(open('$DAEMON_JSON')); sys.exit(0 if d.get('runtimes',{}).get('nvidia') else 1)" 2>/dev/null; then
  python3 - "$DAEMON_JSON" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    data = json.load(f)
data.setdefault("runtimes", {})["nvidia"] = {"path": "nvidia-container-runtime", "args": []}
with open(path, "w") as f:
    json.dump(data, f, indent=4)
PY
  NEEDS_RESTART="true"
fi
if [ "$NEEDS_RESTART" = "true" ]; then
  systemctl restart docker
  log "Docker restarted to pick up the nvidia runtime."
else
  log "nvidia runtime already registered."
fi

if [ -z "$ALLOW_CIDR" ]; then
  ALLOW_CIDR="$(ip -o -4 addr show scope global | head -n1 | awk '{print $4}' | sed -E 's#\.[0-9]+/[0-9]+$#.0/24#')"
  [ -n "$ALLOW_CIDR" ] || die "Could not auto-detect a LAN CIDR; pass --allow-cidr explicitly."
  log "Auto-detected LAN CIDR: $ALLOW_CIDR (override with --allow-cidr)"
fi

log "Configuring ufw (SSH + API port $API_PORT from $ALLOW_CIDR only)..."
command -v ufw >/dev/null || apt-get install -y --no-install-recommends ufw >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow from "$ALLOW_CIDR" to any port 22 proto tcp comment "SSH" >/dev/null
ufw allow from "$ALLOW_CIDR" to any port "$API_PORT" proto tcp comment "obs-instance-manager API" >/dev/null
ufw --force enable >/dev/null
ufw status verbose

log "Creating service account '$SERVICE_USER'..."
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd -m -d "/home/$SERVICE_USER" -s /usr/sbin/nologin -c "Service account for OBS containers" "$SERVICE_USER"
fi
usermod -aG docker "$SERVICE_USER"

mkdir -p /data/obs-configs
chown -R "$SERVICE_USER:$SERVICE_USER" /data/obs-configs

log "Fetching obs-instance-manager into $REPO_DIR..."
if [ -d "$REPO_DIR/.git" ]; then
  warn "$REPO_DIR already exists; leaving it as-is. Update it yourself (git pull) if you want the latest source."
else
  git clone "$REPO_URL" "$REPO_DIR"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$REPO_DIR"

ENV_FILE="$REPO_DIR/.env"
if [ -n "$REST_API_URL" ] && [ -n "$TOKEN" ]; then
  log "Linking to panel via rest-api at $REST_API_URL..."
  # nvidia-smi reports domain:bus:device.function in hex (e.g. 00000000:00:10.0).
  # Xorg's BusID option needs "PCI:bus:device:function" in decimal, so convert here
  # once at registration time rather than in every consumer of gpu_bus_id.
  GPU_BUS_ID_RAW="$(nvidia-smi --query-gpu=pci.bus_id --format=csv,noheader | head -n1)"
  GPU_BUS_ID="$(python3 -c "
addr = '$GPU_BUS_ID_RAW'.split(':')
bus, dev_func = addr[-2], addr[-1]
dev, func = dev_func.split('.')
print(f'PCI:{int(bus, 16)}:{int(dev, 16)}:{int(func, 16)}')
")"
  VRAM_TOTAL_MB="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -n1)"
  RAM_TOTAL_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
  CPU_CORES="$(nproc)"

  CLAIM_RESPONSE="$(curl_with_backoff -fsSL -X POST "$REST_API_URL/api/nodes/claim" \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"$TOKEN\",\"gpu_bus_id\":\"$GPU_BUS_ID\",\"vram_total_mb\":$VRAM_TOTAL_MB,\"ram_total_mb\":$RAM_TOTAL_MB,\"cpu_cores\":$CPU_CORES}")" \
    || die "Node claim request to $REST_API_URL failed after retries. Check the URL/token and that rest-api's /api/nodes/claim endpoint exists (see docs/PANEL_INTEGRATION.md)."

  python3 - "$ENV_FILE" "$CLAIM_RESPONSE" <<'PY'
import json, sys
env_path, raw = sys.argv[1], sys.argv[2]
data = json.loads(raw)
with open(env_path, "w") as f:
    f.write(f"NODE_ID={data['node_id']}\n")
    f.write(f"SUPABASE_URL={data['supabase_url']}\n")
    f.write(f"SUPABASE_SERVICE_ROLE_KEY={data['supabase_service_role_key']}\n")
    f.write(f"SUPABASE_JWT_SECRET={data['supabase_jwt_secret']}\n")
    f.write("PORT=3000\n")
    f.write("CADVISOR_URL=http://cadvisor:8080\n")
PY
  log "Linked. Node ID written to $ENV_FILE."
else
  if [ ! -f "$ENV_FILE" ]; then
    cp "$REPO_DIR/.env.example" "$ENV_FILE"
    warn "No --rest-api-url/--token given. Scaffolded $ENV_FILE from .env.example — fill in NODE_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET by hand before starting."
  else
    log "$ENV_FILE already exists, leaving it as-is."
  fi
fi
chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

log "Pre-pulling the OBS container image (multi-GB, can take a while)..."
sudo -u "$SERVICE_USER" docker pull ghcr.io/streamwizard/obs-cloud-container:latest \
  || warn "Pre-pull of the OBS image failed; it will be pulled on first instance creation instead."

log "Building images as $SERVICE_USER..."
sudo -u "$SERVICE_USER" bash -c "cd '$REPO_DIR' && docker compose build"

ENV_COMPLETE="true"
for key in NODE_ID SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SUPABASE_JWT_SECRET; do
  grep -q "^${key}=.\+" "$ENV_FILE" || ENV_COMPLETE="false"
done

if [ "$DO_START" = "true" ]; then
  if [ "$ENV_COMPLETE" = "true" ]; then
    log "Starting the stack..."
    sudo -u "$SERVICE_USER" bash -c "cd '$REPO_DIR' && docker compose up -d"
  else
    warn "--start was given but $ENV_FILE is missing required values; not starting. Fill it in and run: sudo -u $SERVICE_USER bash -c 'cd $REPO_DIR && docker compose up -d'"
  fi
else
  log "Build complete. Not starting (pass --start to bring the stack up automatically)."
  log "To start manually: sudo -u $SERVICE_USER bash -c 'cd $REPO_DIR && docker compose up -d'"
fi

log "Done."
