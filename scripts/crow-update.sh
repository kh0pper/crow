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
# The helper scripts this script runs live next to it, so they come from the
# checkout being updated, not from the installed copy.
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"

# Hooks and fsmonitor off for every git command here: on an install whose
# core.hooksPath points INTO the tree, `pull` would run the INCOMING commit's own
# hooks as this user, before any check has seen the sha.
GIT_SAFE=(-c core.hooksPath=/dev/null -c core.fsmonitor=false)

# Fall back to repo directory if not installed to ~/.crow/app
if [ ! -d "$CROW_APP" ]; then
  CROW_APP="$(dirname "$SELF_DIR")"
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

# Every git command below runs through GIT_SAFE (hooks and fsmonitor off).
#
# Never lets a refusal end the script: under `set -e` an unguarded `git reset`
# or `npm` here would exit mid-rollback, leaving the crash-looping new commit
# running and nothing restarted or logged. A refusal is logged, flagged, and the
# caller still restarts the service and exits non-zero.
ROLLBACK_OK=1
# Whether the RESET itself moved the tree back (S4). The two failures are not the
# same: a tree back on PREV_REF whose npm install failed still needs the marker,
# while a reset that never moved the tree must not quarantine the sha (the boot
# guard owns the held marker for that case).
RESET_OK=1
rollback() {
  log "Rolling back to ${PREV_REF:0:8}..."
  if ! git "${GIT_SAFE[@]}" reset --keep "$PREV_REF" 2>&1 | tail -3 | tee -a "$LOG_FILE"; then
    log "ERROR: rollback refused — git reset --keep ${PREV_REF:0:8} failed (local changes overlap it?). The checkout is unchanged at $(git "${GIT_SAFE[@]}" rev-parse --short HEAD 2>/dev/null || echo unknown)."
    ROLLBACK_OK=0
    RESET_OK=0
  fi
  if ! npm install 2>&1 | tail -3 | tee -a "$LOG_FILE"; then
    log "ERROR: npm install failed during the rollback — the checkout holds ${PREV_REF:0:8} but its dependencies may not match."
    ROLLBACK_OK=0
  fi
}

# Record the commit the rollback moved off, so the next automatic tick does not
# pull it again and start the same crash loop (F7). NOT held: the checkout is
# back on PREV_REF, so the marker clears itself when main moves past the sha.
# Never fatal — a missing marker is worse, not a reason to abandon the run. If
# the commit rolled back to predates scripts/write-update-quarantine.mjs (the
# first release that ships it), that node call cannot run and only the warning
# below is logged: the boot guard is the backstop that keeps the sha refused.
quarantine_rolled_back() {
  if [ -z "${NEW_REF:-}" ] || [ "${NEW_REF:-}" = "${PREV_REF:-}" ]; then
    return 0
  fi
  if ! node "$SELF_DIR/write-update-quarantine.mjs" \
      --sha "$NEW_REF" --previous "$PREV_REF" --reason startup-crash --by crow-update \
      2>&1 | tail -3 | tee -a "$LOG_FILE"; then
    log "Warning: could not write the update quarantine marker for ${NEW_REF:0:8}."
  fi
}

log "Starting Crow update..."

cd "$CROW_APP"

# Save current ref for rollback
PREV_REF=$(git "${GIT_SAFE[@]}" rev-parse HEAD)
log "Current version: ${PREV_REF:0:8}"

# Pull latest
if git "${GIT_SAFE[@]}" pull --ff-only 2>&1 | tee -a "$LOG_FILE"; then
  NEW_REF=$(git "${GIT_SAFE[@]}" rev-parse HEAD)
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
  log "Restarting crow-gateway service..."
  sudo systemctl restart crow-gateway
  # Read the counter AFTER the restart returns: a MANUAL restart may reset
  # NRestarts to 0 (systemd does, from v236 on). A baseline read before the
  # restart therefore disagrees with every healthy unit that had already
  # restarted on its own (planned restarts exit 1 under Restart=on-failure), and
  # the script would roll back a good update. Read here, and the remaining
  # count is exactly the unsupervised restarts that followed this one.
  BEFORE_NRESTARTS=$(nrestarts)

  if wait_for_health && [ "$(nrestarts)" = "$BEFORE_NRESTARTS" ]; then
    log "Gateway restarted successfully (health 200, no supervised restart)."
  else
    log "ERROR: the gateway did not come up on the new code (health 200 within ${HEALTH_TIMEOUT_SECS}s, NRestarts unchanged: failed). Rolling back..."
    rollback
    # The marker records the sha this run moved OFF, so it belongs to a reset that
    # really moved the tree — not to a rollback whose npm install then failed
    # (S4: the tree IS back on PREV_REF, so the marker is still needed).
    if [ "$RESET_OK" = "1" ]; then
      quarantine_rolled_back
    fi
    sudo systemctl restart crow-gateway
    if [ "$ROLLBACK_OK" != "1" ]; then
      log "ERROR: the rollback did not complete cleanly (see above); the service was restarted anyway. Fix the checkout by hand, then run the update again."
    fi
    if wait_for_health; then
      log "Rolled back to ${PREV_REF:0:8} — gateway healthy."
    else
      log "ERROR: the gateway is still not healthy after the rollback. See the gateway log; the automatic rollback guard will act on the next start."
    fi
    # Non-zero whenever the update failed, whether the rollback worked or was
    # refused: a script that exits 0 here would report a silent stop.
    exit 1
  fi
else
  log "Gateway not running as systemd service — skip restart."
fi

log "Update complete."
echo ""
echo "  Previous: ${PREV_REF:0:8}"
echo "  Current:  $(git "${GIT_SAFE[@]}" rev-parse HEAD | head -c 8)"
echo "  Log:      ${LOG_FILE}"