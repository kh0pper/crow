#!/usr/bin/env bash
# Mastodon post-install hook.
#
# 1. Wait for web container healthy (first boot = migrations + asset precompile).
# 2. Optionally translate MASTODON_S3_* via configure-storage.mjs.
# 3. Verify federation-network attachment on web + streaming.
# 4. Print next-step guidance (Caddy site, admin creation, PAT, optional
#    single-user-mode toggle).

set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${BUNDLE_DIR}/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

echo "Waiting for Mastodon web to report healthy (up to 240s — first-boot migrations + asset precompile)…"
for i in $(seq 1 48); do
  if docker inspect crow-mastodon-web --format '{{.State.Health.Status}}' 2>/dev/null | grep -qw healthy; then
    echo "  → web healthy"
    break
  fi
  sleep 5
done

echo "Waiting for Mastodon streaming to report healthy (up to 60s)…"
for i in $(seq 1 12); do
  if docker inspect crow-mastodon-streaming --format '{{.State.Health.Status}}' 2>/dev/null | grep -qw healthy; then
    echo "  → streaming healthy"
    break
  fi
  sleep 5
done

if [ -n "${MASTODON_S3_ENDPOINT:-}" ]; then
  echo "MASTODON_S3_ENDPOINT detected — translating to S3_* envelope via storage-translators…"
  if command -v node >/dev/null 2>&1; then
    node "${BUNDLE_DIR}/scripts/configure-storage.mjs" || {
      echo "WARN: configure-storage.mjs failed; media stays on-disk until S3 env vars are written manually." >&2
    }
  else
    echo "WARN: node not on PATH — cannot run configure-storage.mjs. S3 not wired." >&2
  fi
fi

for c in crow-mastodon-web crow-mastodon-streaming crow-mastodon-sidekiq; do
  if ! docker inspect "$c" --format '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | grep -qw crow-federation; then
    echo "WARN: $c is not on the crow-federation network — Caddy federation sites will not reach it by service name" >&2
  fi
done

cat <<EOF

Mastodon stack is up. Next steps:

  1. Create the admin account:
       docker exec -it crow-mastodon-web \\
         bin/tootctl accounts create admin \\
           --email <you@example.com> --confirmed --role Admin

  2. Expose via Caddy (one-time):
       caddy_add_federation_site {
         domain: "${MASTODON_LOCAL_DOMAIN:-mastodon.example.com}",
         upstream: "mastodon-web:3000",
         profile: "activitypub-mastodon"
       }
     The activitypub-mastodon profile wires /api/v1/streaming to
     mastodon-streaming:4000 and sets Mastodon's static-asset cache headers.

  3. Log in at https://${MASTODON_LOCAL_DOMAIN:-<your-domain>}/.
     Settings → Development → New Application, grant
       read write follow push admin:read admin:write
     then generate an access token. Paste into .env as
     MASTODON_ACCESS_TOKEN, then:
       crow bundle restart mastodon

  4. Before opening registration or federating widely, import a baseline
     moderation blocklist:
       mastodon_import_blocklist { source: "iftas", confirm: "yes" }
     (queued — confirm in the Nest panel within 72h)

  5. Verify:
       mastodon_status {}

EOF
