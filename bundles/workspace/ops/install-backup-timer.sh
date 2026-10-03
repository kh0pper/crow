#!/usr/bin/env bash
# Turn on nightly Workspace backups: a USER systemd timer (no sudo) + the backup
# passphrase (generated once, SHOWN ONCE: write it down and keep it offline).
#   bash ops/install-backup-timer.sh --dest <dir> [--mount <mountpoint>] [--alert-lib <alerts.sh>]
# On crow: --dest /mnt/external/crow-workspace-backups --mount /mnt/external
#          --alert-lib ~/lab-maintenance/scripts/lib/alerts.sh
# Idempotent: rewrites the units, never touches an existing passphrase.
set -euo pipefail
umask 077
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WS="${WORKSPACE_DATA_ROOT:-$CROW_HOME/workspace}"
PASSFILE="$WS/backup-passphrase"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ONCAL="${WORKSPACE_BACKUP_ONCALENDAR:-*-*-* 03:55:00}"
SYSTEMCTL="${WORKSPACE_SYSTEMCTL:-systemctl}"
DEST=""; MOUNT=""; ALERT_LIB=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="${2:?}"; shift 2 ;;
    --mount) MOUNT="${2:?}"; shift 2 ;;
    --alert-lib) ALERT_LIB="${2:?}"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$DEST" ] || { echo "usage: install-backup-timer.sh --dest <dir> [--mount <mountpoint>] [--alert-lib <alerts.sh>]" >&2; exit 2; }
mkdir -p "$WS" "$UNIT_DIR"

if [ ! -f "$PASSFILE" ]; then
  random_pw 48 > "$PASSFILE"
  chmod 600 "$PASSFILE"
  echo "=== Workspace backup passphrase (shown ONCE: write it down, keep it offline) ==="
  cat "$PASSFILE"; echo
  echo "=== Without it, the backups cannot be opened. ==="
else
  echo "Backup passphrase already exists at $PASSFILE (not shown again)."
fi

{
  echo "[Unit]"
  echo "Description=Nightly Crow Workspace backup (Nextcloud DB + files, gpg-encrypted)"
  echo
  echo "[Service]"
  echo "Type=oneshot"
  echo "Environment=CROW_HOME=$CROW_HOME"
  echo "Environment=WORKSPACE_BACKUP_DEST=$DEST"
  [ -n "$MOUNT" ] && echo "Environment=WORKSPACE_BACKUP_MOUNT=$MOUNT"
  [ -n "$ALERT_LIB" ] && echo "Environment=WORKSPACE_BACKUP_ALERT_LIB=$ALERT_LIB"
  echo "ExecStart=/bin/bash $BUNDLE_DIR/ops/backup.sh"
  echo "ExecStopPost=/bin/bash $BUNDLE_DIR/ops/backup-stoppost.sh"
  echo "TimeoutStartSec=2h"
  echo "TimeoutStopSec=5min"
} > "$UNIT_DIR/crow-workspace-backup.service"

cat > "$UNIT_DIR/crow-workspace-backup.timer" <<EOF
[Unit]
Description=Nightly Crow Workspace backup

[Timer]
OnCalendar=$ONCAL
Persistent=true

[Install]
WantedBy=timers.target
EOF

$SYSTEMCTL --user daemon-reload
$SYSTEMCTL --user enable --now crow-workspace-backup.timer
if command -v loginctl >/dev/null 2>&1 && [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo yes)" != "yes" ]; then
  echo "WARNING: lingering is off for $(id -un); the timer only runs while you are logged in. Fix: sudo loginctl enable-linger $(id -un)"
fi
echo "Nightly backup enabled ($ONCAL) → $DEST. Run one now: systemctl --user start crow-workspace-backup.service"
