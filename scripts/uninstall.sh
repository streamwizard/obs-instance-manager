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
# obs-instance-manager node uninstaller. Reverses what scripts/install.sh
# did, using the same defaults (service user, config dir, network name) so it
# undoes exactly what was set up.
#
# By default this only removes things install.sh itself created: the OBS
# containers/images/network, /data/obs-configs and /data/obs-plugins, the
# config directory (docker-compose.yml/.env), and the `obs` service account.
# It deliberately leaves Docker, the NVIDIA Container Toolkit, ufw, Tailscale
# and the host's nvidia driver installed, since other things on the box may
# depend on them. Pass the --purge-* / --disable-ufw flags below to also tear
# those down (e.g. to reset a test VM to a clean slate).
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
#   --keep-user              Don't delete the service account/home directory
#   --keep-data              Don't delete /data/obs-configs and /data/obs-plugins
#   --remove-ufw-rule        Remove the tailscale0:3000/tcp ufw rule (leaves the SSH rule alone)
#   --disable-ufw            Reset ALL ufw rules and disable it (not just the OBS ones -- use with care)
#   --purge-docker           Uninstall Docker engine + containerd entirely (affects the whole host)
#   --purge-nvidia-toolkit   Uninstall nvidia-container-toolkit and strip the nvidia runtime from daemon.json
#   --purge-tailscale        Bring Tailscale down and uninstall it entirely
#   --purge-nvidia-driver    Uninstall the NVIDIA driver packages (nvidia-driver-*, libnvidia-*, the
#                            Ubuntu prebuilt modules, ubuntu-drivers-common) so the next install.sh
#                            run exercises the driver install + reboot path again. Needs a reboot
#                            afterwards. Not part of --all.
#   --remove-dns             Remove the Cloudflare DNS drop-in install.sh wrote for systemd-resolved
#   --remove-static-ip       Remove the netplan file install.sh wrote for --static-ip and go back to
#                            the OS default (usually DHCP). Never part of --all: the address may
#                            change and drop your SSH session.
#   --all                    Shorthand for --remove-ufw-rule --purge-docker --purge-nvidia-toolkit
#                            --purge-tailscale --disable-ufw --remove-dns
#   --yes                    Skip the confirmation prompt
#   -h, --help               Show this help

set -euo pipefail

REPO_DIR="/opt/obs-instance-manager"
SERVICE_USER="obs"
API_PORT="3000"
NETWORK_NAME="obs-net"
DOCKER_DROPIN="/etc/systemd/system/docker.service.d/10-after-tailscale.conf"
DNS_DROPIN="/etc/systemd/resolved.conf.d/99-streamwizard-dns.conf"
NETPLAN_FILE="/etc/netplan/99-streamwizard-static.yaml"
CLOUD_INIT_NET_OFF="/etc/cloud/cloud.cfg.d/99-streamwizard-disable-network-config.cfg"
KEEP_USER="false"
KEEP_DATA="false"
REMOVE_UFW_RULE="false"
DISABLE_UFW="false"
PURGE_DOCKER="false"
PURGE_NVIDIA_TOOLKIT="false"
PURGE_TAILSCALE="false"
PURGE_NVIDIA_DRIVER="false"
REMOVE_DNS="false"
REMOVE_STATIC_IP="false"
SKIP_CONFIRM="false"

log()  { echo "[streamwizard] [uninstall] $*"; }
warn() { echo "[streamwizard] [uninstall] WARNING: $*" >&2; }
die()  { echo "[streamwizard] [uninstall] ERROR: $*" >&2; exit 1; }

