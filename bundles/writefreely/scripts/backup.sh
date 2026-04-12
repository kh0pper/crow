#!/usr/bin/env bash
# WriteFreely backup — SQLite online backup + keys + uploads.
set -euo pipefail

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="${CROW_HOME:-$HOME/.crow}/backups/writefreely"
DATA_DIR="${WF_DATA_DIR:-$HOME/.crow/writefreely}"

mkdir -p "$BACKUP_ROOT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if docker ps --format '{{.Names}}' | grep -qw crow-writefreely; then
  docker exec crow-writefreely sqlite3 /go/keys/writefreely.db \
    ".backup /go/keys/wf-backup-${STAMP}.db"
  docker cp "crow-writefreely:/go/keys/wf-backup-${STAMP}.db" "$WORK/writefreely.db"
  docker exec crow-writefreely rm "/go/keys/wf-backup-${STAMP}.db"
fi

# Ed25519 actor keys + config must be preserved for federation identity
tar --exclude 'writefreely.db' --exclude 'writefreely.db-wal' --exclude 'writefreely.db-shm' \
    -C "$DATA_DIR" -cf "$WORK/keys-and-config.tar" .

OUT="${BACKUP_ROOT}/writefreely-${STAMP}.tar.zst"
if command -v zstd >/dev/null 2>&1; then
  tar -C "$WORK" -cf - . | zstd -T0 -19 -o "$OUT"
else
  OUT="${BACKUP_ROOT}/writefreely-${STAMP}.tar.gz"
  tar -C "$WORK" -czf "$OUT" .
fi
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "NOTE: actor signing keys are in the backup. Restoring to a new"
echo "      domain WILL NOT preserve federation identity — remote servers"
echo "      identify you by the {host, actor_key} pair."
