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
# obs-instance-manager node installer (Wings-style, mirroring ingest-server's
# scripts/install.sh).
#
# Provisions an Ubuntu host to run obs-instance-manager + cAdvisor as a
# dedicated `obs` service account, joins it to Tailscale, and then either
# links the node to a panel (if --rest-api-url/--token are given) or
# scaffolds a local .env for manual setup. See docs/PANEL_INTEGRATION.md for
# the linking contract.
#
# Tailscale is what lets the OBS containers pull SRT from an ingest node's
# tailnet-only output port. The node's API (port 3000) is bound to loopback
# (for a Cloudflare Tunnel running on the box, which is how browsers and the
# panel apps reach it) and to its Tailscale address (for tailnet hosts such
# as the alert worker) -- never the LAN or a public interface.
#
# Usage:
#   sudo bash install.sh [options]
#
# Options:
#   --rest-api-url=URL         Panel's rest-api base URL, e.g. https://api.example.com
#   --token=TOKEN              One-time node claim token issued by the panel
#   --tailscale-authkey=KEY    Tailscale auth key for headless `tailscale up`. Only needed for a
#                              manual/no-panel setup (no --rest-api-url/--token) -- when doing a
#                              full claim, the panel mints a single-use key for you automatically
#                              and this flag is ignored. Generate one at
#                              https://login.tailscale.com/admin/settings/keys if you need it.
#   --ssh-cidr=CIDR            Source CIDR allowed to reach SSH (default: the LAN network of the
#                              primary interface, e.g. 10.0.0.0/24). Tailscale SSH works regardless.
#   --static-ip=ADDR/PREFIX    Give the primary NIC a static address via netplan (e.g. 10.0.0.5/24),
#                              with Cloudflare DNS. Applied as the very last step, since a changed
#                              address drops your SSH session. Without this flag the script asks
#                              on the terminal (answer N or pass --no-prompt to keep DHCP).
#   --gateway=IP               Default gateway for --static-ip (default: the current default route)
#   --no-prompt                Never ask questions on the terminal (unattended installs)
#   --nvidia-driver=PKG        NVIDIA driver package to install when nvidia-smi is missing, e.g.
#                              nvidia-driver-550 (default: whatever `ubuntu-drivers` recommends).
#                              The kernel module only loads after a reboot, so the box reboots once
#                              and this script resumes itself with the same arguments; follow along
#                              with: tail -f /var/log/streamwizard-install.log
#   --skip-nvidia-driver       Never install the driver; fail if nvidia-smi is missing
#   --resume                   Internal: set by the post-reboot resume service
#   --ref=REF                  Branch/tag to fetch docker-compose.yml and .env.example from
#                              (default: main)
#   --repo-dir=DIR             Config directory holding docker-compose.yml/.env
#                              (default: /opt/obs-instance-manager)
#   --service-user=NAME        Dedicated service account to run containers as (default: obs)
#   --start                    Bring the stack up at the end (default: pull only)
#   -h, --help                 Show this help

set -euo pipefail

REST_API_URL=""
TOKEN=""
TAILSCALE_AUTHKEY=""
SSH_CIDR=""
SSH_CIDR_EXPLICIT="false"
STATIC_IP=""
GATEWAY=""
NO_PROMPT="false"
NVIDIA_DRIVER_PKG=""
SKIP_NVIDIA_DRIVER="false"
RESUMED="false"
NETPLAN_FILE="/etc/netplan/99-streamwizard-static.yaml"
CLOUD_INIT_NET_OFF="/etc/cloud/cloud.cfg.d/99-streamwizard-disable-network-config.cfg"
RESUME_UNIT="/etc/systemd/system/streamwizard-install-resume.service"
RESUME_LOG="/var/log/streamwizard-install.log"
ORIGINAL_ARGS=("$@")
# Node installs don't clone the repo -- they just need docker-compose.yml and
# .env.example, fetched straight from GitHub at the given ref. This keeps a
# fresh node from needing the whole source tree just to run a prebuilt image
# (see .github/workflows/build-images.yml).
RAW_BASE="https://raw.githubusercontent.com/streamwizard/obs-instance-manager"
REF="main"
REPO_DIR="/opt/obs-instance-manager"
SERVICE_USER="obs"
DO_START="false"
# Fixed, not configurable: the panel fills obs_nodes.api_url with
# http://<tailscale-ip>:3000 when the node links, and docker-compose.yml binds
# exactly that. Changing the port would need both to move together.
API_PORT="3000"

log()  { echo "[streamwizard] [install] $*"; }
warn() { echo "[streamwizard] [install] WARNING: $*" >&2; }
die()  { echo "[streamwizard] [install] ERROR: $*" >&2; exit 1; }

# ── Progress helpers ─────────────────────────────────────────────────────────

# Phase bar: one line per step so a reader (or someone tailing the resume
# log) can tell at a glance how far the run is.
STEP_TOTAL=13
STEP_NUM=0
step() {
  STEP_NUM=$((STEP_NUM + 1))
  local width=20 bar="" i filled
  filled=$((STEP_NUM * width / STEP_TOTAL))
  for ((i = 0; i < width; i++)); do
    if [ "$i" -lt "$filled" ]; then bar="${bar}#"; else bar="${bar}-"; fi
  done
  echo
  echo "[streamwizard] [install] [$(printf '%2d' "$STEP_NUM")/$STEP_TOTAL] [$bar] $*"
}