# Prints the header comment block (everything between the banner and
# `set -euo pipefail`) so the help text can't drift from a hard-coded range.
print_help() {
  sed -n '/^# obs-instance-manager node uninstaller/,/^set -euo pipefail/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --repo-dir=*) REPO_DIR="${arg#*=}" ;;
    --service-user=*) SERVICE_USER="${arg#*=}" ;;
    --keep-user) KEEP_USER="true" ;;
    --keep-data) KEEP_DATA="true" ;;
    --remove-ufw-rule) REMOVE_UFW_RULE="true" ;;
    --disable-ufw) DISABLE_UFW="true" ;;
    --purge-docker) PURGE_DOCKER="true" ;;
    --purge-nvidia-toolkit) PURGE_NVIDIA_TOOLKIT="true" ;;
    --purge-tailscale) PURGE_TAILSCALE="true" ;;
    --purge-nvidia-driver) PURGE_NVIDIA_DRIVER="true" ;;
    --remove-dns) REMOVE_DNS="true" ;;
    --remove-static-ip) REMOVE_STATIC_IP="true" ;;
    --all) REMOVE_UFW_RULE="true"; DISABLE_UFW="true"; PURGE_DOCKER="true"; PURGE_NVIDIA_TOOLKIT="true"; PURGE_TAILSCALE="true"; REMOVE_DNS="true" ;;
    --yes) SKIP_CONFIRM="true" ;;
    -h|--help) print_help; exit 0 ;;
    *) die "Unknown option: $arg" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Must run as root (sudo bash uninstall.sh ...)"

log "This will remove:"
log "  - the obs-instance-manager docker compose stack, its containers/images, and the '$NETWORK_NAME' network"
[ "$KEEP_DATA" = "true" ] || log "  - /data/obs-configs (per-instance OBS configs/settings) and /data/obs-plugins"
log "  - $REPO_DIR (docker-compose.yml, .env, and this uninstaller)"
log "  - the docker.service drop-in that orders Docker after tailscaled ($DOCKER_DROPIN)"
[ "$KEEP_USER" = "true" ] || log "  - the '$SERVICE_USER' service account and its home directory"
[ "$REMOVE_UFW_RULE" = "true" ] && log "  - the ufw allow rule for tailscale0:$API_PORT/tcp"
[ "$DISABLE_UFW" = "true" ] && log "  - ALL ufw rules (full reset + disable, not just the ones above)"
[ "$PURGE_DOCKER" = "true" ] && log "  - Docker engine + containerd entirely (affects anything else on this host using Docker)"
[ "$PURGE_NVIDIA_TOOLKIT" = "true" ] && log "  - nvidia-container-toolkit and the nvidia runtime entry in daemon.json"
[ "$PURGE_TAILSCALE" = "true" ] && log "  - Tailscale entirely (tailscale down + package removal)"
[ "$PURGE_NVIDIA_DRIVER" = "true" ] && log "  - the NVIDIA driver packages (reboot needed afterwards; nvidia-smi will be gone)"
[ "$REMOVE_DNS" = "true" ] && log "  - the Cloudflare DNS drop-in at $DNS_DROPIN (systemd-resolved goes back to the OS default)"
[ "$REMOVE_STATIC_IP" = "true" ] && log "  - the static-IP netplan file $NETPLAN_FILE (back to the OS default network config; your SSH session may drop)"
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
    # TAILSCALE_IP=0.0.0.0 only satisfies the compose file's `:?` guard so
    # `down` can parse it on a node that never joined Tailscale; nothing is
    # bound during a teardown.
    sudo -u "$SERVICE_USER" bash -c "cd '$REPO_DIR' && TAILSCALE_IP=0.0.0.0 docker compose down -v" 2>/dev/null || warn "Could not bring the stack down cleanly (may already be stopped)."
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
  log "Removing /data/obs-configs and /data/obs-plugins..."
  rm -rf /data/obs-configs /data/obs-plugins
fi

log "Removing $REPO_DIR..."
rm -rf "$REPO_DIR"

# Leftover from an install that rebooted for the NVIDIA driver and never
# came back (the resumed run normally removes this itself).
if [ -f /etc/systemd/system/streamwizard-install-resume.service ]; then
  log "Removing the stale install-resume unit..."
  systemctl disable streamwizard-install-resume.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/streamwizard-install-resume.service
  systemctl daemon-reload 2>/dev/null || true
fi

