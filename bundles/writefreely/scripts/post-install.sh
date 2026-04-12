#!/usr/bin/env bash
# WriteFreely bundle post-install hook.
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${BUNDLE_DIR}/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

if ! docker inspect crow-writefreely --format '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | grep -qw crow-federation; then
  echo "WARN: crow-writefreely is not on crow-federation — Caddy can't reach it by service name" >&2
fi

cat <<EOF

WriteFreely container is up. Next steps:

  1. Expose via Caddy:
       caddy_add_federation_site {
         domain: "${WF_HOST:-<your-domain>}",
         upstream: "writefreely:8080",
         profile: "activitypub"
       }
  2. Open https://${WF_HOST:-<your-domain>}/ and create the admin account
     (web UI only — WriteFreely has no CLI bootstrap)
  3. Generate an API token:
       curl -X POST https://${WF_HOST:-<your-domain>}/api/auth/login \\
         -H 'Content-Type: application/json' \\
         -d '{"alias":"<admin>","pass":"<password>"}'
     Paste the access_token into .env as WF_ACCESS_TOKEN, then restart
     the MCP server.
  4. List collections:
       wf_list_collections
     Pick your primary alias and set WF_COLLECTION_ALIAS in .env for
     single-arg wf_create_post.

EOF
