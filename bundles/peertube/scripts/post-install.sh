#!/usr/bin/env bash
# PeerTube post-install hook.
#
# 1. Wait for crow-peertube healthy.
# 2. Optionally translate PEERTUBE_S3_* via configure-storage.mjs.
# 3. Capture first-boot admin password from logs.
# 4. Verify federation-network attachment.
# 5. Print next-step guidance.

set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${BUNDLE_DIR}/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

echo "Waiting for PeerTube to report healthy (up to 180s — first-boot migrations + ffmpeg sanity checks)…"
for i in $(seq 1 36); do
  if docker inspect crow-peertube --format '{{.State.Health.Status}}' 2>/dev/null | grep -qw healthy; then
    echo "  → healthy"
    break
  fi
  sleep 5
done

if [ -n "${PEERTUBE_S3_ENDPOINT:-}" ]; then
  echo "PEERTUBE_S3_ENDPOINT detected — translating to PEERTUBE_OBJECT_STORAGE_* envelope…"
  if command -v node >/dev/null 2>&1; then
    node "${BUNDLE_DIR}/scripts/configure-storage.mjs" || {
      echo "WARN: configure-storage.mjs failed; video stays on-disk until env vars are written manually." >&2
    }
  else
    echo "WARN: node not on PATH — cannot run configure-storage.mjs. S3 not wired." >&2
  fi
else
  echo "WARN: PEERTUBE_S3_ENDPOINT not set. Video storage will be on-disk — a single active channel can fill 500 GB within months." >&2
  echo "      Configure S3 + run 'node dist/scripts/migrate-videos-to-object-storage.js' as soon as practical." >&2
fi

if ! docker inspect crow-peertube --format '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | grep -qw crow-federation; then
  echo "WARN: crow-peertube is not on the crow-federation network — Caddy federation site will not reach it by service name" >&2
fi

# Capture initial admin password
ADMIN_PW=$(docker logs crow-peertube 2>&1 | grep -A1 "Username:" | grep "Password:" | head -1 | awk -F': ' '{print $NF}' || true)

cat <<EOF

PeerTube stack is up. Next steps:

  1. Capture + rotate the root password IMMEDIATELY:
EOF
if [ -n "${ADMIN_PW:-}" ]; then
  echo "       Initial root password (rotate now): ${ADMIN_PW}"
else
  echo "       docker logs crow-peertube 2>&1 | grep -A1 'Username'"
fi
cat <<EOF
       docker exec -it crow-peertube npm run reset-password -- -u root

  2. Expose via Caddy (one-time):
       caddy_add_federation_site {
         domain: "${PEERTUBE_WEBSERVER_HOSTNAME:-video.example.com}",
         upstream: "peertube:9000",
         profile: "activitypub-peertube"
       }

  3. Obtain an OAuth bearer token:
       CLIENT=\$(curl -s https://${PEERTUBE_WEBSERVER_HOSTNAME:-<domain>}/api/v1/oauth-clients/local)
       CLIENT_ID=\$(echo "\$CLIENT" | jq -r .client_id)
       CLIENT_SECRET=\$(echo "\$CLIENT" | jq -r .client_secret)
       curl -s -X POST https://${PEERTUBE_WEBSERVER_HOSTNAME:-<domain>}/api/v1/users/token \\
         -H 'Content-Type: application/x-www-form-urlencoded' \\
         -d "client_id=\$CLIENT_ID&client_secret=\$CLIENT_SECRET&grant_type=password&username=root&password=<pw>"
     Paste access_token into .env as PEERTUBE_ACCESS_TOKEN, then:
       crow bundle restart peertube

  4. Verify:
       pt_status {}

EOF