# Runs a long command with a spinner, elapsed time and its last output line
# on a terminal, or a plain "still going" line every 30s without one (the
# resume log). Output is captured; the last 25 lines are shown on failure.
run_with_spinner() {
  local label="$1"; shift
  local logf pid rc=0 start elapsed last spin='|/-\' i=0 last_logged=-1
  logf="$(mktemp)"
  "$@" >"$logf" 2>&1 &
  pid=$!
  start=$SECONDS
  while kill -0 "$pid" 2>/dev/null; do
    elapsed=$((SECONDS - start))
    last="$(tail -n1 "$logf" 2>/dev/null | tr -d '\r' | cut -c1-60)"
    if [ -t 1 ]; then
      printf '\r\033[K[streamwizard] [install] %s %s \xc2\xb7 %02d:%02d \xc2\xb7 %s' \
        "${spin:i++%4:1}" "$label" $((elapsed / 60)) $((elapsed % 60)) "$last"
      sleep 0.5
    else
      if [ $((elapsed / 30)) -ne "$last_logged" ]; then
        last_logged=$((elapsed / 30))
        log "$label ($((elapsed / 60))m$((elapsed % 60))s) $last"
      fi
      sleep 1
    fi
  done
  wait "$pid" || rc=$?
  [ -t 1 ] && printf '\r\033[K'
  if [ "$rc" -ne 0 ]; then
    warn "$label failed (exit $rc). Last output:"
    tail -n 25 "$logf" >&2
  else
    log "$label: done in $(( (SECONDS - start) / 60 ))m$(( (SECONDS - start) % 60 ))s."
  fi
  rm -f "$logf"
  return "$rc"
}

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

# apt-get install with a progress bar. apt reports download and install
# progress on the fd named by APT::Status-Fd as "dlstatus:<n>:<pct>:<text>"
# and "pmstatus:<pkg>:<pct>:<text>" lines; this renders the last one. On a
# terminal it's a live single-line bar; without one (the post-reboot resume
# run, whose output goes to a log file) it's a plain line every 30s so the
# log still shows the install is alive during the multi-minute DKMS build.
apt_install_with_bar() {
  local label="$1"; shift
  local status logf pid rc=0 start elapsed kind pct text bar filled i last_logged=-1
  status="$(mktemp)"; logf="$(mktemp)"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -o APT::Status-Fd=3 "$@" >"$logf" 2>&1 3>"$status" &
  pid=$!
  start=$SECONDS
  while kill -0 "$pid" 2>/dev/null; do
    elapsed=$((SECONDS - start))
    IFS=: read -r kind _ pct text <<< "$(tail -n1 "$status" 2>/dev/null || true)"
    pct="${pct%%.*}"; pct="${pct:-0}"
    case "$kind" in
      dlstatus) kind="downloading" ;;
      pmstatus) kind="installing" ;;
      *) kind="starting"; pct=0; text="" ;;
    esac
    if [ -t 1 ]; then
      filled=$((pct * 30 / 100)); bar=""
      for ((i = 0; i < 30; i++)); do
        if [ "$i" -lt "$filled" ]; then bar="${bar}#"; else bar="${bar}-"; fi
      done
      printf '\r\033[K[streamwizard] [install] %s: [%s] %3d%% %s \xc2\xb7 %02d:%02d \xc2\xb7 %s' \
        "$label" "$bar" "$pct" "$kind" $((elapsed / 60)) $((elapsed % 60)) "${text:0:50}"
    elif [ $((elapsed / 30)) -ne "$last_logged" ]; then
      last_logged=$((elapsed / 30))
      log "$label: ${pct}% $kind ($((elapsed / 60))m$((elapsed % 60))s) ${text}"
    fi
    sleep 1
  done
  wait "$pid" || rc=$?
  [ -t 1 ] && printf '\r\033[K'
  if [ "$rc" -ne 0 ]; then
    warn "$label failed (apt-get exit $rc). Last output:"
    tail -n 25 "$logf" >&2
  else
    log "$label: done in $(( (SECONDS - start) / 60 ))m$(( (SECONDS - start) % 60 ))s."
  fi
  rm -f "$status" "$logf"
  return "$rc"
}

# docker draws its own per-layer bars on a terminal; without one it would
# print a line per layer tick (thousands for a multi-GB image), so use
# --quiet plus the spinner there instead.
run_pull() {
  local label="$1"; shift
  if [ -t 1 ]; then
    log "$label..."
    "$@"
  else
    run_with_spinner "$label" "$@" --quiet
  fi
}

