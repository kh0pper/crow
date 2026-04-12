#!/usr/bin/env bash
# Funkwhale backup: pg_dump + media (on-disk only) + data dir (secret key,
# cached federation state, celerybeat schedule).
#
# S3-backed audio is NOT captured here — the operator's S3 provider
# handles durability for those files. Only the metadata / on-disk audio
# is in scope of this bundle.
set -euo pipefail

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="${CROW_HOME:-$HOME/.crow}/backups/funkwhale"
DATA_DIR="${FUNKWHALE_DATA_DIR:-$HOME/.crow/funkwhale}"

mkdir -p "$BACKUP_ROOT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Postgres dump
if docker ps --format '{{.Names}}' | grep -qw crow-funkwhale-postgres; then
  docker exec -e PGPASSWORD="${FUNKWHALE_POSTGRES_PASSWORD:-}" crow-funkwhale-postgres \
    pg_dump -U funkwhale -Fc -f /tmp/funkwhale-${STAMP}.pgcustom funkwhale
  docker cp "crow-funkwhale-postgres:/tmp/funkwhale-${STAMP}.pgcustom" "$WORK/funkwhale.pgcustom"
  docker exec crow-funkwhale-postgres rm "/tmp/funkwhale-${STAMP}.pgcustom"
fi

# Data dir (media/, static/, celerybeat schedule) — skip transcodes (regenerable)
tar -C "$DATA_DIR/data" \
    --exclude='./media/__cache__' \
    --exclude='./static' \
    -cf "$WORK/funkwhale-data.tar" . 2>/dev/null || true

OUT="${BACKUP_ROOT}/funkwhale-${STAMP}.tar.zst"
if command -v zstd >/dev/null 2>&1; then
  tar -C "$WORK" -cf - . | zstd -T0 -19 -o "$OUT"
else
  OUT="${BACKUP_ROOT}/funkwhale-${STAMP}.tar.gz"
  tar -C "$WORK" -czf "$OUT" .
fi
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "NOTE: S3-backed audio (if configured) is NOT in this archive."
echo "      The Django secret key is — keep this backup encrypted."
