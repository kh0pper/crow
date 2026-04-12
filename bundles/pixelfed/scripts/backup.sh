#!/usr/bin/env bash
# Pixelfed backup: pg_dump + storage dir (uploads, caches excluded).
# S3-backed media NOT captured — operator's S3 provider is the durability layer.
set -euo pipefail

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="${CROW_HOME:-$HOME/.crow}/backups/pixelfed"
DATA_DIR="${PIXELFED_DATA_DIR:-$HOME/.crow/pixelfed}"

mkdir -p "$BACKUP_ROOT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Postgres dump
if docker ps --format '{{.Names}}' | grep -qw crow-pixelfed-postgres; then
  docker exec -e PGPASSWORD="${PIXELFED_DB_PASSWORD:-}" crow-pixelfed-postgres \
    pg_dump -U pixelfed -Fc -f /tmp/pixelfed-${STAMP}.pgcustom pixelfed
  docker cp "crow-pixelfed-postgres:/tmp/pixelfed-${STAMP}.pgcustom" "$WORK/pixelfed.pgcustom"
  docker exec crow-pixelfed-postgres rm "/tmp/pixelfed-${STAMP}.pgcustom"
fi

# Storage dir (exclude framework cache/logs — regenerable)
tar -C "$DATA_DIR" \
    --exclude='./storage/framework/cache' \
    --exclude='./storage/framework/sessions' \
    --exclude='./storage/logs' \
    --exclude='./storage/debugbar' \
    -cf "$WORK/pixelfed-storage.tar" storage uploads 2>/dev/null || true

OUT="${BACKUP_ROOT}/pixelfed-${STAMP}.tar.zst"
if command -v zstd >/dev/null 2>&1; then
  tar -C "$WORK" -cf - . | zstd -T0 -19 -o "$OUT"
else
  OUT="${BACKUP_ROOT}/pixelfed-${STAMP}.tar.gz"
  tar -C "$WORK" -czf "$OUT" .
fi
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "NOTE: S3-backed media (if configured) is NOT in this archive."
echo "      APP_KEY is embedded in .env — keep the .env file backed up separately."