# Prints the header comment block (everything between the banner and
# `set -euo pipefail`) so the help text can't drift from a hard-coded range.
print_help() {
  sed -n '/^# obs-instance-manager node installer/,/^set -euo pipefail/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

# True when there is a terminal to ask questions on. `curl | sudo bash` still
# has one (stdin is the pipe, but /dev/tty is the SSH session); cloud-init or
# a CI runner doesn't, and the prompt is silently skipped there.
have_tty() { [ "$NO_PROMPT" != "true" ] && ( : < /dev/tty ) 2>/dev/null; }

# Optional static address for the primary NIC. Collected early (so the admin
# answers before ten minutes of installs) but APPLIED LAST (see the end of
# this script): if the address changes, the SSH session this runs in drops,
# and with it the script -- so nothing may come after `netplan apply`.
NETPLAN_IFACE=""
NETPLAN_CURRENT_ADDR=""
NETPLAN_CURRENT_GW=""
detect_primary_nic() {
  local line
  line="$(ip -o -4 addr show scope global | grep -vE ' (lo|tailscale0|docker0|br-[0-9a-f]+|veth[^ ]*) ' | head -n1 || true)"
  NETPLAN_IFACE="$(echo "$line" | awk '{print $2}')"
  NETPLAN_CURRENT_ADDR="$(echo "$line" | awk '{print $4}')"
  NETPLAN_CURRENT_GW="$(ip -4 route show default 2>/dev/null | awk '/default/ {print $3; exit}')"
}

prompt_static_ip() {
  [ -z "$STATIC_IP" ] || return 0
  have_tty || return 0
  [ -n "$NETPLAN_IFACE" ] || return 0
  local answer
  read -r -p "[streamwizard] Give $NETPLAN_IFACE a static IP (currently $NETPLAN_CURRENT_ADDR, gateway ${NETPLAN_CURRENT_GW:-unknown})? [y/N] " answer < /dev/tty
  case "$answer" in y|Y|yes|YES) ;; *) log "Keeping the current network config."; return 0 ;; esac
  read -r -p "[streamwizard]   Address with prefix [$NETPLAN_CURRENT_ADDR]: " STATIC_IP < /dev/tty
  STATIC_IP="${STATIC_IP:-$NETPLAN_CURRENT_ADDR}"
  read -r -p "[streamwizard]   Gateway [$NETPLAN_CURRENT_GW]: " GATEWAY < /dev/tty
  GATEWAY="${GATEWAY:-$NETPLAN_CURRENT_GW}"
}

validate_static_ip() {
  [ -n "$STATIC_IP" ] || return 0
  [ -n "$NETPLAN_IFACE" ] || die "--static-ip given but no primary interface could be detected."
  GATEWAY="${GATEWAY:-$NETPLAN_CURRENT_GW}"
  [ -n "$GATEWAY" ] || die "--static-ip needs --gateway (couldn't read a default route to use as the default)."
  python3 -c "
import ipaddress, sys
iface = ipaddress.ip_interface(sys.argv[1])
gw = ipaddress.ip_address(sys.argv[2])
if iface.network.prefixlen >= 32: sys.exit('address needs a network prefix, e.g. 10.0.0.5/24')
if gw not in iface.network: sys.exit(f'gateway {gw} is not inside {iface.network}')
" "$STATIC_IP" "$GATEWAY" || die "Invalid --static-ip/--gateway."
  command -v netplan >/dev/null || die "--static-ip needs netplan (Ubuntu); not found on this host."
  log "Static IP $STATIC_IP via $GATEWAY on $NETPLAN_IFACE will be applied as the last step."
}

apply_static_ip() {
  [ -n "$STATIC_IP" ] || return 0
  log "Writing $NETPLAN_FILE for $NETPLAN_IFACE ($STATIC_IP via $GATEWAY, DNS 1.1.1.1/1.0.0.1)..."
  mkdir -p /etc/netplan
  cat > "$NETPLAN_FILE" <<EOF
# Written by the StreamWizard installer (--static-ip). Remove this file and
# run 'netplan apply' to go back to the OS default (usually DHCP).
network:
  version: 2
  ethernets:
    $NETPLAN_IFACE:
      dhcp4: false
      dhcp6: false
      addresses: [$STATIC_IP]
      routes:
        - to: default
          via: $GATEWAY
      nameservers:
        addresses: [1.1.1.1, 1.0.0.1]
EOF
  chmod 600 "$NETPLAN_FILE"
  # cloud-init rewrites 50-cloud-init.yaml on boot from the provider's
  # metadata; stop it so DHCP doesn't come back on the same interface.
  if [ -d /etc/cloud/cloud.cfg.d ]; then
    echo 'network: {config: disabled}' > "$CLOUD_INIT_NET_OFF"
  fi
  netplan generate || die "netplan rejected $NETPLAN_FILE; fix it and run 'netplan apply' yourself."
  if [ "${STATIC_IP%%/*}" != "${NETPLAN_CURRENT_ADDR%%/*}" ]; then
    warn "Applying the static IP now. The address changes from ${NETPLAN_CURRENT_ADDR%%/*} to ${STATIC_IP%%/*}, so this SSH session will drop -- reconnect to ${STATIC_IP%%/*}. Everything else is already done."
  fi
  netplan apply
}

# The NVIDIA kernel module can't be loaded into a running kernel that has
# nouveau bound to the card, so a driver install needs one reboot. Rather than
# telling the admin "reboot and run the command again", stash a copy of this
# script plus its arguments and a oneshot unit that runs it at next boot.
# The arguments file holds the claim token, so it's root-only and deleted the
# moment the resumed run starts. Static-IP answers given at the prompt are
# carried over as flags (the resumed run has no terminal).
schedule_resume_after_reboot() {
  local resume_sh="$REPO_DIR/install-resume.sh" resume_args="$REPO_DIR/.install-resume-args"
  mkdir -p "$REPO_DIR"
  curl_with_backoff -fsSL -o "$REPO_DIR/install.sh" "$RAW_BASE/$REF/scripts/install.sh" \
    || die "Driver installed but couldn't fetch a copy of install.sh to resume after the reboot. Reboot, then run the same install command again."
  chmod 700 "$REPO_DIR/install.sh"

  : > "$resume_args"
  chmod 600 "$resume_args"
  local a
  for a in ${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}; do
    case "$a" in
      --static-ip=*|--gateway=*|--no-prompt|--resume) ;;
      *) printf '%s\n' "$a" >> "$resume_args" ;;
    esac
  done
  [ -z "$STATIC_IP" ] || printf '%s\n' "--static-ip=$STATIC_IP" "--gateway=$GATEWAY" >> "$resume_args"
  printf '%s\n' "--no-prompt" "--resume" >> "$resume_args"

  cat > "$resume_sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
