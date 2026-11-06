#!/usr/bin/env bash

# Crow — Installer Script
#
# Transforms a stock Raspberry Pi OS (or any Debian/Ubuntu) into a Crow appliance.
#
# Platform: Debian/Ubuntu family ONLY (the script drives apt end to end).
# macOS, Windows, and other Linux distributions are not auto-installed —
# follow the manual path in docs/getting-started/ instead.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh | bash
#
# Or download and inspect first:
#   curl -sSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh -o crow-install.sh
#   less crow-install.sh
#   bash crow-install.sh
#
# Options:
#   -y, --yes          assume the default answer to every prompt (also CROW_INSTALL_YES=1)
#   --no-auto-updates  do not turn on automatic security updates (also CROW_NO_AUTO_UPDATES=1)
#
# The one-liner above feeds the script to bash on stdin, so an option has to go
# to bash itself and not after the URL:
#   curl -sSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh | bash -s -- --no-auto-updates
#   curl -sSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh | CROW_NO_AUTO_UPDATES=1 bash

set -euo pipefail

CROW_HOME="$HOME/.crow"
CROW_APP="$CROW_HOME/app"
CROW_DATA="$CROW_HOME/data"
NODE_MAJOR=24

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# How many `error`s this run printed. The closing "Crow is ready!" banner is
# gated on it (security audit N1c-15: the installer printed the banner, and
# exited 0, right after its own gateway health check had failed).
INSTALL_ERRORS=0

log()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn()  { echo -e "  ${YELLOW}!${NC} $1"; }
error() { echo -e "  ${RED}✗${NC} $1"; INSTALL_ERRORS=$((INSTALL_ERRORS + 1)); }
header() {
  echo ""
  echo "═══════════════════════════════════════════════"
  echo "  $1"
  echo "═══════════════════════════════════════════════"
}

# ─── Prompt helpers (F-INSTALL-5/-7) ──────────────────────
# The documented `curl … | bash` one-liner has no usable stdin (the script
# body IS stdin), so prompts read /dev/tty when a terminal exists and resolve
# to their DEFAULT when it does not (headless / cloud-init / CI).
# `--yes` / `-y` / CROW_INSTALL_YES=1 forces defaults everywhere.
ASSUME_YES=false
# Automatic security updates (K6) are ON by default; --no-auto-updates or
# CROW_NO_AUTO_UPDATES=1 leaves the host's apt configuration alone entirely.
AUTO_UPDATES=true
for _arg in "$@"; do
  case "$_arg" in
    -y|--yes) ASSUME_YES=true ;;
    --no-auto-updates) AUTO_UPDATES=false ;;
  esac
done
if [ "${CROW_INSTALL_YES:-}" = "1" ]; then ASSUME_YES=true; fi
if [ "${CROW_NO_AUTO_UPDATES:-}" = "1" ]; then AUTO_UPDATES=false; fi

# Real tty detection (R1-I1): [ -r /dev/tty ] only tests the device node's
# permission bits and is TRUE even with no controlling terminal. Actually
# opening it is the reliable probe (fails with ENXIO when headless), and it
# keeps genuinely-headless installs from spraying /dev/tty errors into logs.
HAS_TTY=false
if { exec 3</dev/tty; } 2>/dev/null; then
  exec 3<&-
  HAS_TTY=true
fi

# ask_yn <prompt> <default Y|N> — 0=yes, 1=no. Headless/--yes → default.
ask_yn() {
  local prompt="$1" default="$2" reply=""
  if [ "$ASSUME_YES" = true ] || [ "$HAS_TTY" = false ]; then
    [ "$default" = "Y" ] && return 0 || return 1
  fi
  if [ "$default" = "Y" ]; then
    printf "  %s [Y/n] " "$prompt" > /dev/tty
  else
    printf "  %s [y/N] " "$prompt" > /dev/tty
  fi
  IFS= read -r reply < /dev/tty || reply=""
  case "$reply" in
    [Yy]*) return 0 ;;
    [Nn]*) return 1 ;;
    *) [ "$default" = "Y" ] && return 0 || return 1 ;;
  esac
}

# ask_line <prompt> — prints the reply; empty when headless/--yes/EOF.
ask_line() {
  local prompt="$1" reply=""
  if [ "$ASSUME_YES" = true ] || [ "$HAS_TTY" = false ]; then
    return 0
  fi
  printf "  %s" "$prompt" > /dev/tty
  IFS= read -r reply < /dev/tty || reply=""
  printf "%s" "$reply"
}

