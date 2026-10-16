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

  1. Lemmy created the admin admin_pending with the password Crow generated
     at install (Settings -> Passwords). There is no setup wizard.

  2. Expose ${LEMMY_HOSTNAME:-<your-domain>} with a Caddy site that sends /api,
     /pictrs, /feeds, /nodeinfo, /.well-known and ActivityPub requests to
     lemmy:8536 and everything else to lemmy-ui:1234 (lemmy-ui does not proxy
     the API).

  3. Obtain a JWT:
       curl -X POST https://${LEMMY_HOSTNAME:-<your-domain>}/api/v3/user/login \\
         -H 'Content-Type: application/json' \\
         -d '{"username_or_email":"admin_pending","password":"<from Settings -> Passwords>"}'
     Put the returned jwt in LEMMY_JWT, then restart the extension.

  4. Verify:
       lemmy_status {}

EOF
