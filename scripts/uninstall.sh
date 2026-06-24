#!/usr/bin/env bash
#
# obs-instance-manager node uninstaller. Reverses what scripts/install.sh
# did, using the same defaults (service user, repo dir, network name) so it
# undoes exactly what was set up.
#
# By default this only removes things install.sh itself created: the OBS
# containers/images/network, /data/obs-configs, the repo checkout, and the
# `obs` service account. It deliberately leaves Docker, the NVIDIA Container
# Toolkit, ufw, and the host's nvidia driver installed, since other things
# on the box may depend on them. Pass the --purge-* / --disable-ufw flags
# below to also tear those down (e.g. to reset a test VM to a clean slate).
#
# This never touches the NVIDIA driver itself, SSH, or anything outside the
# paths/packages install.sh is responsible for.
#
# Usage:
#   sudo bash uninstall.sh [options]
#
# Options:
#   --repo-dir=DIR           Install directory to remove (default: /opt/obs-instance-manager)
#   --service-user=NAME      Service account to remove (default: obs)
#   --api-port=PORT          Port the ufw rule was opened for (default: 3000)
#   --keep-user              Don't delete the service account/home directory
#   --keep-data              Don't delete /data/obs-configs (per-instance OBS configs)
#   --remove-ufw-rule        Remove the ufw allow rule for --api-port (leaves the SSH rule alone)
#   --disable-ufw            Reset ALL ufw rules and disable it (not just the OBS ones — use with care)
#   --purge-docker           Uninstall Docker engine + containerd entirely (affects the whole host)
#   --purge-nvidia-toolkit   Uninstall nvidia-container-toolkit and strip the nvidia runtime from daemon.json
#   --all                    Shorthand for --remove-ufw-rule --purge-docker --purge-nvidia-toolkit --disable-ufw
#   --yes                    Skip the confirmation prompt
#   -h, --help                Show this help

set -euo pipefail

REPO_DIR="/opt/obs-instance-manager"
SERVICE_USER="obs"
API_PORT="3000"
NETWORK_NAME="obs-net"
KEEP_USER="false"
KEEP_DATA="false"
REMOVE_UFW_RULE="false"
DISABLE_UFW="false"
PURGE_DOCKER="false"
PURGE_NVIDIA_TOOLKIT="false"
SKIP_CONFIRM="false"

log()  { echo "[uninstall] $*"; }
warn() { echo "[uninstall] WARNING: $*" >&2; }
die()  { echo "[uninstall] ERROR: $*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --repo-dir=*) REPO_DIR="${arg#*=}" ;;
    --service-user=*) SERVICE_USER="${arg#*=}" ;;
    --api-port=*) API_PORT="${arg#*=}" ;;
    --keep-user) KEEP_USER="true" ;;
    --keep-data) KEEP_DATA="true" ;;
    --remove-ufw-rule) REMOVE_UFW_RULE="true" ;;
    --disable-ufw) DISABLE_UFW="true" ;;
    --purge-docker) PURGE_DOCKER="true" ;;
    --purge-nvidia-toolkit) PURGE_NVIDIA_TOOLKIT="true" ;;
    --all) REMOVE_UFW_RULE="true"; DISABLE_UFW="true"; PURGE_DOCKER="true"; PURGE_NVIDIA_TOOLKIT="true" ;;
    --yes) SKIP_CONFIRM="true" ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) die "Unknown option: $arg" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Must run as root (sudo bash uninstall.sh ...)"

log "This will remove:"
log "  - the obs-instance-manager docker compose stack, its containers/images, and the '$NETWORK_NAME' network"
[ "$KEEP_DATA" = "true" ] || log "  - /data/obs-configs (per-instance OBS configs/settings)"
log "  - $REPO_DIR"
[ "$KEEP_USER" = "true" ] || log "  - the '$SERVICE_USER' service account and its home directory"
[ "$REMOVE_UFW_RULE" = "true" ] && log "  - the ufw allow rule for port $API_PORT"
[ "$DISABLE_UFW" = "true" ] && log "  - ALL ufw rules (full reset + disable, not just the ones above)"
[ "$PURGE_DOCKER" = "true" ] && log "  - Docker engine + containerd entirely (affects anything else on this host using Docker)"
[ "$PURGE_NVIDIA_TOOLKIT" = "true" ] && log "  - nvidia-container-toolkit and the nvidia runtime entry in daemon.json"
log "This will NOT touch: the NVIDIA driver, SSH, or anything outside the above."

