#!/usr/bin/env bash
#
#                   .++==++-.
#                  -*-    .-++.
#                .*+         :*=
#               +*:            #-
#             =*-              :%
#          .=*=                 *=
#       .-==:    .:-++.         .%
#   .-+#*=-.:-====--%            ++
#   .:-------:.     #:            %.
#                   #-            =*
#                  .#              #.
#                  +:              :+
#                 --                =.
#                .:                  :
#    ..:::..                             ...
# -==-::.                                 ..:---.
# *+:.                                        .:=+-
#  .-=====--::...                                .+%
#        ..::--===========-------------------=====-.
#                       ....:::::::::::.::....
#           --:::                     .::.=.
#           == .+:     .::-::-:      :+. :+
#            +   --:.:--:  .. :--:..-=  .+
#            .+    ::.           .::.  .+
#             -=                       +.
#              -=                     +.
#               :=                .  +.
#                .=*-             *-+.
#                  :+.            -=
#                   :*+.          =:
#                    :+.         =-
#                    .=       + =-
#                    -=      =-*-
#                     +     +. .
#                     .+.  :=
#                      .=- +.
#                        :-*
#
#  ___ _                   __      ___                _ 
# / __| |_ _ _ ___ __ _ _ _\ \    / (_)_____ _ _ _ __| |
# \__ \  _| '_/ -_) _` | '  \ \/\/ /| |_ / _` | '_/ _` |
# |___/\__|_| \___\__,_|_|_|_\_/\_/ |_/__\__,_|_| \__,_|
#
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
#   --ref=REF             Branch/tag to fetch config files from (default: main)
#   --repo-dir=DIR        Config directory holding docker-compose.yml/.env (default: /opt/obs-instance-manager)
#   --service-user=NAME   Dedicated service account to run containers as (default: obs)
#   --start               Bring the stack up at the end (default: pull only)
#   -h, --help            Show this help

set -euo pipefail

REST_API_URL=""
TOKEN=""
ALLOW_CIDR=""
API_PORT="3000"
# Node installs don't clone the repo -- they just need docker-compose.yml and
# .env.example, fetched straight from GitHub at the given ref. This keeps a
# fresh node from needing the whole source tree just to run a prebuilt image
# (see .github/workflows/build-images.yml).
RAW_BASE="https://raw.githubusercontent.com/streamwizard/obs-instance-manager"
REF="main"
REPO_DIR="/opt/obs-instance-manager"
SERVICE_USER="obs"
DO_START="false"

log()  { echo "[streamwizard] [install] $*"; }
warn() { echo "[streamwizard] [install] WARNING: $*" >&2; }
die()  { echo "[streamwizard] [install] ERROR: $*" >&2; exit 1; }

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
    --ref=*) REF="${arg#*=}" ;;
    --repo-dir=*) REPO_DIR="${arg#*=}" ;;
    --service-user=*) SERVICE_USER="${arg#*=}" ;;
    --start) DO_START="true" ;;
    -h|--help) sed -n '47,66p' "$0"; exit 0 ;;
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

mkdir -p /data/obs-plugins
chown -R "$SERVICE_USER:$SERVICE_USER" /data/obs-plugins

log "Fetching node config files (ref: $REF)..."
mkdir -p "$REPO_DIR"
# The compose file lives at the repo root with `env_file: .env`, so it needs no
# path rewriting -- a node's flat $REPO_DIR has the same shape.
curl_with_backoff -fsSL -o "$REPO_DIR/docker-compose.yml" "$RAW_BASE/$REF/docker-compose.yml" \
  || die "Failed to fetch docker-compose.yml from ref '$REF'. Check the --ref value and your network connection."

# So a later teardown doesn't need network access to fetch this again -- it's
# just sitting right next to the compose file and .env it operates on.
curl_with_backoff -fsSL -o "$REPO_DIR/uninstall.sh" "$RAW_BASE/$REF/scripts/uninstall.sh" \
  || warn "Failed to fetch uninstall.sh; to uninstall later, fetch it manually from $RAW_BASE/$REF/scripts/uninstall.sh"
chmod +x "$REPO_DIR/uninstall.sh" 2>/dev/null || true

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
  GPU_MODEL="$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n1)"
  # Total capacity of the root filesystem, where /data (obs-configs/plugins) lives.
  STORAGE_TOTAL_MB="$(df -BM --output=size / | tail -n1 | tr -dc '0-9')"

  # Built via argv (not string-interpolated into the python source) so a GPU
  # model name or token containing quotes can't break the JSON encoding.
  CLAIM_BODY="$(python3 -c "
import json, sys
token, gpu_bus_id, vram_total_mb, ram_total_mb, cpu_cores, gpu_model, storage_total_mb = sys.argv[1:8]
print(json.dumps({
    'token': token,
    'gpu_bus_id': gpu_bus_id,
    'vram_total_mb': int(vram_total_mb),
    'ram_total_mb': int(ram_total_mb),
    'cpu_cores': int(cpu_cores),
    'gpu_model': gpu_model,
    'storage_total_mb': int(storage_total_mb),
}))
" "$TOKEN" "$GPU_BUS_ID" "$VRAM_TOTAL_MB" "$RAM_TOTAL_MB" "$CPU_CORES" "$GPU_MODEL" "$STORAGE_TOTAL_MB")"

  CLAIM_RESPONSE="$(curl_with_backoff -fsSL -X POST "$REST_API_URL/api/nodes/claim" \
    -H "Content-Type: application/json" \
    -d "$CLAIM_BODY")" \
    || die "Node claim request to $REST_API_URL failed after retries. Check the URL/token and that rest-api's /api/nodes/claim endpoint exists (see docs/PANEL_INTEGRATION.md)."

  python3 - "$ENV_FILE" "$CLAIM_RESPONSE" "$GPU_BUS_ID" <<'PY'