mapfile -t args < "$resume_args"
exec /bin/bash "$REPO_DIR/install.sh" "\${args[@]}"
EOF
  chmod 700 "$resume_sh"

  cat > "$RESUME_UNIT" <<EOF
[Unit]
Description=StreamWizard node installer (resume after NVIDIA driver reboot)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
# A oneshot inherits DefaultTimeoutStartSec (90s) and gets SIGTERMed when it
# runs longer -- an install with multi-GB image pulls always does.
TimeoutStartSec=infinity
ExecStart=/bin/bash $resume_sh
StandardOutput=append:$RESUME_LOG
StandardError=append:$RESUME_LOG

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable streamwizard-install-resume.service >/dev/null 2>&1
  log "Resume unit: $(systemctl show streamwizard-install-resume.service -p Type -p TimeoutStartUSec 2>/dev/null | tr '\n' ' ')"
  log "NVIDIA driver installed. Rebooting now; the install resumes by itself after boot."
  log "Follow it with: tail -f $RESUME_LOG   (this SSH session will drop)"
  sleep 2
  reboot
  exit 0
}

# First thing a resumed run does: make sure it can't run again (drop the
# wants-symlink) and drop the args file holding the claim token. The unit
# file itself deliberately stays until the run is over -- deleting it and
# reloading systemd while this very service is still running makes systemd
# replace the running instance's definition with defaults (Type=simple, 90s
# start timeout), which SIGTERMs the install mid-pull. `disable` is safe:
# it reloads with the file still present.
clear_resume() {
  systemctl disable streamwizard-install-resume.service >/dev/null 2>&1 || true
  rm -f "$REPO_DIR/.install-resume-args"
}

# Last thing a resumed run does. No daemon-reload here on purpose (see
# clear_resume); systemd simply won't find the unit at the next reload or
# boot, and it is already disabled.
finish_resume() {
  [ "$RESUMED" = "true" ] || return 0
  rm -f "$RESUME_UNIT" "$REPO_DIR/install-resume.sh"
}

for arg in "$@"; do
  case "$arg" in
    --rest-api-url=*) REST_API_URL="${arg#*=}" ;;
    --token=*) TOKEN="${arg#*=}" ;;
    --tailscale-authkey=*) TAILSCALE_AUTHKEY="${arg#*=}" ;;
    --ssh-cidr=*) SSH_CIDR="${arg#*=}"; SSH_CIDR_EXPLICIT="true" ;;
    --static-ip=*) STATIC_IP="${arg#*=}" ;;
    --gateway=*) GATEWAY="${arg#*=}" ;;
    --no-prompt) NO_PROMPT="true" ;;
    --nvidia-driver=*) NVIDIA_DRIVER_PKG="${arg#*=}" ;;
    --skip-nvidia-driver) SKIP_NVIDIA_DRIVER="true" ;;
    --resume) RESUMED="true"; NO_PROMPT="true" ;;
    --ref=*) REF="${arg#*=}" ;;
    --repo-dir=*) REPO_DIR="${arg#*=}" ;;
    --service-user=*) SERVICE_USER="${arg#*=}" ;;
    --start) DO_START="true" ;;
    -h|--help) print_help; exit 0 ;;
    *) die "Unknown option: $arg" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Must run as root (sudo bash install.sh ...)"

if [ "$RESUMED" = "true" ]; then
  log "Resuming after the NVIDIA driver reboot..."
  clear_resume
fi

step "Baseline packages"
# Fresh images regularly ship with stale (or no) apt lists; refresh before the
# first install below or `apt-get install` on an untouched box just fails.
run_with_spinner "Refreshing apt lists" apt-get update -qq || die "apt-get update failed."
command -v curl >/dev/null || apt-get install -y --no-install-recommends curl >/dev/null
command -v ufw >/dev/null || apt-get install -y --no-install-recommends ufw >/dev/null
command -v lspci >/dev/null || apt-get install -y --no-install-recommends pciutils >/dev/null
# The claim body, the claim-response parsing, the .env writer, the CIDR maths
# and the daemon.json edit below are all python3; Ubuntu Server ships it but
# some minimal cloud images don't.
command -v python3 >/dev/null || apt-get install -y --no-install-recommends python3 >/dev/null

step "Network (static IP, DNS)"
detect_primary_nic
prompt_static_ip
validate_static_ip

# Same DNS baseline as ingest-server: don't trust whatever resolver DHCP
# happened to hand out; the node pulls multi-GB images and talks to the panel
# and Tailscale, all of which stall on a flaky resolver.
if command -v systemctl >/dev/null && systemctl is-active --quiet systemd-resolved 2>/dev/null; then
  log "Setting default DNS to Cloudflare (1.1.1.1, 1.0.0.1)..."
  mkdir -p /etc/systemd/resolved.conf.d
  cat > /etc/systemd/resolved.conf.d/99-streamwizard-dns.conf <<'EOF'
[Resolve]
DNS=1.1.1.1 1.0.0.1
FallbackDNS=8.8.8.8 8.8.4.4
EOF
  systemctl restart systemd-resolved
else
  warn "systemd-resolved not detected; skipping the Cloudflare DNS baseline (leaving whatever resolver the OS already has)."
fi

