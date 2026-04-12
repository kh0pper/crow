#!/usr/bin/env bash
# Mastodon backup: pg_dump + system/ (on-disk media only) + .env (secrets!).
# S3-backed media NOT captured here — operator's S3 provider owns durability.
set -euo pipefail

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="${CROW_HOME:-$HOME/.crow}/backups/mastodon"
DATA_DIR="${MASTODON_DATA_DIR:-$HOME/.crow/mastodon}"

mkdir -p "$BACKUP_ROOT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Postgres dump
if docker ps --format '{{.Names}}' | grep -qw crow-mastodon-postgres; then
  docker exec -e PGPASSWORD="${MASTODON_DB_PASSWORD:-}" crow-mastodon-postgres \
    pg_dump -U mastodon -Fc -f /tmp/mastodon-${STAMP}.pgcustom mastodon_production
  docker cp "crow-mastodon-postgres:/tmp/mastodon-${STAMP}.pgcustom" "$WORK/mastodon.pgcustom"
  docker exec crow-mastodon-postgres rm "/tmp/mastodon-${STAMP}.pgcustom"
fi

# On-disk media (exclude cache subdir — regenerable from remote)
if [ -d "$DATA_DIR/system" ]; then
  tar -C "$DATA_DIR" --exclude='./system/cache' -cf "$WORK/mastodon-system.tar" system 2>/dev/null || true
fi

OUT="${BACKUP_ROOT}/mastodon-${STAMP}.tar.zst"
if command -v zstd >/dev/null 2>&1; then
  tar -C "$WORK" -cf - . | zstd -T0 -19 -o "$OUT"
else
  OUT="${BACKUP_ROOT}/mastodon-${STAMP}.tar.gz"
  tar -C "$WORK" -czf "$OUT" .
fi
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "NOTE: S3-backed media (if configured) is NOT in this archive."
echo "      SECRET_KEY_BASE / OTP_SECRET / VAPID keys live in .env — back up .env SEPARATELY"
echo "      and keep it encrypted. LOSS of SECRET_KEY_BASE invalidates all 2FA tokens + sessions."
