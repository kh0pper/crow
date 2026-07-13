#!/usr/bin/env bash
#
# install-orphan-guard.sh — install the orphan-gateway guard on this host.
# (Item 2a-FU, finding 4. Requires sudo. Idempotent — safe to re-run.)
#
# Installs two layers, both running scripts/ops/kill-orphan-gateways.sh from
# this repo checkout:
#   1. An ExecStartPre drop-in for every PRESENT crow-*gateway* unit, so every
#      gateway (re)start first reaps orphan gateways/bundle children that
#      could hold the DB. The `-` prefix makes a guard failure non-fatal to
#      the gateway start.
#   2. A crow-orphan-sweep.service (oneshot) + crow-orphan-sweep.timer
#      (OnBootSec=2min, OnUnitActiveSec=1min), so orphans die within about a
#      minute even when no gateway restart ever happens.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "error: must run as root (sudo $0)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD="$REPO_ROOT/scripts/ops/kill-orphan-gateways.sh"

if [ ! -x "$GUARD" ]; then
  echo "error: $GUARD missing or not executable" >&2
  exit 1
fi

echo "repo root:    $REPO_ROOT"
echo "guard script: $GUARD"

# The sweep must not run as root: every intended victim is an unprivileged
# gateway process, and a root timer executing a user-writable repo file every
# minute would turn any compromise of that user into root code execution.
# Run it as the gateway unit's own user (same-uid can read cwd/environ and
# signal the victims). Resolution: crow-gateway's User= → SUDO_USER → error.
GUARD_USER=$(systemctl show -p User --value crow-gateway.service 2>/dev/null || true)
if [ -z "${GUARD_USER:-}" ]; then GUARD_USER="${SUDO_USER:-}"; fi
if [ -z "${GUARD_USER:-}" ] || [ "$GUARD_USER" = "root" ]; then
  echo "error: cannot resolve a non-root user for the sweep (crow-gateway User= empty and SUDO_USER unset/root)" >&2
  exit 1
fi
echo "sweep user:   $GUARD_USER"

# --- 1. ExecStartPre drop-in for each present crow gateway/bridge unit ------
# crow-mcp-bridge is a real gateway process on grackle — give it the same
# ExecStartPre guard, not just timer coverage.
units=$(systemctl list-unit-files --no-legend --plain 'crow-*gateway*.service' 'crow-mcp-bridge*.service' 2>/dev/null \
          | awk '{print $1}' | sort -u || true)

if [ -z "$units" ]; then
  echo "no crow-*gateway*.service units present — skipping drop-ins"
else
  for unit in $units; do
    dropin_dir="/etc/systemd/system/${unit}.d"
    dropin="${dropin_dir}/orphan-guard.conf"
    mkdir -p "$dropin_dir"
    cat > "$dropin" <<EOF
# Installed by ${REPO_ROOT}/scripts/ops/install-orphan-guard.sh
# Reap orphaned gateways/bundle children before starting this gateway.
# The '-' prefix keeps a guard failure from blocking the gateway start.
[Service]
ExecStartPre=-${GUARD}
EOF
    echo "wrote $dropin"
  done
fi

# --- 2. Periodic sweep: oneshot service + timer ------------------------------
sweep_service=/etc/systemd/system/crow-orphan-sweep.service
sweep_timer=/etc/systemd/system/crow-orphan-sweep.timer

cat > "$sweep_service" <<EOF
# Installed by ${REPO_ROOT}/scripts/ops/install-orphan-guard.sh
[Unit]
Description=Reap orphaned crow gateway and bundle-child processes

[Service]
Type=oneshot
User=${GUARD_USER}
ExecStart=${GUARD}
EOF
echo "wrote $sweep_service"

cat > "$sweep_timer" <<EOF
# Installed by ${REPO_ROOT}/scripts/ops/install-orphan-guard.sh
[Unit]
Description=Periodic sweep for orphaned crow gateway/bundle processes

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
EOF
echo "wrote $sweep_timer"

systemctl daemon-reload
echo "daemon-reload done"

systemctl enable --now crow-orphan-sweep.timer
echo "enabled + started crow-orphan-sweep.timer:"
systemctl status crow-orphan-sweep.timer --no-pager --lines=0 || true

echo
echo "orphan guard installed. Verify with:"
echo "  systemctl list-timers crow-orphan-sweep.timer"
echo "  journalctl -t orphan-gateway-killer -n 20"