step "GPU and NVIDIA driver"
lspci | grep -qi nvidia || die "No NVIDIA GPU detected via lspci. This installer requires GPU passthrough already configured at the hypervisor level."

if command -v nvidia-smi >/dev/null && nvidia-smi >/dev/null 2>&1; then
  log "NVIDIA driver working ($(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -n1))."
else
  if [ "$RESUMED" = "true" ]; then
    die "NVIDIA driver still isn't working after the reboot. Check 'dmesg | grep -i nvidia', 'ubuntu-drivers devices' and 'dkms status', fix it by hand, then re-run the install command."
  fi
  if [ "$SKIP_NVIDIA_DRIVER" = "true" ]; then
    die "nvidia-smi not found or not working, and --skip-nvidia-driver was given. Install the NVIDIA driver on the host, reboot, then re-run."
  fi
  # A DKMS-built module has to be signed with a key the firmware trusts, and
  # enrolling one (MOK) is an interactive step at the next boot -- nothing an
  # unattended installer can do. Better to stop here than reboot into a box
  # where the module silently refuses to load.
  if command -v mokutil >/dev/null && mokutil --sb-state 2>/dev/null | grep -qi "enabled"; then
    die "Secure Boot is enabled, so the NVIDIA kernel module can't be installed unattended (it needs a MOK-signed build). Disable Secure Boot in the BIOS/hypervisor, or install the driver by hand and reboot, then re-run."
  fi

  if dpkg -l 2>/dev/null | grep -qE '^ii[[:space:]]+nvidia-driver-[0-9]+'; then
    log "NVIDIA driver package is installed but the module isn't loaded yet; a reboot is needed."
  else
    log "Installing the NVIDIA driver..."
    apt_install_with_bar "Driver helper (ubuntu-drivers-common)" --no-install-recommends ubuntu-drivers-common || die "Installing ubuntu-drivers-common failed."
    # DKMS needs the running kernel's headers; the metapackage is usually
    # already there, and ubuntu-drivers pulls what it needs, so non-fatal.
    apt-get install -y --no-install-recommends "linux-headers-$(uname -r)" >/dev/null 2>&1 || true
    if [ -n "$NVIDIA_DRIVER_PKG" ]; then
      DRIVER_PKG="$NVIDIA_DRIVER_PKG"
    else
      # Take the package `ubuntu-drivers` recommends (the full driver, not
      # the headless/-gpgpu variant: the gpu-xserver container needs the
      # host's GL libraries mounted in by the container toolkit) and install
      # it ourselves so apt's progress feed can drive the bar below.
      DRIVER_PKG="$(ubuntu-drivers devices 2>/dev/null | awk '/^driver.*recommended/ {print $3; exit}')"
      [ -n "$DRIVER_PKG" ] || die "ubuntu-drivers found no recommended driver for this GPU. Pass --nvidia-driver=<package> (see 'ubuntu-drivers devices') and re-run."
    fi
    log "Installing $DRIVER_PKG (a few minutes; the DKMS kernel-module build is the slow part)..."
    apt_install_with_bar "NVIDIA driver" "$DRIVER_PKG" || die "Installing $DRIVER_PKG failed. Fix the apt error above (or pass a different --nvidia-driver=<package>) and re-run."
  fi
  schedule_resume_after_reboot
fi

step "NVIDIA container toolkit"
if ! dpkg -l nvidia-container-toolkit >/dev/null 2>&1; then
  # --yes: overwrite a keyring left behind by an earlier partial run instead
  # of prompting (there's no tty under `curl | sudo bash`, so gpg would fail).
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  run_with_spinner "Refreshing apt lists (nvidia repo)" apt-get update -qq || die "apt-get update failed."
  apt_install_with_bar "nvidia-container-toolkit" nvidia-container-toolkit || die "Installing nvidia-container-toolkit failed."
else
  log "nvidia-container-toolkit already installed."
fi

step "Docker"
if ! command -v docker >/dev/null; then
  run_with_spinner "Installing Docker (get.docker.com)" bash -c 'curl -fsSL https://get.docker.com | sh' || die "Docker install failed."
else
  log "Docker already installed ($(docker --version))."
fi
systemctl enable --now docker >/dev/null

step "nvidia runtime in the Docker daemon"
DAEMON_JSON=/etc/docker/daemon.json
NEEDS_RESTART="false"
if [ ! -f "$DAEMON_JSON" ]; then
  echo '{}' > "$DAEMON_JSON"
fi
if ! python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get('runtimes',{}).get('nvidia') else 1)" "$DAEMON_JSON" 2>/dev/null; then
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

step "Tailscale"
if ! command -v tailscale >/dev/null; then
  run_with_spinner "Installing Tailscale" bash -c 'curl -fsSL https://tailscale.com/install.sh | sh' || die "Tailscale install failed."
else
  log "Tailscale already installed."
fi

# docker-compose.yml binds the API to the Tailscale address. On boot, Docker
# can't bind an address that doesn't exist yet, so make sure tailscaled has
# had its turn first. `restart: unless-stopped` would eventually recover
# anyway; this just avoids the crash-loop noise.
mkdir -p /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/10-after-tailscale.conf <<'EOF'
[Unit]
After=tailscaled.service
Wants=tailscaled.service
EOF
systemctl daemon-reload