import json, sys
env_path, raw, gpu_bus_id_computed = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.loads(raw)
with open(env_path, "w") as f:
    f.write(f"NODE_ID={data['node_id']}\n")
    f.write(f"NODE_API_KEY={data['node_api_key']}\n")
    f.write(f"REST_API_URL={data['rest_api_url']}\n")
    f.write(f"SUPABASE_URL={data['supabase_url']}\n")
    # Prefer whatever the panel echoes back (the value now stored in the
    # database), falling back to what we just computed and submitted above
    # in case the claim response doesn't happen to include it.
    f.write(f"GPU_BUSID={data.get('gpu_bus_id', gpu_bus_id_computed)}\n")
    f.write(f"S3_ENDPOINT={data['S3_ENDPOINT']}\n")
    f.write(f"S3_ACCESS_KEY={data['S3_ACCESS_KEY']}\n")
    f.write(f"S3_SECRET_KEY={data['S3_SECRET_KEY']}\n")
    f.write(f"S3_BUCKET={data['S3_BUCKET']}\n")
    f.write(f"S3_REGION={data['S3_REGION']}\n")
    f.write(f"TOKEN_ENCRYPTION_KEY={data['TOKEN_ENCRYPTION_KEY']}\n")
    f.write("PORT=3000\n")
    f.write("CADVISOR_URL=http://cadvisor:8080\n")
    f.write("OBS_NETWORK=obs-net\n")
    f.write("OBS_CONFIG_BASE=/data/obs-configs\n")
    f.write("OBS_TEMPLATES_PREFIX=obs-templates/\n")
    f.write("OBS_DEFAULT_TEMPLATE=default\n")
    f.write("OBS_WEBSOCKET_PORT=4455\n")
    f.write("PLUGINS_PATH=/data/obs-plugins\n")
    f.write("PANEL_ORIGIN=*\n")
    f.write("DEBUG=\n")
    # rest-api only includes these when it has InfluxDB configured for this
    # environment, so fall back to blank rather than KeyError-ing a node that
    # was claimed before Influx was wired up. src/clients/influx.ts needs all
    # four non-empty and disables metrics otherwise, so blanks are the correct
    # "no metrics sink" signal.
    f.write(f"INFLUXDB_URL={data.get('INFLUXDB_URL') or ''}\n")
    f.write(f"INFLUXDB_TOKEN={data.get('INFLUXDB_TOKEN') or ''}\n")
    f.write(f"INFLUXDB_ORG={data.get('INFLUXDB_ORG') or ''}\n")
    f.write(f"INFLUXDB_BUCKET={data.get('INFLUXDB_BUCKET') or ''}\n")
    # Blank by default -- docker-compose.yml falls back to :latest. Set this to
    # pin the node to a specific build (e.g. sha-abc1234) without editing
    # docker-compose.yml.
    f.write("OBS_IMAGE_TAG=\n")
PY
  log "Linked. Node ID written to $ENV_FILE."

  # The panel computed this hostname from the node's admin-chosen name and
  # already persisted it on the obs_nodes row, so applying it here is what
  # makes a freshly imaged, generically-named VM self-identify correctly with
  # zero manual admin steps -- no separate rename step, no drift between what
  # the panel shows and what the machine is actually called.
  NODE_HOSTNAME="$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('hostname',''))" "$CLAIM_RESPONSE")"
  if [ -n "$NODE_HOSTNAME" ]; then
    log "Setting hostname to $NODE_HOSTNAME..."
    hostnamectl set-hostname "$NODE_HOSTNAME"
    if grep -q '^127\.0\.1\.1[[:space:]]' /etc/hosts; then
      sed -i "s/^127\.0\.1\.1[[:space:]].*/127.0.1.1\t$NODE_HOSTNAME/" /etc/hosts
    else
      echo -e "127.0.1.1\t$NODE_HOSTNAME" >> /etc/hosts
    fi
  else
    warn "Claim response did not include a hostname; leaving the host's hostname unchanged."
  fi
else
  if [ ! -f "$ENV_FILE" ]; then
    curl_with_backoff -fsSL -o "$ENV_FILE" "$RAW_BASE/$REF/.env.example" \
      || die "Failed to fetch .env.example from ref '$REF'. Check the --ref value and your network connection."
    warn "No --rest-api-url/--token given. Scaffolded $ENV_FILE from .env.example — fill in NODE_ID, NODE_API_KEY, REST_API_URL, SUPABASE_URL by hand before starting."
  else
    log "$ENV_FILE already exists, leaving it as-is."
  fi
fi
chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

log "Pre-pulling the OBS container image (multi-GB, can take a while)..."
sudo -u "$SERVICE_USER" docker pull ghcr.io/streamwizard/obs-cloud-container:latest \
  || warn "Pre-pull of the OBS image failed; it will be pulled on first instance creation instead."

log "Pulling the obs-instance-manager image as $SERVICE_USER..."
sudo -u "$SERVICE_USER" bash -c "cd '$REPO_DIR' && docker compose pull"

ENV_COMPLETE="true"
for key in NODE_ID NODE_API_KEY REST_API_URL SUPABASE_URL GPU_BUSID S3_ENDPOINT S3_ACCESS_KEY S3_SECRET_KEY S3_BUCKET S3_REGION TOKEN_ENCRYPTION_KEY; do
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
  log "Images pulled. Not starting (pass --start to bring the stack up automatically)."
  log "To start manually: sudo -u $SERVICE_USER bash -c 'cd $REPO_DIR && docker compose up -d'"
fi

log "Done."
