#!/usr/bin/env bash

# Crow — Installer Script
#
# Transforms a stock Raspberry Pi OS (or any Debian/Ubuntu) into a Crow appliance.
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
echo "  This script will install:"
echo "    - Node.js ${NODE_MAJOR}"
echo "    - Docker + Docker Compose"
echo "    - Caddy (reverse proxy)"
echo "    - Crow"
echo "    - Security hardening (UFW + fail2ban)"
echo "    - Tailscale hostname setup (if Tailscale is installed)"
echo ""
read -p "  Continue? [Y/n] " -n 1 -r
echo
if [[ $REPLY =~ ^[Nn]$ ]]; then
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
  read -p "  Set hostname to 'crow' (enables crow.local)? [Y/n] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    sudo hostnamectl set-hostname crow
    log "Hostname set to 'crow' — accessible as crow.local on your network"
  fi
fi

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
export CROW_DATA_DIR="$CROW_DATA"

npm run setup
log "Crow setup complete"

# Generate identity
mkdir -p "$CROW_DATA"
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
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$CROW_APP
ExecStart=$(which node) servers/gateway/index.js
Restart=unless-stopped
RestartSec=5
Environment=NODE_ENV=production
Environment=CROW_DATA_DIR=$CROW_DATA
Environment=CROW_DB_PATH=$CROW_DATA/crow.db

[Install]
WantedBy=multi-user.target
EOF

# Caddy reverse proxy with self-signed cert for crow.local
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
crow.local {
    tls internal
    reverse_proxy localhost:3001
}
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now crow-gateway
sudo systemctl restart caddy
log "Gateway service enabled and started"
log "Caddy configured for https://crow.local"

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
sudo ufw allow 443/tcp comment 'HTTPS (Caddy)'
echo "y" | sudo ufw enable
log "Firewall enabled (SSH + HTTPS only)"

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

    # Check if 'crow' hostname is already taken on the tailnet
    CROW_HOSTNAME_TAKEN=false
    CURRENT_TS_HOSTNAME=$(tailscale status --json 2>/dev/null | grep -o '"HostName":"[^"]*"' | head -1 | cut -d'"' -f4)

    if [ "$CURRENT_TS_HOSTNAME" = "crow" ]; then
      log "Tailscale hostname is already set to 'crow'"
    else
      # Check if another device on the tailnet is using 'crow'
      if tailscale status --json 2>/dev/null | grep -q '"HostName":"crow"'; then
        CROW_HOSTNAME_TAKEN=true
      fi

      if [ "$CROW_HOSTNAME_TAKEN" = true ]; then
        warn "Tailscale hostname 'crow' is already taken by another device on your tailnet."
        SUGGESTED="crow-$(hostname)"
        echo ""
        echo "  Suggested alternatives:"
        echo "    - crow-2"
        echo "    - $SUGGESTED"
        echo ""
        read -p "  Enter a Tailscale hostname (or press Enter to skip): " TS_HOSTNAME
        echo
        if [ -n "$TS_HOSTNAME" ]; then
          sudo tailscale set --hostname="$TS_HOSTNAME"
          log "Tailscale hostname set to '$TS_HOSTNAME' — access Crow at http://$TS_HOSTNAME/"
        else
          warn "Skipped Tailscale hostname setup"
        fi
      else
        echo ""
        echo "  Would you like to set this machine's Tailscale hostname to 'crow'?"
        echo "  This lets you access Crow at http://crow/ from any device on your Tailnet."
        echo ""
        read -p "  Set Tailscale hostname to 'crow'? [Y/n] " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Nn]$ ]]; then
          sudo tailscale set --hostname=crow
          log "Tailscale hostname set to 'crow' — access Crow at http://crow/ from your Tailnet"
        else
          warn "Skipped Tailscale hostname setup"
        fi
      fi
    fi
  else
    warn "Tailscale is installed but not authenticated"
    warn "Run 'sudo tailscale up' to log in, then re-run this step"
  fi
else
  echo ""
  warn "Tailscale is not installed"
  echo "  Tip: Install Tailscale for secure remote access."
  echo "  See docs/getting-started/tailscale-setup.md"
  echo ""
fi

# ─── Done ─────────────────────────────────────────────────

header "Installation Complete"

echo ""
echo "  Crow is ready!"
echo ""
echo "  Open in your browser:"
echo "    https://crow.local/setup"
echo ""
echo "  What's next:"
echo "    1. Set your dashboard password at /setup"
echo "    2. Add API keys to $CROW_HOME/.env"
echo "    3. Restart gateway: sudo systemctl restart crow-gateway"
echo "    4. Connect your AI platform (Claude, ChatGPT, etc.)"
echo ""
echo "  Useful commands:"
echo "    crow status             — Platform status"
echo "    crow bundle install <x> — Install an add-on"
echo "    sudo systemctl status crow-gateway — Gateway logs"
echo ""

# Add crow CLI to PATH if not already there
if ! grep -q "crow/scripts" "$HOME/.bashrc" 2>/dev/null; then
  echo "export PATH=\"\$PATH:$CROW_APP/scripts\"" >> "$HOME/.bashrc"
  log "Added 'crow' command to PATH (restart shell or run: source ~/.bashrc)"
fi