# Whether we defer bringing Tailscale up until after claiming (so we can use
# the panel-minted key from the claim response instead of a manually-supplied
# one). Only relevant when doing a full claim; a manual/no-panel run either
# has a --tailscale-authkey to use right now or doesn't get Tailscale at all.
TAILSCALE_JOIN_DEFERRED="false"
if ! tailscale status >/dev/null 2>&1; then
  if [ -n "$TAILSCALE_AUTHKEY" ]; then
    log "Bringing Tailscale up..."
    tailscale up --authkey="$TAILSCALE_AUTHKEY" --ssh
  elif [ -n "$REST_API_URL" ] && [ -n "$TOKEN" ]; then
    log "No --tailscale-authkey given; will join Tailscale using the key returned by the claim response."
    TAILSCALE_JOIN_DEFERRED="true"
  else
    warn "Tailscale isn't up and no --tailscale-authkey was given. Skipping automated setup -- run 'tailscale up' yourself, then re-run this installer (or manually set TAILSCALE_IP in .env and add the tailscale0 ufw rule below)."
  fi
else
  log "Tailscale already up."
fi

TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
if [ -n "$TAILSCALE_IP" ]; then
  log "Tailscale IP: $TAILSCALE_IP"
elif [ "$TAILSCALE_JOIN_DEFERRED" != "true" ]; then
  warn "No Tailscale IP available yet."
fi

# Primary NIC's address (detected once, up top, excluding anything Docker or
# Tailscale created so a re-run on a provisioned box still finds the real LAN
# interface). If a static address was requested it isn't applied until the
# end, so size the SSH rule for the network the box is about to be on.
LAN_IFACE_ADDR="${STATIC_IP:-$NETPLAN_CURRENT_ADDR}"

if [ -z "$SSH_CIDR" ]; then
  [ -n "$LAN_IFACE_ADDR" ] || die "Could not auto-detect a LAN CIDR; pass --ssh-cidr explicitly."
  # Keep the interface's real prefix (a /22 stays a /22) instead of forcing
  # everything to a /24, which silently allowed the wrong subnet before.
  SSH_CIDR="$(python3 -c "import ipaddress,sys; print(ipaddress.ip_interface(sys.argv[1]).network)" "$LAN_IFACE_ADDR")"
  log "Auto-detected LAN CIDR for SSH: $SSH_CIDR (override with --ssh-cidr)"
fi

# Lockout guard: if this very session came in over SSH from outside the CIDR
# we're about to restrict port 22 to, enabling ufw would cut it off (and every
# future one). sudo strips SSH_CONNECTION, so fall back to the kernel's view
# of established :22 connections. Best effort -- if nothing is found, carry on.
SSH_PEER_IP="${SSH_CONNECTION:-}"; SSH_PEER_IP="${SSH_PEER_IP%% *}"
if [ -z "$SSH_PEER_IP" ] && command -v ss >/dev/null; then
  SSH_PEER_IP="$(ss -Htn state established '( sport = :22 )' 2>/dev/null | awk '{print $4}' | head -n1 | sed -E 's/^\[?::ffff:([0-9.]+)\]?:[0-9]+$/\1/; s/:[0-9]+$//' || true)"
fi
if [ -n "$SSH_PEER_IP" ] && echo "$SSH_PEER_IP" | grep -qE '^[0-9.]+$'; then
  if ! python3 -c "import ipaddress,sys; sys.exit(0 if ipaddress.ip_address(sys.argv[1]) in ipaddress.ip_network(sys.argv[2], strict=False) else 1)" "$SSH_PEER_IP" "$SSH_CIDR"; then
    if [ "$SSH_CIDR_EXPLICIT" = "true" ]; then
      warn "Your SSH session comes from $SSH_PEER_IP, which is outside --ssh-cidr=$SSH_CIDR. Continuing because you asked for it explicitly -- make sure you have another way in (Tailscale SSH, console)."
    else
      die "Your SSH session comes from $SSH_PEER_IP, which is outside the auto-detected LAN CIDR $SSH_CIDR. Enabling ufw would lock you out. Re-run with --ssh-cidr=<your network> (or --ssh-cidr=0.0.0.0/0 to keep SSH open everywhere)."
    fi
  fi
fi

# The API port is reachable via loopback (cloudflared on the same host) and
# Tailscale, never on the LAN or a public interface -- mirrors the compose
# file's 127.0.0.1 + ${TAILSCALE_IP} bindings. ufw allows loopback by default;
# this adds the tailscale0 rule. No rule is ever added for any other interface.
#
# A function (rather than inlined once) because when the Tailscale join is
# deferred to after claiming, tailscale0 doesn't exist yet at the point ufw is
# first configured -- this gets called again once the interface shows up,
# later in the claim block. The status-grep guard makes a second call a no-op
# instead of adding a duplicate rule.
add_tailscale_api_rule() {
  ip link show tailscale0 >/dev/null 2>&1 || return 1
  ufw status | grep -qi "${API_PORT}.*tailscale0\|tailscale0.*${API_PORT}" && return 0
  ufw allow in on tailscale0 to any port "$API_PORT" proto tcp comment "obs-instance-manager API (tailscale only)" >/dev/null
  log "Opened the tailscale-only ufw rule for port $API_PORT."
}

step "Firewall (SSH from $SSH_CIDR, tailscale-only API on $API_PORT/tcp)"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow from "$SSH_CIDR" to any port 22 proto tcp comment "SSH" >/dev/null
if ! add_tailscale_api_rule; then
  warn "tailscale0 interface not present yet; skipping the :$API_PORT tailscale-only rule for now. It will be added automatically once Tailscale comes up (either below, after claiming, or the next time you run this script)."
