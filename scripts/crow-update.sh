#!/usr/bin/env bash

# Crow Update Script
#
# Pulls latest code, installs dependencies, runs migrations, restarts services.
#
# Usage:
#   bash ~/.crow/app/scripts/crow-update.sh

set -euo pipefail

CROW_HOME="${CROW_DATA_DIR:-$HOME/.crow}"
CROW_APP="$CROW_HOME/app"
LOG_FILE="$CROW_HOME/update.log"

# Fall back to repo directory if not installed to ~/.crow/app
if [ ! -d "$CROW_APP" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  CROW_APP="$(dirname "$SCRIPT_DIR")"
fi

log() { echo "$(date -Iseconds) $1" | tee -a "$LOG_FILE"; }

log "Starting Crow update..."

cd "$CROW_APP"

# Save current ref for rollback
PREV_REF=$(git rev-parse HEAD)
log "Current version: ${PREV_REF:0:8}"

# Pull latest
if git pull --ff-only 2>&1 | tee -a "$LOG_FILE"; then
  NEW_REF=$(git rev-parse HEAD)
  log "Updated to: ${NEW_REF:0:8}"
else
  log "Warning: git pull failed (merge conflicts?). Continuing with current version."
fi

# Install new dependencies
log "Installing dependencies..."
npm install 2>&1 | tail -3 | tee -a "$LOG_FILE"

# Run database migrations
log "Running database migrations..."
npm run init-db 2>&1 | tee -a "$LOG_FILE"

# Restart gateway if running as systemd service
if systemctl is-active --quiet crow-gateway 2>/dev/null; then
  log "Restarting crow-gateway service..."
  sudo systemctl restart crow-gateway
  sleep 2
  if systemctl is-active --quiet crow-gateway; then
    log "Gateway restarted successfully."
  else
    log "ERROR: Gateway failed to restart. Rolling back..."
    git checkout "$PREV_REF"
    npm install
    sudo systemctl restart crow-gateway
    log "Rolled back to ${PREV_REF:0:8}"
    exit 1
  fi
else
  log "Gateway not running as systemd service — skip restart."
fi

log "Update complete."
echo ""
echo "  Previous: ${PREV_REF:0:8}"
echo "  Current:  $(git rev-parse HEAD | head -c 8)"
echo "  Log:      ${LOG_FILE}"
