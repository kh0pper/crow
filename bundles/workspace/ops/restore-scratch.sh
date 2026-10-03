#!/usr/bin/env bash
# Prove a backup restores: boot it in a throwaway compose project (crow-ws-restore:
# no published ports, own subnet, never restarts, own data dir). Shows its users and
# the admin's files. Never touches crow-workspace.
#   bash ops/restore-scratch.sh <ONE crow-workspace-....tar> [passphrase-file]   (never a glob)
#   bash ops/restore-scratch.sh --clean
set -euo pipefail
umask 077
BUNDLE_DIR="${CROW_BUNDLE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SCRATCH="${WORKSPACE_SCRATCH_DIR:-$HOME/.crow-workspace-restore}"
IMAGE="nextcloud:34.0.4-apache"
PROJECT="crow-ws-restore"
WAIT_S=300
log() { printf '[restore-scratch] %s\n' "$*"; }
die() { printf '[restore-scratch] ERROR: %s\n' "$*" >&2; exit 1; }
sdc() { CROW_HOME="$SCRATCH" docker compose -p "$PROJECT" -f "$BUNDLE_DIR/docker-compose.yml" -f "$BUNDLE_DIR/ops/restore-scratch.override.yml" --env-file "$SCRATCH/unpacked/bundle.env" "$@"; }

if [ "${1:-}" = "--clean" ]; then
  [ -f "$SCRATCH/unpacked/bundle.env" ] && sdc down -v --remove-orphans || true
  [ -d "$SCRATCH/workspace" ] && docker run --rm -v "$SCRATCH:/s" "$IMAGE" rm -rf /s/workspace
  rm -rf "$SCRATCH"
  log "scratch restore removed"
  exit 0
fi

[ "$#" -le 2 ] || die "expected ONE archive and an optional passphrase file, got $# arguments (did a glob match several archives? name one archive explicitly)"
ARCHIVE="${1:?usage: restore-scratch.sh <archive.tar> [passphrase-file] | --clean}"
case "${2:-}" in *.tar) die "second argument looks like an archive ($2); usage: restore-scratch.sh <archive.tar> [passphrase-file]";; esac
[ ! -e "$SCRATCH" ] || die "$SCRATCH already exists. Run: $0 --clean"
bash "$BUNDLE_DIR/ops/restore.sh" "$ARCHIVE" "$SCRATCH/unpacked" "${2:-${CROW_HOME:-$HOME/.crow}/workspace/backup-passphrase}"
command -v python3 >/dev/null 2>&1 || die "python3 is required to read the restored bundle.env (ops/envfile.py); install it and re-run"
ADMIN="$(python3 "$(dirname "${BASH_SOURCE[0]}")/envfile.py" get "$SCRATCH/unpacked/bundle.env" WORKSPACE_ADMIN_USER)"; ADMIN="${ADMIN:-admin}"
mkdir -p "$SCRATCH/workspace/nextcloud" "$SCRATCH/workspace/db"
docker run --rm -v "$SCRATCH/workspace/nextcloud:/dst" -v "$SCRATCH/unpacked:/src:ro" "$IMAGE" \
  sh -c 'tar -C /dst -xpf /src/nextcloud-files.tar && chown -R www-data:www-data /dst'
sdc up -d nextcloud-db nextcloud-redis
waited=0
until sdc exec -T nextcloud-db healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; do
  [ "$waited" -ge "$WAIT_S" ] && die "scratch MariaDB not healthy after ${WAIT_S}s"
  sleep 5; waited=$((waited + 5))
done
sdc exec -T nextcloud-db sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -uroot nextcloud' < "$SCRATCH/unpacked/db.sql"
sdc up -d nextcloud
waited=0
until [[ "$(sdc exec -T -u www-data nextcloud php occ status --output=json 2>/dev/null)" == *'"installed":true'* ]]; do
  [ "$waited" -ge "$WAIT_S" ] && die "scratch Nextcloud not up after ${WAIT_S}s"
  sleep 5; waited=$((waited + 5))
done
sdc exec -T -u www-data nextcloud php occ maintenance:mode --off
log "status:"; sdc exec -T -u www-data nextcloud php occ status
log "users:";  sdc exec -T -u www-data nextcloud php occ user:list
log "files of $ADMIN:"; sdc exec -T -u www-data nextcloud ls -la "data/$ADMIN/files"
log "OK. Inspect, then remove it with: $0 --clean"