# ts_first_field <JsonKey> — first "<JsonKey>":"value" in $TS_JSON, no pipes
# (F-INSTALL-6: piping through grep then head SIGPIPEs under pipefail on big tailnets).
# The first match is always the Self block (tailscale status --json emits
# Self before Peer).
ts_first_field() {
  local key="$1"
  if [[ ${TS_JSON:-} =~ \"${key}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]]; then
    printf "%s" "${BASH_REMATCH[1]}"
  fi
}

# check_platform [os_release_path] [apt_probe_cmd] — 0 when this host is a
# Debian/Ubuntu family system with apt available, 1 otherwise (Item 4-PR5).
# The script drives apt end to end, so anything else must be refused BEFORE
# the first system mutation. Both params are test seams; they default to the
# real /etc/os-release and apt-get.
# shellcheck disable=SC2120  # params are test-only seams; the prod call passes none
check_platform() {
  local os_release="${1:-/etc/os-release}" apt_cmd="${2:-apt-get}"
  local id="" id_like=""
  if ! command -v "$apt_cmd" >/dev/null 2>&1; then
    return 1
  fi
  if [ -r "$os_release" ]; then
    id="$(sed -n 's/^ID=//p' "$os_release" | tr -d '"')"
    id_like="$(sed -n 's/^ID_LIKE=//p' "$os_release" | tr -d '"')"
  fi
  case " $id $id_like " in
    *" debian "*|*" ubuntu "*) return 0 ;;
  esac
  return 1
}

# Quote one argument for a systemd Exec= line: a path may contain spaces, and a
# literal % is a systemd specifier (%% writes one).
sd_quote() { # <arg>
  local s="$1"
  s="${s//%/%%}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

# ─── Port precheck (security audit N1c-15) ───────────────
# Nothing may be installed or started while another program already owns one of
# the three ports this installer binds: the new units would fail — or, worse,
# half-start and be shadowed — and the operator would find out from a browser
# error much later. `ss` is iproute2's socket tool and ships on Debian/Ubuntu;
# `-ltnH` lists TCP listeners without a header and without needing root (the
# check only asks WHETHER a port is busy; the fix-it hint asks root for the PID).
CROW_INSTALL_PORTS=(3001 80 443)   # gateway · HTTP (Caddy) · HTTPS (Caddy)

port_is_listening() { # <port> — 0 when a TCP socket listens on it
  local listeners=""
  command -v ss >/dev/null 2>&1 || return 1
  listeners="$(ss -ltnH "sport = :$1" 2>/dev/null || true)"
  [ -n "$listeners" ]
}

crow_owns_port() { # <port> — 0 when an EXISTING Crow install already holds it
  # A re-run must not trip over its own services: only the "already cloned"
  # path can have these units, and only they may hold these ports.
  [ -d "$CROW_APP" ] || return 1
  case "$1" in
    3001) systemctl is-active --quiet crow-gateway 2>/dev/null ;;
    80|443) systemctl is-active --quiet caddy 2>/dev/null ;;
    *) return 1 ;;
  esac
}

check_ports_free() { # 0 when every CROW_INSTALL_PORTS entry is free or Crow's
  local port busy=0
  if ! command -v ss >/dev/null 2>&1; then
    warn "ss (iproute2) is missing — skipping the port check"
    return 0
  fi
  for port in "${CROW_INSTALL_PORTS[@]}"; do
    port_is_listening "$port" || continue
    if crow_owns_port "$port"; then
      continue
    fi
    error "Port ${port} is already in use by another program (see: sudo ss -ltnp 'sport = :${port}')."
    error "Stop that program or free the port, then run the installer again."
    busy=1
  done
  [ "$busy" -eq 0 ]
}

# ─── SSH port detection (security audit N1c-15) ──────────
# `ufw --force enable` opens the firewall instantly: a host whose sshd listens
# on anything but 22 would drop the operator's own session at that moment, and
# they could not get back in. Three probes, all best-effort — 22 is always
# allowed as well, so the worst case is exactly the old behaviour:
#   1. `sudo ss -ltnHp` filtered to listeners whose process is sshd: the ports
#      sshd REALLY listens on. This is the only probe that sees a
#      socket-activated sshd (Ubuntu 22.10+ ships ssh.socket, where a custom
#      port lives in a ListenStream= drop-in and no `Port` line exists at all).
#      The users: column needs root — see the no-prompt note below.
#   2. SSH_CONNECTION's 4th field: the port THIS session arrived on.
#   3. sshd_config's own Port lines, world-readable on Debian/Ubuntu (the drop-in
#      directory is where distro packages and cloud images put them).
# Probe 1 cannot ask for a password: every sudo'd line above it already has.
# The install body's first privileged call is `sudo apt update` (Step 1) and the
# ufw `default`/`allow 22` lines sit directly above the probe, so by then sudo is
# obtained — a box that re-prompts every time would have prompted there instead.
port_in_range() { # <port> — 0 when it is a usable TCP port (1-65535)
  local p="${1:-}"
  case "$p" in ''|*[!0-9]*) return 1 ;; esac
  p="${p#"${p%%[!0]*}"}"          # drop leading zeros (082 is 82, not octal)
  [ -n "$p" ] || return 1           # all zeros is not a port
  [ "$p" -ge 1 ] && [ "$p" -le 65535 ]
}

sshd_ss_ports() { # — the ports sshd is really listening on, one per line
  # `-p` names the owning process, but only root gets that column: without it no
  # line matches, nothing is printed, and the other two probes answer instead.
  local out="" line addr port
  out="$(sudo_cmd ss -ltnHp 2>/dev/null || true)"
  [ -n "$out" ] || return 0
  while IFS= read -r line; do
    case "$line" in *sshd*) ;; *) continue ;; esac
    # Columns: State Recv-Q Send-Q Local-Address:Port Peer-Address:Port Users:…
    read -r _ _ _ addr _ <<< "$line" || true
    port="${addr##*:}"              # 0.0.0.0:2222 · [::]:2222 · *:2222 → 2222
    printf '%s\n' "$port"
  done <<< "$out"
}

