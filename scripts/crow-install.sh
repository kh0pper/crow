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

set -euo pipefail

CROW_HOME="$HOME/.crow"
CROW_APP="$CROW_HOME/app"
CROW_DATA="$CROW_HOME/data"
NODE_MAJOR=20

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn()  { echo -e "  ${YELLOW}!${NC} $1"; }
error() { echo -e "  ${RED}✗${NC} $1"; }
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
for _arg in "$@"; do
  case "$_arg" in
    -y|--yes) ASSUME_YES=true ;;
  esac
done
if [ "${CROW_INSTALL_YES:-}" = "1" ]; then ASSUME_YES=true; fi

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
echo "    - Security hardening (UFW + fail2ban)"
echo "    - Tailscale (offered if not installed — secure remote access)"
echo "    - Tailscale hostname setup (if Tailscale is installed)"
echo ""
if ! ask_yn "Continue?" Y; then
  echo "  Cancelled."
  exit 0
fi

# ─── Step 1: System updates ──────────────────────────────

header "Step 1/9: System Updates"

sudo apt update
sudo apt upgrade -y
log "System updated"

# ─── Step 2: Install Node.js ─────────────────────────────

header "Step 2/9: Node.js ${NODE_MAJOR}"

if command -v node >/dev/null 2>&1; then
  CURRENT_NODE=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$CURRENT_NODE" -ge 18 ]; then
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

# ─── Step 3: Install Docker ──────────────────────────────

header "Step 3/9: Docker"

if command -v docker >/dev/null 2>&1; then
  log "Docker already installed: $(docker --version)"
else
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  log "Docker installed"
  warn "You may need to log out and back in for Docker group to take effect"
fi

# ─── Step 4: Install Caddy ───────────────────────────────

header "Step 4/9: Caddy"

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

# ─── Step 5: Install Avahi (mDNS for crow.local) ─────────

header "Step 5/9: mDNS (crow.local)"

if dpkg -l avahi-daemon >/dev/null 2>&1; then
  log "Avahi already installed"
else
  sudo apt install -y avahi-daemon
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

# ─── Step 6: Clone and Setup Crow ────────────────────────

header "Step 6/9: Crow Platform"

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

# ─── Step 7: Configure Services ──────────────────────────

header "Step 7/9: System Services"

# Crow Gateway systemd service
sudo tee /etc/systemd/system/crow-gateway.service > /dev/null << EOF
[Unit]
Description=Crow Gateway
Wants=network-online.target
After=network-online.target docker.service tailscaled.service
Requires=docker.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$CROW_APP
ExecStart=$(which node) servers/gateway/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=CROW_DATA_DIR=$CROW_DATA
Environment=CROW_DB_PATH=$CROW_DATA/crow.db

[Install]
WantedBy=multi-user.target
EOF

# Caddy reverse proxy with self-signed cert for the actual hostname
sudo tee /etc/caddy/Caddyfile > /dev/null << EOF
${MDNS_HOST} {
    tls internal
    reverse_proxy localhost:3001
}
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now crow-gateway
sudo systemctl restart caddy
log "Gateway service enabled and started"
log "Caddy configured for https://${MDNS_HOST}"

# ─── Step 8: Security Hardening ──────────────────────────

header "Step 8/9: Security"

# UFW firewall
if command -v ufw >/dev/null 2>&1; then
  log "UFW already installed"
else
  sudo apt install -y ufw
fi

sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'SSH'

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
  sudo apt install -y fail2ban
  sudo systemctl enable --now fail2ban
  log "fail2ban installed and enabled"
fi

# ─── Step 9: Tailscale Hostname ──────────────────────────

header "Step 9/9: Tailscale (Remote Access)"

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

# (a) Gateway service check
if systemctl is-active --quiet crow-gateway 2>/dev/null; then
  log "Gateway service: running"
else
  error "Gateway service is not running — check: journalctl -u crow-gateway -n 50"
fi

# (b) HTTP health probe — up to 10 attempts, 2s apart
GATEWAY_OK=false
for _ in $(seq 1 10); do
  if curl -fsS -o /dev/null http://localhost:3001/health 2>/dev/null; then
    GATEWAY_OK=true
    break
  fi
  sleep 2
done

if [ "$GATEWAY_OK" = true ]; then
  log "Gateway responding at http://localhost:3001"
else
  error "Gateway did not respond at http://localhost:3001 after 10 attempts"
  error "Check the logs: journalctl -u crow-gateway -n 50"
fi

# ─── Done ─────────────────────────────────────────────────

header "Installation Complete"

echo ""
echo "  Crow is ready!"
echo ""
echo "  Open in your browser:"
echo "    https://${MDNS_HOST}/setup"
if [ -n "${GATEWAY_HTTPS_URL:-}" ]; then
  echo "    ${GATEWAY_HTTPS_URL}/setup   (any device on your tailnet)"
fi
echo ""
echo "  What's next:"
echo "    1. Set your Crow's Nest password at /setup"
echo "    2. Add API keys to $CROW_HOME/.env"
echo "    3. Headless MCP token:  cd $CROW_APP && npm run local-token"
echo "    4. Restart gateway: sudo systemctl restart crow-gateway"
echo "    5. Connect your AI platform (Claude, ChatGPT, etc.)"
echo ""
echo "  Useful commands:"
echo "    crow status             — Platform status"
echo "    crow bundle install <x> — Install an add-on"
echo "    sudo systemctl status crow-gateway — Gateway logs"
echo ""
echo "  Tip: run 'crow status' to verify everything is healthy."
echo ""

# Add crow CLI to PATH if not already there
if ! grep -q "crow/scripts" "$HOME/.bashrc" 2>/dev/null; then
  echo "export PATH=\"\$PATH:$CROW_APP/scripts\"" >> "$HOME/.bashrc"
  log "Added 'crow' command to PATH (restart shell or run: source ~/.bashrc)"
fi
