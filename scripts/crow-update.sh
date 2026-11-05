#!/usr/bin/env bash

# Crow Update Script
#
# Pulls latest code, installs dependencies, runs migrations, restarts services.
#
# Usage:
#   bash ~/.crow/app/scripts/crow-update.sh
#
# The gateway's own updater (servers/gateway/auto-update.js) does the same thing
# on a timer and is the supported path; this script is the manual one. It
# follows the same rules, because a hand-run update must not leave an instance in
# a state the automatic path never produces:
#   - the rollback is `git reset --keep`, NEVER `git checkout`: a checkout
#     detaches HEAD, and the gateway then skips every update tick with "not on
#     main" — a rollback that silently stops all future updates;
#   - success is judged by the gateway ANSWERING (HTTP 200 on /health) and by the
#     restart counter NOT moving. `systemctl is-active` is useless for a
#     Type=simple unit: it reports active for a process that is about to crash
#     under Restart=on-failure.

set -euo pipefail

CROW_HOME="${CROW_DATA_DIR:-$HOME/.crow}"
CROW_APP="$CROW_HOME/app"
LOG_FILE="$CROW_HOME/update.log"
HEALTH_URL="${CROW_HEALTH_URL:-http://127.0.0.1:${PORT:-${CROW_GATEWAY_PORT:-3001}}/health}"
HEALTH_TIMEOUT_SECS="${CROW_HEALTH_TIMEOUT_SECS:-90}"

# Fall back to repo directory if not installed to ~/.crow/app
if [ ! -d "$CROW_APP" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  CROW_APP="$(dirname "$SCRIPT_DIR")"
fi

log() { echo "$(date -Iseconds) $1" | tee -a "$LOG_FILE"; }

# Systemd's own restart counter. Empty when the unit is not systemd-managed.
nrestarts() {
  systemctl show -p NRestarts --value crow-gateway 2>/dev/null || true
}

# 200 within the deadline. curl is present on every install the installer
# supports; wget is the fallback for minimal images.
wait_for_health() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECS ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if command -v curl >/dev/null 2>&1; then
      if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null || true)" = "200" ]; then
        return 0
      fi
    elif command -v wget >/dev/null 2>&1; then
      if wget -q -O /dev/null --timeout=5 "$HEALTH_URL" 2>/dev/null; then
        return 0
      fi
    else
      log "Neither curl nor wget is available — cannot verify $HEALTH_URL"
      return 1
    fi
    sleep 2
  done
  return 1
}

# Hooks disabled: on an install whose core.hooksPath points INTO the tree, the
# pulled sha's own hooks would otherwise run here.
rollback() {
  log "Rolling back to ${PREV_REF:0:8}..."
  git -c core.hooksPath=/dev/null reset --keep "$PREV_REF"
  npm install 2>&1 | tail -3 | tee -a "$LOG_FILE"
}

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
node scripts/guarded-init-db.mjs 2>&1 | tee -a "$LOG_FILE"

# Restart gateway if running as systemd service
if systemctl is-active --quiet crow-gateway 2>/dev/null; then
  BEFORE_NRESTARTS=$(nrestarts)
  log "Restarting crow-gateway service..."
  sudo systemctl restart crow-gateway

  if wait_for_health && [ "$(nrestarts)" = "$BEFORE_NRESTARTS" ]; then
    log "Gateway restarted successfully (health 200, no supervised restart)."
  else
    log "ERROR: the gateway did not come up on the new code (health 200 within ${HEALTH_TIMEOUT_SECS}s, NRestarts unchanged: failed). Rolling back..."
    rollback
    sudo systemctl restart crow-gateway
    if wait_for_health; then
      log "Rolled back to ${PREV_REF:0:8} — gateway healthy."
    else
      log "ERROR: the gateway is still not healthy after the rollback. See the gateway log; the automatic rollback guard will act on the next start."
    fi
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