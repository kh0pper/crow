#!/usr/bin/env bash
# pir-fullflow-deadman.sh — independent self-bounding watchdog for pir-fullflow.mjs.
#
# The harness can block in a synchronous subprocess call (a hung `bridge --inject`
# or `sqlite3 .backup`), which freezes its JS event loop so an in-process timer
# never fires. This watchdog runs as a SEPARATE detached process: after CAP
# seconds it force-restores production and kills the harness, no matter what state
# the harness is in. A hung run can therefore never hold the maintenance window
# (canvas-web down, tea_data.db read-only) longer than CAP. The harness kills this
# watchdog on its own clean exit.
#
# Args: <cap_seconds> <harness_pid> <tea_db_path> [disarm_sentinel_path]
# Env:  LAB_SUDO_PASS  (optional) — needed to restart the systemd services.
set -uo pipefail
CAP="${1:?cap_seconds}"; HPID="${2:?harness_pid}"; TEA="${3:?tea_db_path}"; SENTINEL="${4:-}"

sleep "$CAP"

# Disarmed by the harness on clean exit (sentinel survives a missed kill)? no-op.
[ -n "$SENTINEL" ] && [ -f "$SENTINEL" ] && exit 0
# Harness already gone (clean exit normally kills us first)? nothing to do.
kill -0 "$HPID" 2>/dev/null || exit 0

echo "[deadman $(date -Is)] CAP ${CAP}s exceeded — force-restoring prod, killing harness $HPID" >&2

# 1) Restore the resources the harness locks (no sudo needed; kh0pp-owned).
chmod 775 "$(dirname "$TEA")" 2>/dev/null || true          # unlock prod tea DIRECTORY (orig mode; the real net)
chmod 644 "$TEA" 2>/dev/null || true                       # belt: ensure the file itself is writable too
pkill -9 -f "uvicorn .*--port 8080" 2>/dev/null || true    # free :8080 (sandbox uvicorn)
timeout 360 bash /home/kh0pp/crow/scripts/bots/pir_model_swap.sh 35b >/dev/null 2>&1 || true

# 2) Kill the harness and its children.
pkill -9 -P "$HPID" 2>/dev/null || true
kill -9 "$HPID" 2>/dev/null || true

# 3) Restart the production services if we were given sudo.
if [ -n "${LAB_SUDO_PASS:-}" ]; then
  echo "$LAB_SUDO_PASS" | sudo -S systemctl start \
    canvas-companion-web.service mpa-pir-response-sync.timer mpa-pir-processor-dispatch.timer 2>/dev/null || true
  echo "[deadman $(date -Is)] restarted canvas-web + PIR timers" >&2
else
  echo "[deadman $(date -Is)] tea_data.db unlocked + :8080 freed; set LAB_SUDO_PASS to auto-restart canvas-web/timers" >&2
fi
echo "[deadman $(date -Is)] restore complete" >&2
