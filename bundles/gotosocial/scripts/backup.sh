#!/usr/bin/env bash
# GoToSocial backup script.
#
# Dumps SQLite (default backend) via online-backup for consistency, tars
# the media storage directory, and writes everything to
# ~/.crow/backups/gotosocial/<timestamp>.tar.zst.
#
# This is NOT called by `npm run backup` — Crow's main backup flow
# deliberately does not touch bundle data. Run manually or schedule via
# crow_create_schedule.

set -euo pipefail

BUNDLE_NAME="gotosocial"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="${CROW_HOME:-$HOME/.crow}/backups/${BUNDLE_NAME}"
DATA_DIR="${GTS_DATA_DIR:-$HOME/.crow/gotosocial}"

mkdir -p "$BACKUP_ROOT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# SQLite online backup via sqlite3 (atomic — no reader lock contention)
if [ -f "$DATA_DIR/sqlite.db" ]; then
  docker exec crow-gotosocial sqlite3 /gotosocial/storage/sqlite.db \
    ".backup /gotosocial/storage/sqlite-backup-${STAMP}.db"
  docker cp "crow-gotosocial:/gotosocial/storage/sqlite-backup-${STAMP}.db" "$WORK/sqlite.db"
  docker exec crow-gotosocial rm "/gotosocial/storage/sqlite-backup-${STAMP}.db"
else
  echo "No sqlite.db at $DATA_DIR — skipping DB dump (Postgres?)"
fi

# Tar the media storage dir (excluding the live DB since we have the backup above)
tar --exclude 'sqlite.db' --exclude 'sqlite.db-wal' --exclude 'sqlite.db-shm' \
    -C "$DATA_DIR" -cf "$WORK/media.tar" .

OUT="${BACKUP_ROOT}/${BUNDLE_NAME}-${STAMP}.tar.zst"
if command -v zstd >/dev/null 2>&1; then
  tar -C "$WORK" -cf - . | zstd -T0 -19 -o "$OUT"
else
  OUT="${BACKUP_ROOT}/${BUNDLE_NAME}-${STAMP}.tar.gz"
  tar -C "$WORK" -czf "$OUT" .
fi
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
