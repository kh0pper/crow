#!/usr/bin/env bash
# Nightly Crow Workspace backup (crow-workspace-backup.timer, 03:55).
#  maintenance on → (dump | gpg) + (in-container tar | gpg) → maintenance off →
#  (.env | gpg) → one plain tar of the three .gpg members to staging, then the drive.
# No plaintext ever touches disk. Maintenance is held for the dump+snapshot only,
# bounded by HOLD_S; the trap turns it off (timeout 60) on any exit it can catch, and
# ExecStopPost=ops/backup-stoppost.sh does it after anything else (SIGKILL, OOM).
set -euo pipefail
umask 077

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WS="${WORKSPACE_DATA_ROOT:-$CROW_HOME/workspace}"
STAGING="$WS/backups-staging"
DEST="${WORKSPACE_BACKUP_DEST:-}"
MOUNT="${WORKSPACE_BACKUP_MOUNT:-}"
PASSFILE="${WORKSPACE_BACKUP_PASSFILE:-$WS/backup-passphrase}"
KEEP_DAYS="${WORKSPACE_BACKUP_KEEP_DAYS:-14}"
HOLD_S="${WORKSPACE_BACKUP_HOLD_S:-1800}"
GPG="${WORKSPACE_GPG:-gpg}"
TS="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="crow-workspace-$TS.tar"

alert() {  # loud by design: a silent backup failure is the same as no backup
  local lib="${WORKSPACE_BACKUP_ALERT_LIB:-}"
  if [ -n "$lib" ] && [ -r "$lib" ]; then
    ( set +eu; source "$lib"; send_alert "$1" "$2" high ) >/dev/null 2>&1 || true
  fi
  printf '[workspace-backup] ALERT: %s: %s\n' "$1" "$2" >&2
}
abort() { alert "Workspace backup ABORTED" "$1"; exit 1; }
enc() { "$GPG" --batch --yes --pinentry-mode loopback --passphrase-file "$PASSFILE" --symmetric --cipher-algo AES256 --compress-algo none -o "$1"; }

# Preflight: all before maintenance mode, so a refusal never locks anyone out.
[ -n "$DEST" ] || abort "WORKSPACE_BACKUP_DEST is not set (re-run ops/install-backup-timer.sh --dest <dir>)"
[ -f "$PASSFILE" ] || abort "no backup passphrase at $PASSFILE (run ops/install-backup-timer.sh first)"
[ "$(stat -c %a "$PASSFILE")" = "600" ] || abort "$PASSFILE must be mode 600"
[ -f "$BUNDLE_DIR/.env" ] || abort "no .env at $BUNDLE_DIR"
if [ -n "$MOUNT" ]; then mountpoint -q "$MOUNT" || abort "$MOUNT is not a mounted filesystem (drive unplugged?)"; fi
mkdir -p "$DEST" 2>/dev/null || true
{ [ -d "$DEST" ] && [ -w "$DEST" ]; } || abort "$DEST not writable"
mkdir -p "$STAGING"
rm -rf "$STAGING"/run-*            # leftovers from a killed run
WORK="$(mktemp -d "$STAGING/run-$TS.XXXXXX")"

MAINT=0
cleanup() {
  local rc=$?
  if [ "$MAINT" = 1 ]; then
    (cd "$BUNDLE_DIR" && timeout 60 $DC exec -T -u www-data nextcloud php occ maintenance:mode --off) >/dev/null 2>&1 \
      || log "WARNING: maintenance mode may still be ON (ExecStopPost will retry)"
    MAINT=0
  fi
  rm -rf "$WORK" "$STAGING/$ARCHIVE.part"
  [ "$rc" = 0 ] || alert "Workspace backup FAILED" "exit $rc at $(date +%T); see journalctl --user -u crow-workspace-backup"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 143' INT TERM

DEADLINE=$(( $(date +%s) + HOLD_S ))
check_left() { LEFT=$(( DEADLINE - $(date +%s) )); [ "$LEFT" -gt 0 ] || { log "maintenance window exceeded ${HOLD_S}s"; exit 1; }; }

occ maintenance:mode --on >/dev/null
MAINT=1
log "maintenance mode on"
check_left
(cd "$BUNDLE_DIR" && timeout --kill-after=10 "$LEFT" $DC exec -T nextcloud-db sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb-dump --single-transaction --default-character-set=utf8mb4 -uroot nextcloud') | enc "$WORK/db.sql.gpg"
check_left
(cd "$BUNDLE_DIR" && timeout --kill-after=10 "$LEFT" $DC exec -T -u root nextcloud tar -C /var/www/html -cf - .) | enc "$WORK/files.tar.gpg"
occ maintenance:mode --off >/dev/null
MAINT=0
log "maintenance mode off (dump + snapshot encrypted)"

enc "$WORK/bundle.env.gpg" < "$BUNDLE_DIR/.env"
tar -C "$WORK" -cf "$STAGING/$ARCHIVE.part" db.sql.gpg files.tar.gpg bundle.env.gpg
mv "$STAGING/$ARCHIVE.part" "$STAGING/$ARCHIVE"
chmod 600 "$STAGING/$ARCHIVE"
cp "$STAGING/$ARCHIVE" "$DEST/$ARCHIVE.part"
mv "$DEST/$ARCHIVE.part" "$DEST/$ARCHIVE"

find "$STAGING" -maxdepth 1 -name 'crow-workspace-*.tar' ! -name "$ARCHIVE" -delete
find "$DEST" -maxdepth 1 -name 'crow-workspace-*.tar' -mtime +"$((KEEP_DAYS - 1))" -delete
log "backup ok: $DEST/$ARCHIVE ($(du -h "$DEST/$ARCHIVE" | cut -f1))"