# shellcheck disable=SC2120  # the config-file params are test-only seams; the prod call passes none
ssh_ports() { # [config_file…] — every port found once, one per line
  local p cfgs=() raw="" port seen=" "
  raw="$(sshd_ss_ports)"
  if [ -n "${SSH_CONNECTION:-}" ]; then
    read -r _ _ _ p <<< "$SSH_CONNECTION" || true
    raw="${raw}${p:-}"$'\n'
  fi
  if [ "$#" -gt 0 ]; then
    cfgs=("$@")
  else
    cfgs=(/etc/ssh/sshd_config)
    for p in /etc/ssh/sshd_config.d/*.conf; do
      if [ -r "$p" ]; then cfgs+=("$p"); fi
    done
  fi
  for p in "${cfgs[@]}"; do
    if [ -r "$p" ]; then
      # Keywords are case-insensitive, and `q` on the first Match line stops the
      # read there: a Port inside a Match block is invalid for sshd, so honouring
      # it would only open a port nothing listens on.
      raw="${raw}$(sed -n '/^[[:space:]]*[Mm][Aa][Tt][Cc][Hh]/q;s/^[[:space:]]*[Pp][Oo][Rr][Tt][[:space:]][[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$p" 2>/dev/null || true)"$'\n'
    fi
  done
  while IFS= read -r port; do
    port_in_range "$port" || continue
    case "$seen" in *" $port "*) continue ;; esac
    seen="${seen}${port} "
    printf '%s\n' "$port"
  done <<< "$raw"
}

# ─── Failure tracking + gateway verification (audit N1c-15) ──
# "Crow is ready!" is a promise; it may only be printed when nothing failed.
install_failed() { # 0 when this run printed at least one error
  [ "${INSTALL_ERRORS:-0}" -ne 0 ]
}

# verify_gateway — the service check plus HTTP health probe that decide whether
# this run may claim to be finished. Every failure goes through `error` (so the
# banner below is blocked too) and names the commands that show the cause.
verify_gateway() {
  local ok=false
  if systemctl is-active --quiet crow-gateway 2>/dev/null; then
    log "Gateway service: running"
  else
    error "Gateway service is not running (see: sudo systemctl status crow-gateway)"
  fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS -o /dev/null http://localhost:3001/health 2>/dev/null; then
      ok=true
      break
    fi
    sleep 2
  done
  if [ "$ok" = true ]; then
    log "Gateway responding at http://localhost:3001"
    return 0
  fi
  error "Gateway did not respond at http://localhost:3001 after 10 attempts — Crow is not ready."
  echo "    1. Check the service:   sudo systemctl status crow-gateway"
  echo "    2. Read its last lines: sudo journalctl -u crow-gateway -n 50"
  echo "    3. Fix what they show, then run the installer again."
  return 1
}

# ─── Automatic security updates (security audit K6) ──────
# The installer writes ONE apt configuration file of its own
# (52crow-unattended-upgrades) and never edits the distribution's
# 50unattended-upgrades: our file only ADDS the origins of the repositories this
# installer wired up (NodeSource, Docker, cloudsmith/Caddy), so a security fix
# for Node, Docker or Caddy installs itself exactly like the distribution's own
# security updates do. Automatic reboots stay OFF, and nothing here restarts a
# service — a Docker or Node security update may bounce its own service for a
# moment, and the Crow's Nest says when a reboot is still owed (the "System
# updates" health card).
#
# The apt.conf.d directory and the two privileged commands are test seams: the
# suite runs this step against a scratch directory with shims, so it can never
# touch the real /etc/apt. The defaults are the real ones.
APT_CONF_DIR="${APT_CONF_DIR:-/etc/apt/apt.conf.d}"
CROW_SUDO="${CROW_SUDO:-sudo}"
CROW_APT="${CROW_APT:-apt}"

sudo_cmd() { # <cmd> [args…]
  # Word-split on purpose: the seam may carry flags too (e.g. "sudo -n").
  # shellcheck disable=SC2086
  $CROW_SUDO "$@"
}
apt_install() { # <package> [packages…] — the same `-y` style as the rest of the script
  sudo_cmd "$CROW_APT" install -y "$@"
}

# write_crow_apt_conf — Crow's own origins file. Idempotent: a re-run that would
# write identical bytes does nothing (so the file's mtime, and any dpkg state,
# stays untouched). The content is built in a temp file first and only then
# installed with mode 644, so nothing under /etc/apt is opened for a partial
# write by us.
write_crow_apt_conf() {
  local dest="$APT_CONF_DIR/52crow-unattended-upgrades" tmp
  tmp="$(mktemp)"
  # Quoted heredoc: ${distro_codename} is an apt variable that UNATTENDED-UPGRADES
  # (not apt) substitutes when it reads the origins, so it must land literally
  # (and `set -u` would choke on it).
  cat > "$tmp" << 'CROWAPTEOF'
// Written by the Crow installer. Remove this file to stop Crow's additions;
// see https://maestro.press/software/crow/guide/auto-update#system-updates
// for turning automatic updates off.
Unattended-Upgrade::Origins-Pattern {
    "origin=. nodistro,codename=nodistro";
    "origin=Docker,archive=${distro_codename}";
    "origin=cloudsmith/caddy/stable,codename=any-version";
};
Unattended-Upgrade::Automatic-Reboot "false";
CROWAPTEOF
  if [ -r "$dest" ] && cmp -s "$tmp" "$dest"; then
    rm -f "$tmp"
    log "Automatic security updates already configured ($dest unchanged)"
    return 0
  fi
  sudo_cmd install -m 644 "$tmp" "$dest"
  rm -f "$tmp"
  log "Automatic security updates configured: system, Node, Docker and Caddy ($dest)"
}

# write_auto_upgrades_conf — the distro's periodic switch. Written ONLY when it
# does not exist: on a host that already configured unattended-upgrades (or ran
# dpkg-reconfigure), the operator's periodic settings are not overruled.
write_auto_upgrades_conf() {
  local dest="$APT_CONF_DIR/20auto-upgrades" tmp
  if [ -e "$dest" ]; then
    log "$dest already exists — left as it is"
    return 0
  fi
  tmp="$(mktemp)"
  cat > "$tmp" << 'CROWAPTEOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CROWAPTEOF
  sudo_cmd install -m 644 "$tmp" "$dest"
  rm -f "$tmp"
  log "Daily automatic security updates enabled ($dest)"
}

# install_auto_updates — the whole step. Never restarts a service and never
# reboots; both are the operator's call (the Nest shows when a reboot is owed).
install_auto_updates() {
  if [ "$AUTO_UPDATES" != true ]; then
    warn "Automatic security updates skipped (--no-auto-updates)"
    return 0
  fi
  apt_install unattended-upgrades
  write_crow_apt_conf
  write_auto_upgrades_conf
}

# Test seam: tests source the helpers without executing the install.
if [ "${CROW_INSTALL_SOURCE_ONLY:-}" = "1" ]; then
  # shellcheck disable=SC2317  # exit IS reachable: `return` fails when the
  # script is executed (not sourced), and the fallback exit then runs.
  return 0 2>/dev/null || exit 0
fi

# Platform gate (Item 4-PR5): refuse non-Debian/Ubuntu hosts before ANY
# system mutation — a half-install on the wrong distro is worse than none.
# shellcheck disable=SC2119  # defaults (real /etc/os-release, apt-get) are intended here
if ! check_platform; then
  error "Unsupported platform: this installer supports Debian/Ubuntu family systems only"
  error "(Debian, Ubuntu, Raspberry Pi OS, and derivatives — it installs via apt)."
  error "For macOS, Windows, or other Linux distributions, follow the manual setup"
  error "path in docs/getting-started/ (https://github.com/kh0pper/crow/tree/main/docs/getting-started)."
  exit 1
fi

# Check if running as root (we don't want that)
if [ "$(id -u)" -eq 0 ]; then
  error "Don't run this script as root. Run as your normal user."
  error "The script will use sudo when it needs elevated privileges."
  exit 1
fi

# Check for sudo
if ! command -v sudo >/dev/null 2>&1; then
  error "sudo is required. Install it first: su -c 'apt install sudo'"
  exit 1
fi

header "Crow Installer"

echo ""
echo "  Requires a Debian/Ubuntu family system (installs via apt)."
echo ""
echo "  This script will install:"
echo "    - Node.js ${NODE_MAJOR}"
echo "    - Docker + Docker Compose"
echo "    - Caddy (reverse proxy)"
echo "    - Crow"
echo "    - Automatic security updates (unattended-upgrades, reboots stay manual)"
echo "    - Security hardening (UFW + fail2ban)"
echo "    - Tailscale (offered if not installed — secure remote access)"
echo "    - Tailscale hostname setup (if Tailscale is installed)"
echo ""
if ! ask_yn "Continue?" Y; then
  echo "  Cancelled."
  exit 0
fi

# ─── Pre-flight: ports 3001, 80, 443 ─────────────────────
# Before anything is installed or started: if another program already owns one
# of the ports Crow binds, stop now with a sentence the operator can act on
# instead of half-finishing an install that nothing can reach.
header "Pre-flight: ports 3001, 80 and 443"
if ! check_ports_free; then
  exit 1
fi
log "Ports 3001, 80 and 443 are available"

# ─── Step 1: System updates ──────────────────────────────

header "Step 1/10: System Updates"

sudo apt update
sudo apt upgrade -y
log "System updated"

# ─── Step 2: Install Node.js ─────────────────────────────

header "Step 2/10: Node.js ${NODE_MAJOR}"

if command -v node >/dev/null 2>&1; then
  CURRENT_NODE=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$CURRENT_NODE" -ge "$NODE_MAJOR" ]; then
    log "Node.js $(node --version) already installed"
  else
    warn "Node.js $(node --version) is too old, upgrading..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | sudo -E bash -
    sudo apt install -y nodejs
    log "Node.js $(node --version) installed"
  fi
else
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | sudo -E bash -
  sudo apt install -y nodejs
  log "Node.js $(node --version) installed"
fi

# libatomic is needed by rocksdb-native's prebuilt addon (pulled in through
# hyperswarm); minimal server and cloud images do not ship it. Installed here,
# on both Node paths, before any dependency install runs.
sudo apt install -y libatomic1

# ─── Step 3: Install Docker ──────────────────────────────

header "Step 3/10: Docker"

if command -v docker >/dev/null 2>&1; then
  log "Docker already installed: $(docker --version)"
else
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  log "Docker installed"
fi

# ─── Step 4: Install Caddy ───────────────────────────────

header "Step 4/10: Caddy"

if command -v caddy >/dev/null 2>&1; then
  log "Caddy already installed: $(caddy version)"
else
  sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt update
  sudo apt install -y caddy
  log "Caddy installed"
fi

# The gateway's dedicated proxy socket (the security audit's finding) is owned
# by systemd, not by the gateway: crow-gateway-proxy.socket listens on
# /run/crow-proxy/gateway.sock as root:caddy with mode 0660, and the gateway
# receives that listening fd by socket activation. Caddy runs as the 'caddy'
# service user, which is why the socket's group is 'caddy' — no user is added to
# anybody's group, so Caddy never gains access to the operator's files.
if ! id caddy >/dev/null 2>&1 || ! getent group caddy >/dev/null 2>&1; then
  error "the 'caddy' user/group is missing — the proxy socket unit needs SocketGroup=caddy"
  exit 1
fi

# ─── Step 5: Automatic security updates ─────────────────
# Placed AFTER Docker and Caddy so their apt repositories exist: their origins
# are the three this step adds to unattended-upgrades (see install_auto_updates
# above). Nothing here restarts a service or reboots.
#
# From here on apt-daily-upgrade.timer can already be holding the dpkg lock when
# the remaining steps install a package, so every later apt call passes
# `-o DPkg::Lock::Timeout=300`: apt waits for the timer instead of taking the
# lock error and, under `set -e`, stopping the install. Keeping this step here
# (rather than moving it to the end) leaves it next to the repositories it names;
# the three later calls are the only apt calls left after it.

header "Step 5/10: Automatic Security Updates"

install_auto_updates

# ─── Step 6: Install Avahi (mDNS for crow.local) ─────────

header "Step 6/10: mDNS (crow.local)"

if dpkg -l avahi-daemon >/dev/null 2>&1; then
  log "Avahi already installed"
else
  sudo apt install -y -o DPkg::Lock::Timeout=300 avahi-daemon
  log "Avahi installed"
fi

# Set hostname to 'crow' for crow.local resolution
CURRENT_HOSTNAME=$(hostname)
if [ "$CURRENT_HOSTNAME" != "crow" ]; then
  # Renaming the machine is destructive under automation (F-INSTALL-11):
  # default NO, headless never renames. When skipped, Caddy serves
  # <hostname>.local instead of crow.local (below).
  if ask_yn "Set hostname to 'crow' (enables crow.local)?" N; then
    sudo hostnamectl set-hostname crow
    log "Hostname set to 'crow' — accessible as crow.local on your network"
  else
    warn "Keeping hostname '$CURRENT_HOSTNAME' — Crow will be at https://${CURRENT_HOSTNAME}.local"
  fi
fi
MDNS_HOST="$(hostname).local"

# ─── Step 7: Clone and Setup Crow ────────────────────────

header "Step 7/10: Crow Platform"

mkdir -p "$CROW_HOME"

if [ -d "$CROW_APP" ]; then
  log "Crow already cloned at $CROW_APP"
  cd "$CROW_APP"
  git pull --ff-only 2>/dev/null || warn "Could not pull latest — continuing with existing version"
else
  git clone https://github.com/kh0pper/crow.git "$CROW_APP"
  log "Cloned Crow to $CROW_APP"
  cd "$CROW_APP"
fi

# Set environment for ~/.crow/data
mkdir -p "$CROW_DATA"
export CROW_DATA_DIR="$CROW_DATA"

npm run setup
log "Crow setup complete"

# Generate identity
npm run identity 2>/dev/null || true
log "Identity generated"

# Create .env with secure permissions
if [ ! -f "$CROW_HOME/.env" ]; then
  cp .env.example "$CROW_HOME/.env"
  chmod 600 "$CROW_HOME/.env"
  # Point CROW_DB_PATH to the right place
  sed -i "s|CROW_DB_PATH=./data/crow.db|CROW_DB_PATH=$CROW_DATA/crow.db|" "$CROW_HOME/.env"
  log "Created $CROW_HOME/.env (permissions 600)"
fi

# Symlink .env into app directory
if [ ! -L "$CROW_APP/.env" ]; then
  ln -sf "$CROW_HOME/.env" "$CROW_APP/.env"
fi

# ─── Step 8: Security Hardening ──────────────────────────
# The firewall comes UP BEFORE any Crow unit is enabled or started (security
# audit N1c-15): a half-finished install — or the seconds between starting the
# gateway and closing its port — must never be reachable. Nothing here needs
# Crow running; ufw-docker only needs Docker (Step 3).
# Scope: "nothing listens before the firewall" is a claim about Crow's own units;
# `apt install caddy` (Step 4) starts Caddy's default site on :80/:443 itself.

header "Step 8/10: Security"

# UFW firewall
if command -v ufw >/dev/null 2>&1; then
  log "UFW already installed"
else
  sudo apt install -y -o DPkg::Lock::Timeout=300 ufw
fi

sudo ufw default deny incoming
sudo ufw default allow outgoing
# SSH is allowed FIRST and unconditionally: `ufw --force enable` two blocks down
# would cut a remote operator's session the instant it ran if the port that
# session arrived on were not open. 22 is the always-safe rule; ssh_ports adds
# any other port this host's sshd is actually configured for.
sudo ufw allow 22/tcp comment 'SSH'
# shellcheck disable=SC2119  # no args on purpose: the helper defaults to this host's sshd config
SSH_EXTRA_PORTS="$(ssh_ports)"
while IFS= read -r _ssh_port; do
  if [ -z "$_ssh_port" ] || [ "$_ssh_port" = "22" ]; then continue; fi
  sudo ufw allow "${_ssh_port}/tcp" comment 'SSH'
done <<< "$SSH_EXTRA_PORTS"

# 443 serves only Caddy's LAN vhost (https://${MDNS_HOST}); on a cloud VM
# that is an unintended PUBLIC surface (F-INSTALL-2). Cloud heuristic: the
# link-local metadata endpoint answers on AWS/Oracle/GCP/Azure/DO and never
# on home LANs. (Local-address checks don't work — Oracle NATs a private IP.)
IS_CLOUD_HOST=false
if curl -s -m 2 -o /dev/null http://169.254.169.254/ 2>/dev/null; then
  IS_CLOUD_HOST=true
fi
OPEN_443_DEFAULT=Y
if [ "$IS_CLOUD_HOST" = true ]; then
  OPEN_443_DEFAULT=N
  warn "Cloud/VPS environment detected — opening 443 would expose it to the internet."
fi
if ask_yn "Open port 443 for LAN access to https://${MDNS_HOST}?" "$OPEN_443_DEFAULT"; then
  sudo ufw allow 443/tcp comment 'HTTPS (Caddy)'
  log "Port 443 open (LAN HTTPS via Caddy)"
else
  warn "Port 443 closed — use Tailscale for remote access"
fi

sudo ufw --force enable
log "Firewall enabled"

# Install ufw-docker to fix Docker/UFW conflict
if [ ! -f /usr/local/bin/ufw-docker ]; then
  sudo curl -fsSL https://github.com/chaifeng/ufw-docker/raw/master/ufw-docker -o /usr/local/bin/ufw-docker
  sudo chmod +x /usr/local/bin/ufw-docker
  sudo ufw-docker install
  log "ufw-docker installed (Docker/UFW conflict resolved)"
else
  log "ufw-docker already installed"
fi

# Fail2ban
if command -v fail2ban-client >/dev/null 2>&1; then
  log "fail2ban already installed"
else
  sudo apt install -y -o DPkg::Lock::Timeout=300 fail2ban
  sudo systemctl enable --now fail2ban
  log "fail2ban installed and enabled"
fi

# ─── Step 9: Configure Services ──────────────────────────
# Only now, with the firewall already up, are the units written and started.

header "Step 9/10: System Services"

# The gateway's proxy socket — SYSTEMD owns it, as root:caddy 0660, so only the
# local Caddy can open it. A loopback dial carrying X-Forwarded-For from
# anywhere else (a bot running as the gateway's own user included) stays an
# unverifiable peer, and the gateway never creates, chmods or unlinks the path.
# Enable and start it BEFORE the gateway, which receives its fd by activation.
sudo tee /etc/systemd/system/crow-gateway-proxy.socket > /dev/null << 'SOCKETEOF'
[Unit]
Description=Crow gateway proxy socket (for the local Caddy only)
[Socket]
ListenStream=/run/crow-proxy/gateway.sock
Service=crow-gateway.service
SocketUser=root
SocketGroup=caddy
SocketMode=0660
DirectoryMode=0755
[Install]
WantedBy=sockets.target
SOCKETEOF

# The boot guard's launcher, installed OUTSIDE the checkout (audit N1c-3 L1):
# the unit below runs it before every start, and any gateway that stays up for
# ten minutes refreshes this copy from its own commit.
mkdir -p "$CROW_HOME/boot-guard"
chmod 700 "$CROW_HOME/boot-guard"
install -m 600 scripts/boot-guard/crow-boot-guard.mjs "$CROW_HOME/boot-guard/crow-boot-guard.mjs"
log "Boot guard installed at $CROW_HOME/boot-guard"

# Crow Gateway systemd service
sudo tee /etc/systemd/system/crow-gateway.service > /dev/null << EOF
[Unit]
Description=Crow Gateway
Wants=network-online.target
After=network-online.target docker.service tailscaled.service
After=crow-gateway-proxy.socket
Requires=docker.service
# The dedicated proxy socket Caddy dials (the security audit's finding): a
# loopback connection carrying X-Forwarded-For is unverifiable (any local
# process can write the same header), so Caddy's visitors would be turned away
# by the dashboard's network gate. CROW_TRUSTED_PROXIES=loopback is not the fix
# (it makes every same-box caller the proxy and breaks the loopback-only doors).
# systemd owns the socket (root:caddy 0660) and passes this service its
# listening fd by socket activation — see the socket unit above (Sockets= is
# a [Service] key; Requires=/After= stay here).
Requires=crow-gateway-proxy.socket

[Service]
Sockets=crow-gateway-proxy.socket
Type=simple
User=$USER
WorkingDirectory=$CROW_APP
ExecStart=$(which node) servers/gateway/index.js
# Audit N1c-3 Layer 1: the boot guard. It runs before EVERY start (including
# every automatic restart) and counts real crash exits; after three of them it
# moves main back to the last commit this host booted, so a commit that throws
# while loading is never a forever crash loop. It is executed from
# $CROW_HOME/boot-guard/, a copy OUTSIDE this checkout, because the failing
# commit's own copy cannot be trusted to roll itself back. The '-' prefix keeps
# a guard failure from blocking the start, and TimeoutStartSec covers the
# guard's own npm install (up to 5 minutes) plus a rollback. Every path is
# quoted (a home directory may contain a space) and a literal % is escaped as
# %%, or systemd reads it as a specifier and the guard never starts.
ExecStartPre=-$(sd_quote "$(which node)") $(sd_quote "$CROW_HOME/boot-guard/crow-boot-guard.mjs") --app-root $(sd_quote "$CROW_APP")
ExecStopPost=-$(sd_quote "$(which node)") $(sd_quote "$CROW_HOME/boot-guard/crow-boot-guard.mjs") --app-root $(sd_quote "$CROW_APP") --record-exit
TimeoutStartSec=15min
Environment=CROW_BOOT_GUARD=1
Restart=on-failure
RestartSec=5
# 78 = refused instance paths (servers/shared/crow-home.js): a config error, not a crash
RestartPreventExitStatus=78
Environment=NODE_ENV=production
Environment=$(sd_quote "CROW_HOME=$CROW_HOME")
Environment=$(sd_quote "CROW_DATA_DIR=$CROW_DATA")
Environment=$(sd_quote "CROW_DB_PATH=$CROW_DATA/crow.db")

[Install]
WantedBy=multi-user.target
EOF

# Caddy reverse proxy with self-signed cert for the actual hostname.
# Caddy dials the gateway's dedicated proxy socket (the security audit's
# finding) rather than loopback: on a unix socket the gateway can tell Caddy's
# visitors apart from any other same-box caller and classifies them `proxy` with
# the client Caddy names. Caddy 2 ignores a client-sent X-Forwarded-For unless
# trusted_proxies is configured, so the rightmost hop it sends is the real client.
sudo tee /etc/caddy/Caddyfile > /dev/null << EOF
${MDNS_HOST} {
    tls internal
    reverse_proxy unix//run/crow-proxy/gateway.sock
}
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now crow-gateway-proxy.socket
sudo systemctl enable crow-gateway
# restart, not enable --now: a re-run must hand a running gateway the socket's fd
sudo systemctl restart crow-gateway
sudo systemctl restart caddy
log "Gateway service enabled and started"
log "Caddy configured for https://${MDNS_HOST}"

# ─── Step 10: Tailscale Hostname ──────────────────────────

header "Step 10/10: Tailscale (Remote Access)"

if command -v tailscale &>/dev/null; then
  log "Tailscale is installed"

  if tailscale status &>/dev/null; then
    log "Tailscale is authenticated"

    # Capture status JSON ONCE — never pipe it (F-INSTALL-6).
    TS_JSON="$(tailscale status --json 2>/dev/null || true)"
    CURRENT_TS_HOSTNAME="$(ts_first_field HostName)"

    if [ "$CURRENT_TS_HOSTNAME" = "crow" ]; then
      log "Tailscale hostname is already set to 'crow'"
    elif [[ $TS_JSON =~ \"HostName\"[[:space:]]*:[[:space:]]*\"crow\" ]]; then
      warn "Tailscale hostname 'crow' is already taken by another device on your tailnet."
      TS_HOSTNAME="$(ask_line "Enter a Tailscale hostname (or press Enter to skip): ")"
      if [ -n "$TS_HOSTNAME" ]; then
        sudo tailscale set --hostname="$TS_HOSTNAME"
        log "Tailscale hostname set to '$TS_HOSTNAME'"
      else
        warn "Skipped Tailscale hostname setup"
      fi
    else
      # Destructive rename: default NO; headless installs never rename
      # (F-INSTALL-7 — the old default-Y renamed fresh nodes to 'crow').
      if ask_yn "Set Tailscale hostname to 'crow'?" N; then
        sudo tailscale set --hostname=crow
        log "Tailscale hostname set to 'crow'"
      else
        warn "Keeping Tailscale hostname '${CURRENT_TS_HOSTNAME:-unknown}'"
      fi
    fi

    # ── F-INSTALL-1: wire Tailscale Serve so the dashboard is reachable over
    # the tailnet with real HTTPS (and the gateway gets an HTTPS issuer URL —
    # without it a cloud install has NO reachable dashboard at all).
    # Serve is tailnet-only; this never touches Funnel (public exposure).
    GATEWAY_HTTPS_URL=""
    TS_DNSNAME="$(ts_first_field DNSName)"
    TS_DNSNAME="${TS_DNSNAME%.}"   # strip trailing dot
    if [ -n "$TS_DNSNAME" ]; then
      if ask_yn "Serve the dashboard at https://${TS_DNSNAME}/ (tailnet-only, recommended)?" Y; then
        if sudo tailscale serve --bg --https=443 http://127.0.0.1:3001 >/dev/null 2>&1; then
          GATEWAY_HTTPS_URL="https://${TS_DNSNAME}"
          log "Tailscale Serve wired: ${GATEWAY_HTTPS_URL}/ → localhost:3001 (tailnet only)"
          if grep -q '^CROW_GATEWAY_URL=' "$CROW_HOME/.env" 2>/dev/null; then
            sed -i "s|^CROW_GATEWAY_URL=.*|CROW_GATEWAY_URL=${GATEWAY_HTTPS_URL}|" "$CROW_HOME/.env"
          else
            printf '\nCROW_GATEWAY_URL=%s\n' "$GATEWAY_HTTPS_URL" >> "$CROW_HOME/.env"
          fi
          if sudo systemctl restart crow-gateway; then
            log "CROW_GATEWAY_URL=${GATEWAY_HTTPS_URL} written to $CROW_HOME/.env (gateway restarted)"
          else
            warn "Gateway restart failed — restart manually: sudo systemctl restart crow-gateway"
          fi
        else
          warn "tailscale serve failed — wire it later: sudo tailscale serve --bg --https=443 http://127.0.0.1:3001"
        fi
      else
        warn "Skipped Tailscale Serve — remote HTTPS access not configured"
      fi
    fi
  else
    warn "Tailscale is installed but not authenticated"
    warn "Run 'sudo tailscale up' to log in, then re-run this step"
  fi
else
  echo ""
  warn "Tailscale is not installed"
  # Item 4-PR5: offer the official installer. Default Y is safe headlessly —
  # installing is additive and inert until `sudo tailscale up` (no tailnet
  # mutation without authentication; contrast the rename prompts, default N).
  if ask_yn "Install Tailscale now (recommended for secure remote access)?" Y; then
    if curl -fsSL https://tailscale.com/install.sh | sudo sh; then
      log "Tailscale installed"
      warn "Tailscale is installed but not authenticated"
      warn "Run 'sudo tailscale up' to log in, then re-run this script to wire the hostname + HTTPS dashboard"
    else
      warn "Tailscale install failed — install manually later: https://tailscale.com/download"
    fi
  else
    echo "  Tip: Install Tailscale for secure remote access."
    echo "  See docs/getting-started/tailscale-setup.md"
  fi
  echo ""
fi

# ─── Verification ─────────────────────────────────────────

header "Verification"

# The health check decides how this run ends. It fails → this exits 1 HERE, so
# the "Crow is ready!" banner further down is unreachable (security audit
# N1c-15: the installer printed that banner, and exited 0, over a gateway that
# never answered). verify_gateway names the three commands that show the cause.
if ! verify_gateway; then
  echo ""
  echo "  Installation incomplete — fix the cause above, then run the installer again."
  echo ""
  exit 1
fi

# ─── Done ─────────────────────────────────────────────────

# Belt and braces: any `error` at all (a failed service check included) also
# withholds the banner, because a claim that Crow is ready must be true.
if install_failed; then
  header "Installation Incomplete"
  echo ""
  echo "  Crow is not ready: ${INSTALL_ERRORS} check(s) above failed."
  echo "  Fix what they show, then run the installer again."
  echo ""
  exit 1
fi

header "Installation Complete"

echo ""
echo "  Crow is ready!"
echo ""

# First-run setup link. While no dashboard password exists the gateway writes a
# one-time token to $CROW_HOME/setup-token (mode 0600, readable only by this
# account) and every first-run path demands it from anything but the machine
# itself, so a neighbour on the same LAN cannot claim this Crow first.
SETUP_TOKEN_FILE="$CROW_HOME/setup-token"
SETUP_TOKEN=""
if [ -r "$SETUP_TOKEN_FILE" ]; then
  SETUP_TOKEN="$(cat "$SETUP_TOKEN_FILE" 2>/dev/null || true)"
fi
# The token is base64url (A-Z a-z 0-9 - _), so it needs no quoting inside a URL.
SETUP_QS=""
if [ -n "$SETUP_TOKEN" ]; then
  SETUP_QS="?token=${SETUP_TOKEN}"
fi

# Has this Crow already been set up? Two signals together: no token file (it is
# deleted with the first password) AND the gateway redirecting /setup to the
# login page, which setup-page.js does only once a password exists. Status 302
# from /setup is the simplest reliable one; a missing 302 (gated page, or no
# answer) leaves the first-run message in place.
SETUP_DONE=false
if [ ! -r "$SETUP_TOKEN_FILE" ]; then
  SETUP_STATUS="$(curl -sS -m 3 -o /dev/null -w '%{http_code}' http://localhost:3001/setup 2>/dev/null || true)"
  if [ "$SETUP_STATUS" = "302" ]; then
    SETUP_DONE=true
  fi
fi

if [ "$IS_CLOUD_HOST" = true ] && [ -z "${GATEWAY_HTTPS_URL:-}" ]; then
  echo "  This is a cloud server: ${MDNS_HOST} is not reachable from your browser."
  echo "  Open an SSH tunnel from your own computer, then browse to http://localhost:3001/setup${SETUP_QS} :"
  echo "    ssh -L 3001:localhost:3001 ${USER}@<this-server's-public-IP>"
  echo "  (Or re-run this installer and accept Tailscale Serve for a permanent URL.)"
  SIGNIN_URL="http://localhost:3001/dashboard/login   (through the SSH tunnel)"
else
  echo "  Open in your browser:"
  echo "    https://${MDNS_HOST}/setup${SETUP_QS}"
  SIGNIN_URL="https://${MDNS_HOST}/dashboard/login"
  if [ -n "${GATEWAY_HTTPS_URL:-}" ]; then
    echo "    ${GATEWAY_HTTPS_URL}/setup${SETUP_QS}   (any device on your tailnet)"
    SIGNIN_URL="${GATEWAY_HTTPS_URL}/dashboard/login"
  fi
fi
echo ""
if [ "$SETUP_DONE" = true ]; then
  echo "  Setup is already done; sign in at:"
  echo "    ${SIGNIN_URL}"
else
  if [ -n "$SETUP_TOKEN" ]; then
    echo "  That link works once, and anyone who has it can claim this Crow — don't share it."
  else
    echo "  The one-time setup token is not written yet. The gateway saves it to:"
    echo "    ${SETUP_TOKEN_FILE}"
    echo "  Read it on this machine and add it to the URL as ?token=<that value>."
  fi
  echo "  Opening the setup page on this machine itself (http://localhost:3001/setup)"
  echo "  needs no token."
fi
echo ""
echo "  Everything else happens there — the setup wizard walks you through"
echo "  passwords, your AI model, and connecting devices."
echo ""

# Add crow CLI to PATH if not already there
if ! grep -q "crow/scripts" "$HOME/.bashrc" 2>/dev/null; then
  echo "export PATH=\"\$PATH:$CROW_APP/scripts\"" >> "$HOME/.bashrc"
  log "Added 'crow' command to PATH (restart shell or run: source ~/.bashrc)"
fi