fi
ufw --force enable >/dev/null
ufw status verbose

step "Service account '$SERVICE_USER' and data directories"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd -m -d "/home/$SERVICE_USER" -s /usr/sbin/nologin -c "Service account for OBS containers" "$SERVICE_USER"
fi
usermod -aG docker "$SERVICE_USER"

mkdir -p /data/obs-configs
chown -R "$SERVICE_USER:$SERVICE_USER" /data/obs-configs

mkdir -p /data/obs-plugins
chown -R "$SERVICE_USER:$SERVICE_USER" /data/obs-plugins

step "Node config files (ref: $REF)"
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
  step "Linking to panel via rest-api at $REST_API_URL"
  # nvidia-smi reports domain:bus:device.function in hex (e.g. 00000000:00:10.0).
  # Xorg's BusID option needs "PCI:bus:device:function" in decimal, so convert here
  # once at registration time rather than in every consumer of gpu_bus_id.
  GPU_BUS_ID_RAW="$(nvidia-smi --query-gpu=pci.bus_id --format=csv,noheader | head -n1)"
  GPU_BUS_ID="$(python3 -c "
import sys
addr = sys.argv[1].split(':')
bus, dev_func = addr[-2], addr[-1]
dev, func = dev_func.split('.')
print(f'PCI:{int(bus, 16)}:{int(dev, 16)}:{int(func, 16)}')
" "$GPU_BUS_ID_RAW")"
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

  # Not -f: a 4xx here carries a JSON {"error": "..."} body from rest-api
  # (invalid/expired/already-claimed token) that we want to surface verbatim
  # instead of curl swallowing it and leaving just an opaque exit code 22.
  claim_attempt=1
  claim_max_attempts=10
  claim_delay=1
  while true; do
    CLAIM_RAW="$(curl -sS -w '\n%{http_code}' -X POST "$REST_API_URL/api/nodes/claim" \
      -H "Content-Type: application/json" \
      -d "$CLAIM_BODY")"
    CLAIM_HTTP_STATUS="${CLAIM_RAW##*$'\n'}"
    CLAIM_RESPONSE="${CLAIM_RAW%$'\n'*}"

    [ "$CLAIM_HTTP_STATUS" = "200" ] && break

    # Client errors (bad/expired/used token, malformed request) won't be
    # fixed by retrying -- fail fast with the panel's own error message
    # instead of burning ~17 minutes of backoff on a dead token.
    case "$CLAIM_HTTP_STATUS" in
      4[0-9][0-9])
        CLAIM_ERROR="$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('error','unknown error'))" "$CLAIM_RESPONSE" 2>/dev/null || echo "$CLAIM_RESPONSE")"
        die "Node claim rejected by panel (HTTP $CLAIM_HTTP_STATUS): $CLAIM_ERROR"
        ;;
    esac

    if [ "$claim_attempt" -ge "$claim_max_attempts" ]; then
      die "Node claim request to $REST_API_URL failed after $claim_max_attempts attempts (last status: $CLAIM_HTTP_STATUS). Check the URL and that rest-api's /api/nodes/claim endpoint exists (see docs/PANEL_INTEGRATION.md)."
    fi
    warn "Node claim request failed (HTTP $CLAIM_HTTP_STATUS, attempt $claim_attempt/$claim_max_attempts), retrying in ${claim_delay}s..."
    sleep "$claim_delay"
    claim_attempt=$((claim_attempt + 1))
    claim_delay=$((claim_delay * 2))
  done

  if [ "$TAILSCALE_JOIN_DEFERRED" = "true" ]; then
    CLAIM_TAILSCALE_AUTHKEY="$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('tailscale_authkey') or '')" "$CLAIM_RESPONSE")"
    if [ -n "$CLAIM_TAILSCALE_AUTHKEY" ]; then
      log "Bringing Tailscale up using the panel-minted key..."
      tailscale up --authkey="$CLAIM_TAILSCALE_AUTHKEY" --ssh
      TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
      if [ -n "$TAILSCALE_IP" ]; then
        log "Tailscale IP: $TAILSCALE_IP"
        # /claim already ran and couldn't have known this IP (the auth key
        # used above came back IN that response), so report it back now via
        # its own authenticated round trip. The panel also fills in the
        # node's api_url (http://<ip>:3000) from this if the admin left it
        # blank -- which is what makes the node reachable from the panel.
        NODE_API_KEY="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['node_api_key'])" "$CLAIM_RESPONSE")"
        REPORT_BODY="$(python3 -c "import json,sys; print(json.dumps({'tailscale_ip': sys.argv[1]}))" "$TAILSCALE_IP")"
        REPORT_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH "$REST_API_URL/api/nodes/me" \
          -H "Authorization: Bearer $NODE_API_KEY" \
          -H "Content-Type: application/json" \
          -d "$REPORT_BODY")"
        [ "$REPORT_STATUS" = "200" ] || warn "Reported Tailscale IP to panel but got HTTP $REPORT_STATUS back; the panel's node record may still show no Tailscale IP / API URL. Set api_url by hand in web-admin if so."
      else
        warn "Joined Tailscale but couldn't read back an IP."
      fi
      add_tailscale_api_rule || warn "tailscale0 still not present after 'tailscale up'; add the :$API_PORT rule manually: ufw allow in on tailscale0 to any port $API_PORT proto tcp"
    else
      warn "Claim response did not include a Tailscale auth key (Tailscale API may be unreachable or misconfigured on the panel side). Run 'tailscale up' yourself, then: ufw allow in on tailscale0 to any port $API_PORT proto tcp, set TAILSCALE_IP in $ENV_FILE, and report it with: curl -X PATCH $REST_API_URL/api/nodes/me -H 'Authorization: Bearer <NODE_API_KEY>' -H 'Content-Type: application/json' -d '{\"tailscale_ip\":\"<ip>\"}'"
    fi
  fi

  python3 - "$ENV_FILE" "$CLAIM_RESPONSE" "$GPU_BUS_ID" "$TAILSCALE_IP" <<'PY'
