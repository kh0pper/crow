#!/usr/bin/env bash
# Funkwhale post-install hook.
#
# 1. Wait for crow-funkwhale-api to report healthy (first boot runs Django
#    migrations + collectstatic — can take 2+ minutes on cold disks).
# 2. Optionally translate FUNKWHALE_S3_* into AWS_* if S3 storage was
#    configured at install time.
# 3. Verify the crow-federation network is attached to the nginx container
#    (Caddy reverse-proxies to funkwhale-nginx:80).
# 4. Print next-step guidance (superuser creation, Caddy site, token).

set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${BUNDLE_DIR}/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

echo "Waiting for Funkwhale API to report healthy (up to 180s)…"
for i in $(seq 1 36); do
  if docker inspect crow-funkwhale-api --format '{{.State.Health.Status}}' 2>/dev/null | grep -qw healthy; then
    echo "  → healthy"
    break
  fi
  sleep 5
done

# Translate S3 vars if configured
if [ -n "${FUNKWHALE_S3_ENDPOINT:-}" ]; then
  echo "FUNKWHALE_S3_ENDPOINT detected — translating to AWS_* schema via storage-translators…"
  if command -v node >/dev/null 2>&1; then
    node "${BUNDLE_DIR}/scripts/configure-storage.mjs" || {
      echo "WARN: configure-storage.mjs failed; audio uploads will fall back to on-disk until S3 env vars are written manually." >&2
    }
  else
    echo "WARN: node not available on PATH — cannot run configure-storage.mjs. S3 not wired." >&2
  fi
fi

# Verify federation network
if ! docker inspect crow-funkwhale-nginx --format '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | grep -qw crow-federation; then
  echo "WARN: crow-funkwhale-nginx is not on the crow-federation network — Caddy federation sites will not reach it by service name" >&2
fi

cat <<EOF

Funkwhale stack is up. Next steps:

  1. Create the superuser:
       docker exec -it crow-funkwhale-api funkwhale-manage createsuperuser

  2. Expose via Caddy (one-time):
       caddy_add_federation_site {
         domain: "${FUNKWHALE_HOSTNAME:-music.example.com}",
         upstream: "funkwhale-nginx:80",
         profile: "activitypub"
       }

  3. In the web UI, Settings → Applications → New application (all scopes),
     then generate a Personal Access Token. Paste into .env as
     FUNKWHALE_ACCESS_TOKEN, then:
       crow bundle restart funkwhale

  4. Verify:
       fw_status {}

EOF
