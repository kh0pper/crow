#!/usr/bin/env bash
# Lemmy post-install hook.
#
# 1. Wait for crow-lemmy to report healthy (first-boot migrations + pict-rs
#    sled DB init).
# 2. Verify crow-federation network attachment on lemmy + lemmy-ui.
# 3. Print next-step guidance (Caddy site, setup wizard, JWT login).

set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${BUNDLE_DIR}/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

echo "Waiting for Lemmy to report healthy (up to 120s)…"
for i in $(seq 1 24); do
  if docker inspect crow-lemmy --format '{{.State.Health.Status}}' 2>/dev/null | grep -qw healthy; then
    echo "  → lemmy healthy"
    break
  fi
  sleep 5
done

echo "Waiting for Lemmy-UI to report healthy (up to 60s)…"
for i in $(seq 1 12); do
  if docker inspect crow-lemmy-ui --format '{{.State.Health.Status}}' 2>/dev/null | grep -qw healthy; then
    echo "  → lemmy-ui healthy"
    break
  fi
  sleep 5
done

for c in crow-lemmy crow-lemmy-ui; do
  if ! docker inspect "$c" --format '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | grep -qw crow-federation; then
    echo "WARN: $c is not on the crow-federation network — Caddy federation site will not reach it by service name" >&2
  fi
done

cat <<EOF

Lemmy stack is up. Next steps:

  1. Expose via Caddy (one-time):
       caddy_add_federation_site {
         domain: "${LEMMY_HOSTNAME:-lemmy.example.com}",
         upstream: "lemmy-ui:1234",
         profile: "activitypub"
       }

  2. Open https://${LEMMY_HOSTNAME:-<your-domain>}/ and complete the setup
     wizard (admin username + password + site name). The compose
     entrypoint writes a placeholder admin_pending account; the wizard
     replaces it.

  3. Obtain a JWT:
       curl -X POST https://${LEMMY_HOSTNAME:-<your-domain>}/api/v3/user/login \\
         -H 'Content-Type: application/json' \\
         -d '{"username_or_email":"admin","password":"<your-pw>"}'
     Paste the returned jwt into .env as LEMMY_JWT, then:
       crow bundle restart lemmy

  4. Verify:
       lemmy_status {}

EOF