import json, sys
env_path, raw, gpu_bus_id_computed, tailscale_ip = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
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
    # docker-compose.yml binds the API to loopback and to this address.
    # Blank means "not joined yet" and compose refuses to start (see the
    # `:?` guard there and the gate at the end of this script).
    f.write(f"TAILSCALE_IP={tailscale_ip}\n")
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
    # rest-api only includes these when both are configured -- fall back to
    # blank so the node still installs, it just won't push lifecycle events to
    # browsers (src/clients/ws-server.ts skips the broadcast when unset).
    f.write(f"WS_SERVER_URL={data.get('WS_SERVER_URL') or ''}\n")
    f.write(f"CONSUMER_SECRET={data.get('CONSUMER_SECRET') or ''}\n")
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
    if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
      tailscale set --hostname="$NODE_HOSTNAME" 2>/dev/null || warn "Couldn't set the Tailscale hostname (non-fatal)."
    fi
  else
    warn "Claim response did not include a hostname; leaving the host's hostname unchanged."
  fi
else
  step "Manual .env (no --rest-api-url/--token)"
  if [ ! -f "$ENV_FILE" ]; then
    curl_with_backoff -fsSL -o "$ENV_FILE" "$RAW_BASE/$REF/.env.example" \
      || die "Failed to fetch .env.example from ref '$REF'. Check the --ref value and your network connection."
    if [ -n "$TAILSCALE_IP" ]; then
      sed -i "s/^TAILSCALE_IP=.*/TAILSCALE_IP=$TAILSCALE_IP/" "$ENV_FILE"
    fi
    warn "No --rest-api-url/--token given. Scaffolded $ENV_FILE from .env.example -- fill in NODE_ID, NODE_API_KEY, REST_API_URL, SUPABASE_URL (and TAILSCALE_IP if Tailscale wasn't up yet) by hand before starting."
  else
    log "$ENV_FILE already exists, leaving it as-is."
  fi
fi
chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

step "Container images"
run_pull "Pulling the OBS container image (multi-GB, can take a while)" \
  sudo -u "$SERVICE_USER" docker pull ghcr.io/streamwizard/obs-cloud-container:latest \
  || warn "Pre-pull of the OBS image failed; it will be pulled on first instance creation instead."

# docker-compose.yml hard-fails on a blank TAILSCALE_IP (the `:?` guard on
# the port binding). A pull never binds anything, so give it a placeholder
# via the environment (which takes precedence over .env for interpolation)
# when the node hasn't joined Tailscale yet -- the real value in .env is
# what `up` sees, and the gate below refuses to `up` without it.
run_pull "Pulling the api + cadvisor images as $SERVICE_USER" \
  sudo -u "$SERVICE_USER" env TAILSCALE_IP="${TAILSCALE_IP:-0.0.0.0}" docker compose --project-directory "$REPO_DIR" pull \
  || die "docker compose pull failed."

step "Start"
# TAILSCALE_IP is in this list on purpose: docker-compose.yml binds the API
# port to it, and Docker-published ports bypass ufw entirely -- so with a
# blank value compose would publish the API on 0.0.0.0 and nothing on the
# host would stop the traffic. Refusing to start is the only safe answer
# until the node has actually joined Tailscale.
MISSING_KEYS=""
for key in NODE_ID NODE_API_KEY REST_API_URL SUPABASE_URL GPU_BUSID S3_ENDPOINT S3_ACCESS_KEY S3_SECRET_KEY S3_BUCKET S3_REGION TOKEN_ENCRYPTION_KEY TAILSCALE_IP; do
  grep -q "^${key}=.\+" "$ENV_FILE" || MISSING_KEYS="$MISSING_KEYS $key"
done

if [ "$DO_START" = "true" ]; then
  if [ -z "$MISSING_KEYS" ]; then
    log "Starting the stack..."
    sudo -u "$SERVICE_USER" bash -c "cd '$REPO_DIR' && docker compose up -d"
  else
    warn "--start was given but $ENV_FILE is missing required values (${MISSING_KEYS# }); not starting. Fill them in and run: sudo -u $SERVICE_USER bash -c 'cd $REPO_DIR && docker compose up -d'"
    case "$MISSING_KEYS" in *TAILSCALE_IP*)
      warn "TAILSCALE_IP is blank because this node hasn't joined Tailscale yet. Run 'tailscale up' (or re-run this installer with --tailscale-authkey=...), then set TAILSCALE_IP in $ENV_FILE to the output of 'tailscale ip -4'. Do NOT start the stack without it: the API would be published on every interface." ;;
    esac
  fi
else
  log "Images pulled. Not starting (pass --start to bring the stack up automatically)."
  log "To start manually: sudo -u $SERVICE_USER bash -c 'cd $REPO_DIR && docker compose up -d'"
fi

log "Done."
finish_resume

# Must stay the last thing in this script: an address change drops the SSH
# session (and this process with it). Nothing below this line would run.
apply_static_ip
