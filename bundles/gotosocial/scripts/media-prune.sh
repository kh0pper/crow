#!/usr/bin/env bash
# Daily remote-media prune for GoToSocial.
#
# Invokes GoToSocial's admin media-cleanup endpoint to evict cached remote
# media older than GTS_MEDIA_RETENTION_DAYS (default 14, or 7 on Pi).
# Registered with Crow's scheduler at install time; also invokable via
# the gts_media_prune MCP tool.

set -euo pipefail

CONTAINER="${GTS_CONTAINER:-crow-gotosocial}"
DAYS="${GTS_MEDIA_RETENTION_DAYS:-14}"

if ! docker ps --format '{{.Names}}' | grep -qw "$CONTAINER"; then
  echo "gotosocial container not running — skipping prune"
  exit 0
fi

# GoToSocial ships a built-in CLI for this — no API token needed from host.
docker exec "$CONTAINER" \
  /gotosocial/gotosocial --config-path /gotosocial/config.yaml \
  admin media prune-remote --days "$DAYS" || {
    echo "prune command failed — check container logs"
    exit 1
  }

echo "pruned remote media older than $DAYS days"
