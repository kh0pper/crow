#!/usr/bin/env bash
# PeerTube backup: pg_dump + config + optional on-disk video originals.
#
# Videos are large. This script backs up ONLY the database + config by
# default. Pass --with-videos to include the on-disk video store (can be
# hundreds of GB). S3-backed video is NOT captured — operator's S3
# provider is the durability layer.
set -euo pipefail

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="${CROW_HOME:-$HOME/.crow}/backups/peertube"
DATA_DIR="${PEERTUBE_DATA_DIR:-$HOME/.crow/peertube}"
WITH_VIDEOS=0
[ "${1:-}" = "--with-videos" ] && WITH_VIDEOS=1

mkdir -p "$BACKUP_ROOT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Postgres dump
if docker ps --format '{{.Names}}' | grep -qw crow-peertube-postgres; then
  docker exec -e PGPASSWORD="${PEERTUBE_DB_PASSWORD:-}" crow-peertube-postgres \
    pg_dump -U peertube -Fc -f /tmp/peertube-${STAMP}.pgcustom peertube_prod
  docker cp "crow-peertube-postgres:/tmp/peertube-${STAMP}.pgcustom" "$WORK/peertube.pgcustom"
  docker exec crow-peertube-postgres rm "/tmp/peertube-${STAMP}.pgcustom"
fi

# Config
if [ -d "$DATA_DIR/config" ]; then
  tar -C "$DATA_DIR" -cf "$WORK/peertube-config.tar" config 2>/dev/null || true
fi

# Optional videos
if [ "$WITH_VIDEOS" -eq 1 ] && [ -d "$DATA_DIR/data" ]; then
  echo "Including on-disk video files (--with-videos) — can be hundreds of GB."
  tar -C "$DATA_DIR" -cf "$WORK/peertube-videos.tar" data 2>/dev/null || true
fi

OUT="${BACKUP_ROOT}/peertube-${STAMP}.tar.zst"
if command -v zstd >/dev/null 2>&1; then
  tar -C "$WORK" -cf - . | zstd -T0 -19 -o "$OUT"
else
  OUT="${BACKUP_ROOT}/peertube-${STAMP}.tar.gz"
  tar -C "$WORK" -czf "$OUT" .
fi
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "NOTE: PEERTUBE_SECRET lives in .env — back up .env SEPARATELY and encrypted."
echo "      Rotating the secret breaks every federated follow relationship."
[ "$WITH_VIDEOS" -eq 0 ] && echo "      On-disk videos NOT in this archive (pass --with-videos to include)."