if [ "$SKIP_CONFIRM" != "true" ]; then
  read -r -p "[uninstall] Continue? [y/N] " REPLY
  case "$REPLY" in
    y|Y|yes|YES) ;;
    *) log "Aborted."; exit 0 ;;
  esac
fi

if command -v docker >/dev/null; then
  if [ -f "$REPO_DIR/docker-compose.yml" ]; then
    log "Stopping the compose stack..."
    sudo -u "$SERVICE_USER" bash -c "cd '$REPO_DIR' && docker compose down -v" 2>/dev/null || warn "Could not bring the stack down cleanly (may already be stopped)."
  fi

  log "Removing obs-instance-manager / obs-cloud-container images and any leftover containers..."
  for img in $(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -iE 'obs-instance-manager|obs-cloud-container|obs-kiosk' || true); do
    docker rmi -f "$img" >/dev/null 2>&1 || true
  done

  log "Removing the '$NETWORK_NAME' network..."
  docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
else
  warn "Docker not found; skipping container/image/network cleanup."
fi

if [ "$KEEP_DATA" != "true" ]; then
  log "Removing /data/obs-configs..."
  rm -rf /data/obs-configs
fi

log "Removing $REPO_DIR..."
rm -rf "$REPO_DIR"

if [ "$KEEP_USER" != "true" ]; then
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    log "Removing service account '$SERVICE_USER'..."
    userdel -r "$SERVICE_USER" 2>/dev/null || warn "Could not fully remove '$SERVICE_USER' (processes may still be running as it)."
  fi
fi

if command -v ufw >/dev/null; then
  if [ "$REMOVE_UFW_RULE" = "true" ]; then
    log "Removing the ufw rule for port $API_PORT..."
    while true; do
      RULE_NUM="$(ufw status numbered | grep -E "^\[[0-9]+\].*[[:space:]]${API_PORT}/tcp" | head -n1 | sed -E 's/^\[([0-9]+)\].*/\1/' || true)"
      [ -n "$RULE_NUM" ] || break
      yes | ufw delete "$RULE_NUM" >/dev/null
    done
  fi
  if [ "$DISABLE_UFW" = "true" ]; then
    warn "Resetting ufw entirely (this removes ALL rules, including the SSH one, and disables the firewall)."
    ufw --force reset >/dev/null
    ufw disable >/dev/null
  fi
fi

if [ "$PURGE_NVIDIA_TOOLKIT" = "true" ]; then
  log "Purging nvidia-container-toolkit..."
  apt-get purge -y nvidia-container-toolkit nvidia-container-toolkit-base libnvidia-container-tools libnvidia-container1 >/dev/null 2>&1 || true
  rm -f /etc/apt/sources.list.d/nvidia-container-toolkit.list /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

  DAEMON_JSON=/etc/docker/daemon.json
  if [ -f "$DAEMON_JSON" ]; then
    python3 - "$DAEMON_JSON" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    data = json.load(f)
if "nvidia" in data.get("runtimes", {}):
    del data["runtimes"]["nvidia"]
    if not data["runtimes"]:
        del data["runtimes"]
with open(path, "w") as f:
    json.dump(data, f, indent=4)
PY
    if command -v docker >/dev/null && systemctl is-active --quiet docker; then
      systemctl restart docker
    fi
  fi
fi

if [ "$PURGE_DOCKER" = "true" ]; then
  log "Purging Docker engine + containerd..."
  apt-get purge -y docker-ce docker-ce-cli docker-ce-rootless-extras docker-buildx-plugin docker-compose-plugin docker-model-plugin containerd.io >/dev/null 2>&1 || true
  rm -rf /var/lib/docker /var/lib/containerd /etc/docker
  rm -f /etc/apt/sources.list.d/docker.list /usr/share/keyrings/docker.gpg /etc/apt/keyrings/docker.asc /etc/apt/keyrings/docker.gpg
fi

log "Done."
