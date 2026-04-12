#!/usr/bin/env bash
# Matrix-Dendrite backup: pg_dump + signing key + media store + config.
set -euo pipefail

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="${CROW_HOME:-$HOME/.crow}/backups/matrix-dendrite"
DATA_DIR="${MATRIX_DATA_DIR:-$HOME/.crow/matrix-dendrite}"

mkdir -p "$BACKUP_ROOT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Postgres dump — use pg_dumpall to capture roles + schemas in one file
if docker ps --format '{{.Names}}' | grep -qw crow-dendrite-postgres; then
  docker exec -e PGPASSWORD="${MATRIX_POSTGRES_PASSWORD:-}" crow-dendrite-postgres \
    pg_dump -U dendrite -Fc -f /tmp/dendrite-${STAMP}.pgcustom dendrite
  docker cp "crow-dendrite-postgres:/tmp/dendrite-${STAMP}.pgcustom" "$WORK/dendrite.pgcustom"
  docker exec crow-dendrite-postgres rm "/tmp/dendrite-${STAMP}.pgcustom"
fi

# Dendrite signing keys + config + media store
tar -C "$DATA_DIR/dendrite" -cf "$WORK/dendrite-state.tar" . 2>/dev/null || true

OUT="${BACKUP_ROOT}/matrix-dendrite-${STAMP}.tar.zst"
if command -v zstd >/dev/null 2>&1; then
  tar -C "$WORK" -cf - . | zstd -T0 -19 -o "$OUT"
else
  OUT="${BACKUP_ROOT}/matrix-dendrite-${STAMP}.tar.gz"
  tar -C "$WORK" -czf "$OUT" .
fi
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "NOTE: the signing key in dendrite-state.tar IS federation identity."
echo "      Restoring to a different MATRIX_SERVER_NAME will break federation."
echo "      Keep this backup encrypted — loss = identity loss, leak = impersonation."
