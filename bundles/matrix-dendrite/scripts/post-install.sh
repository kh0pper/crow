#!/usr/bin/env bash
# Matrix-Dendrite post-install hook.
#
# The entrypoint does the heavy lifting (signing key + config generation),
# but first-boot timing means we need a health wait before printing the
# registration shared secret + next-step guidance.
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${BUNDLE_DIR}/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

# Wait for Dendrite to become healthy (first boot can take 60+ seconds)
echo "Waiting for Dendrite to report healthy (up to 120s)…"
for i in $(seq 1 24); do
  if docker inspect crow-dendrite --format '{{.State.Health.Status}}' 2>/dev/null | grep -qw healthy; then
    echo "  → healthy"
    break
  fi
  sleep 5
done

# Extract the generated registration shared secret from logs (entrypoint
# prints it on first boot)
SECRET=$(docker logs crow-dendrite 2>&1 | grep -oE 'Registration shared secret: [A-Za-z0-9+/=]+' | tail -1 | cut -d: -f2 | xargs || true)

cat <<EOF

Matrix-Dendrite + Postgres are up.

Next steps:

  1. Expose federation — pick ONE of these two approaches:

     (A) Port 8448 (requires router port-forward):
         caddy_add_federation_site {
           domain: "${MATRIX_HOST:-matrix.example.com}",
           upstream: "dendrite:8008",
           profile: "matrix"
         }
         caddy_add_matrix_federation_port {
           domain: "${MATRIX_HOST:-matrix.example.com}",
           upstream_8448: "dendrite:8448"
         }

     (B) .well-known delegation on the apex:
         caddy_add_federation_site {
           domain: "${MATRIX_HOST:-matrix.example.com}",
           upstream: "dendrite:8008",
           profile: "matrix"
         }
         caddy_set_wellknown {
           domain: "${MATRIX_SERVER_NAME:-example.com}",
           kind: "matrix-server",
           opts: { delegate_to: "${MATRIX_HOST:-matrix.example.com}:443" }
         }

  2. Register the admin account:
       docker exec crow-dendrite \\
         create-account --config /etc/dendrite/dendrite.yaml \\
         --username admin --password '<strong-password>' --admin

EOF

if [ -n "${SECRET:-}" ]; then
  echo "  Registration shared secret (copy to .env as MATRIX_REGISTRATION_SHARED_SECRET):"
  echo "    ${SECRET}"
  echo ""
fi

cat <<EOF
  3. Log in to obtain an access token:
       curl -X POST https://${MATRIX_HOST:-matrix.example.com}/_matrix/client/v3/login \\
         -H 'Content-Type: application/json' \\
         -d '{"type":"m.login.password","user":"admin","password":"<pw>"}'
     Paste access_token and user_id into .env as MATRIX_ACCESS_TOKEN and
     MATRIX_USER_ID, then restart the MCP server.

  4. Verify federation end-to-end:
       matrix_federation_health { server_name: "${MATRIX_SERVER_NAME:-example.com}" }

EOF
