#!/usr/bin/env bash
# GoToSocial bundle post-install hook.
#
# Runs after `docker compose up -d` and a healthy container.
# Responsibilities:
#   1. Verify the crow-federation docker network is joined.
#   2. If GTS_IMPORT_BLOCKLIST is set, queue the initial import (treated
#      as pre-authorized by the install consent modal).
#   3. Print next-step guidance.

set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${BUNDLE_DIR}/.env"

# Source .env if present so the script has access to configured vars.
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

# 1. Ensure the container is on crow-federation (compose already declares
#    it, but guard against a partial compose that forgot the network).
if ! docker inspect crow-gotosocial --format '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | grep -qw crow-federation; then
  echo "WARN: crow-gotosocial is not on the crow-federation network — federation sites via Caddy will not reach it by service name" >&2
fi

# 2. Optional IFTAS/Bad Space blocklist import.
if [ -n "${GTS_IMPORT_BLOCKLIST:-}" ]; then
  echo "Queuing initial blocklist import from ${GTS_IMPORT_BLOCKLIST}"
  echo "  (this is the one install-time auto-import; subsequent imports go"
  echo "   through the operator-confirmation queue)"
  # Actual import happens via the MCP tool against the live DB; this
  # script just leaves a marker the bundle picks up on first MCP call.
  mkdir -p "${BUNDLE_DIR}"
  echo "${GTS_IMPORT_BLOCKLIST}" > "${BUNDLE_DIR}/.pending-blocklist-import"
fi

cat <<EOF

GoToSocial container is up. Next steps:

  1. Open https://${GTS_HOST:-<your-domain>}/ and create the admin account
  2. Generate an API token:
       docker exec crow-gotosocial ./gotosocial --config-path /gotosocial/config.yaml \\
           admin account create-token --username <your-admin-username>
     Paste into .env as GTS_ACCESS_TOKEN and restart the MCP server.
  3. Expose via Caddy (one-time):
       caddy_add_federation_site {
         domain: "${GTS_HOST:-<your-domain>}",
         upstream: "gotosocial:8080",
         profile: "activitypub"
       }
  4. Verify cert issuance:
       caddy_cert_health { domain: "${GTS_HOST:-<your-domain>}" }

EOF