if [ -f "$DOCKER_DROPIN" ]; then
  log "Removing the docker.service ordering drop-in..."
  rm -f "$DOCKER_DROPIN"
  rmdir /etc/systemd/system/docker.service.d 2>/dev/null || true
  systemctl daemon-reload 2>/dev/null || true
fi

if [ "$KEEP_USER" != "true" ]; then
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    log "Removing service account '$SERVICE_USER'..."
    userdel -r "$SERVICE_USER" 2>/dev/null || warn "Could not fully remove '$SERVICE_USER' (processes may still be running as it)."
  fi
fi

if command -v ufw >/dev/null; then
  if [ "$REMOVE_UFW_RULE" = "true" ]; then
    log "Removing the ufw rule for tailscale0:$API_PORT/tcp..."
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

if [ "$PURGE_NVIDIA_DRIVER" = "true" ]; then
  log "Purging the NVIDIA driver packages..."
  # apt treats an argument with regex characters as a pattern. Covers the
  # DKMS driver (nvidia-driver-*, libnvidia-*), Ubuntu's prebuilt signed
  # modules (linux-modules-nvidia-*, linux-objects-nvidia-*,
  # linux-signatures-nvidia-*) and the helper that picked them.
  apt-get purge -y '^nvidia-driver-.*' '^nvidia-.*-[0-9]+.*' '^libnvidia-.*' '^linux-modules-nvidia-.*' '^linux-objects-nvidia-.*' '^linux-signatures-nvidia-.*' '^xserver-xorg-video-nvidia-.*' ubuntu-drivers-common >/dev/null 2>&1 || true
  apt-get autoremove -y --purge >/dev/null 2>&1 || true
  rm -f /etc/modprobe.d/nvidia*.conf
  update-initramfs -u >/dev/null 2>&1 || true
  warn "NVIDIA driver removed. Reboot before re-running install.sh so the kernel module is actually gone."
fi

if [ "$PURGE_TAILSCALE" = "true" ]; then
  log "Purging Tailscale..."
  command -v tailscale >/dev/null && tailscale down >/dev/null 2>&1 || true
  apt-get purge -y tailscale >/dev/null 2>&1 || true
  rm -rf /var/lib/tailscale
  rm -f /etc/apt/sources.list.d/tailscale.list /usr/share/keyrings/tailscale-archive-keyring.gpg
fi

if [ "$PURGE_DOCKER" = "true" ]; then
  log "Purging Docker engine + containerd..."
  apt-get purge -y docker-ce docker-ce-cli docker-ce-rootless-extras docker-buildx-plugin docker-compose-plugin docker-model-plugin containerd.io >/dev/null 2>&1 || true
  rm -rf /var/lib/docker /var/lib/containerd /etc/docker
  rm -f /etc/apt/sources.list.d/docker.list /usr/share/keyrings/docker.gpg /etc/apt/keyrings/docker.asc /etc/apt/keyrings/docker.gpg
fi

if [ "$REMOVE_DNS" = "true" ]; then
  if [ -f "$DNS_DROPIN" ]; then
    log "Removing the Cloudflare DNS drop-in..."
    rm -f "$DNS_DROPIN"
    systemctl restart systemd-resolved 2>/dev/null || warn "Couldn't restart systemd-resolved; the old resolver config stays in effect until the next reboot."
  else
    log "No DNS drop-in at $DNS_DROPIN; nothing to remove."
  fi
fi

log "Done."

# Last on purpose: if the address changes, the SSH session (and this script)
# ends here.
if [ "$REMOVE_STATIC_IP" = "true" ]; then
  if [ -f "$NETPLAN_FILE" ]; then
    warn "Removing $NETPLAN_FILE and re-applying netplan. If the address changes, this SSH session drops."
    rm -f "$NETPLAN_FILE" "$CLOUD_INIT_NET_OFF"
    netplan apply 2>/dev/null || warn "netplan apply failed; the old address stays until reboot."
  else
    log "No static-IP netplan file at $NETPLAN_FILE; nothing to remove."
  fi
fi
