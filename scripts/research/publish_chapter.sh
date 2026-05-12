#!/usr/bin/env bash
# Wrapper that loads tailnet MinIO credentials before invoking publish_chapter.mjs.
# Writes go to the tailnet-resident MinIO at 100.118.41.122:9000; the
# MINIO_ENDPOINT=localhost value in ~/crow/.env is correct only on the crow
# machine itself, so from grackle we must override.
#
# Usage: ~/crow/scripts/research/publish_chapter.sh <case_id> [--overwrite] [--write]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "$HOME/crow/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$HOME/crow/.env"
  set +a
fi

export MINIO_ENDPOINT=100.118.41.122
export MINIO_PORT="${MINIO_PORT:-9000}"
export MINIO_USE_SSL="${MINIO_USE_SSL:-false}"

# Force system /usr/bin/node (ABI 127) so this script doesn't trip the
# better-sqlite3 ABI mismatch documented in
# feedback_crow_better_sqlite3_abi_crash.md. crow-gateway.service runs
# on /usr/bin/node; re-running publish_chapter.mjs under nvm Node v24+
# would swap the native binary to ABI 137 and crash-loop the gateway.
exec /usr/bin/node "$HERE/publish_chapter.mjs" "$@"
