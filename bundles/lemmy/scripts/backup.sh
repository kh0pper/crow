#!/usr/bin/env bash
# Lemmy backup: pg_dump + pict-rs sled DB + media files.
set -euo pipefail

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="${CROW_HOME:-$HOME/.crow}/backups/lemmy"

mkdir -p "$BACKUP_ROOT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Postgres dump
if docker ps --format '{{.Names}}' | grep -qw crow-lemmy-postgres; then
  docker exec -e PGPASSWORD="${LEMMY_DB_PASSWORD:-}" crow-lemmy-postgres \
    pg_dump -U lemmy -Fc -f /tmp/lemmy-${STAMP}.pgcustom lemmy
  docker cp "crow-lemmy-postgres:/tmp/lemmy-${STAMP}.pgcustom" "$WORK/lemmy.pgcustom"
  docker exec crow-lemmy-postgres rm "/tmp/lemmy-${STAMP}.pgcustom"
fi

# pict-rs sled + files (a Docker-managed volume, read through the running container)
if docker ps --format '{{.Names}}' | grep -qw crow-lemmy-pictrs; then
  docker exec crow-lemmy-pictrs tar -C /mnt -cf - . > "$WORK/pictrs.tar" 2>/dev/null || true
fi

OUT="${BACKUP_ROOT}/lemmy-${STAMP}.tar.zst"
if command -v zstd >/dev/null 2>&1; then
  tar -C "$WORK" -cf - . | zstd -T0 -19 -o "$OUT"
else
  OUT="${BACKUP_ROOT}/lemmy-${STAMP}.tar.gz"
  tar -C "$WORK" -czf "$OUT" .
fi
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "NOTE: lemmy's federation identity lives in the database (instance private key)."
echo "      Restoring to a different LEMMY_HOSTNAME will break federation."
