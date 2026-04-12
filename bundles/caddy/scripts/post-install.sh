#!/usr/bin/env bash
# Caddy bundle post-install hook.
#
# Creates the `crow-federation` external docker network that federated app
# bundles (F.1 onward) join. Idempotent: existing network is left alone.
#
# Wired into the installer via the bundle lifecycle — see
# servers/gateway/routes/bundles.js which runs scripts/post-install.sh (if
# present) after `docker compose up -d` succeeds.

set -euo pipefail

NETWORK="crow-federation"

if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "docker network $NETWORK already exists"
  exit 0
fi

docker network create --driver bridge "$NETWORK"
echo "created docker network $NETWORK"
