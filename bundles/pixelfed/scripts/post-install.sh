#!/usr/bin/env bash
# Pixelfed post-install hook.
#
# 1. Wait for crow-pixelfed to report healthy (first boot runs migrations
#    + key:generate + storage:link — can take 2+ minutes).
# 2. Optionally translate PIXELFED_S3_* into AWS_* + FILESYSTEM_CLOUD via
#    configure-storage.mjs.
# 3. Verify crow-federation network attachment.
# 4. Print next-step guidance (admin user creation, Caddy site, PAT).

set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${BUNDLE_DIR}/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

echo "Waiting for Pixelfed to report healthy (up to 180s)…"
for i in $(seq 1 36); do
  if docker inspect crow-pixelfed --format '{{.State.Health.Status}}' 2>/dev/null | grep -qw healthy; then
    echo "  → healthy"
    break
  fi
  sleep 5
done

# Translate S3 vars if configured
if [ -n "${PIXELFED_S3_ENDPOINT:-}" ]; then
  echo "PIXELFED_S3_ENDPOINT detected — translating to AWS_* + FILESYSTEM_CLOUD via storage-translators…"
  if command -v node >/dev/null 2>&1; then
    node "${BUNDLE_DIR}/scripts/configure-storage.mjs" || {
      echo "WARN: configure-storage.mjs failed; media will stay on-disk until S3 env vars are written manually." >&2
    }
  else
    echo "WARN: node not available on PATH — cannot run configure-storage.mjs. S3 not wired." >&2
  fi
fi

if ! docker inspect crow-pixelfed --format '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | grep -qw crow-federation; then
  echo "WARN: crow-pixelfed is not on the crow-federation network — Caddy federation sites will not reach it by service name" >&2
fi

cat <<EOF

Pixelfed stack is up. Next steps:

  1. Create the admin user:
       docker exec -it crow-pixelfed php artisan user:create

  2. Expose via Caddy (one-time):
       caddy_add_federation_site {
         domain: "${PIXELFED_HOSTNAME:-photos.example.com}",
         upstream: "pixelfed:80",
         profile: "activitypub"
       }

  3. In the web UI, Settings → Development → New Application (scopes:
     read write follow push), then generate a Personal Access Token.
     Paste into .env as PIXELFED_ACCESS_TOKEN, then:
       crow bundle restart pixelfed

  4. Before opening registration or joining major hubs, import a baseline
     moderation blocklist:
       pf_import_blocklist { source: "iftas", confirm: "yes" }
     (queued — confirm in the Nest panel within 72h)

  5. Verify:
       pf_status {}

EOF
