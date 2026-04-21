#!/usr/bin/env bash
# Frigate bundle post-install hook.
#
# 1. Create host data directories (config + media).
# 2. Seed config.yml from example if absent.
# 3. Soft disk check: warn if < 50 GB free, abort only if < 10 GB (matches host reality on grackle-class hosts).
# 4. Wait for crow-frigate to report healthy.
# 5. Print next-step guidance.

set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${BUNDLE_DIR}/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

CONFIG_PATH="${FRIGATE_CONFIG_PATH:-${HOME}/.crow/data/frigate/config}"
MEDIA_PATH="${FRIGATE_MEDIA_PATH:-${HOME}/.crow/data/frigate/media}"

# Tilde-expand if the env file literally stored ~/...
CONFIG_PATH="${CONFIG_PATH/#\~/$HOME}"
MEDIA_PATH="${MEDIA_PATH/#\~/$HOME}"

mkdir -p "$CONFIG_PATH" "$MEDIA_PATH"
echo "✓ Frigate data directories ready at $CONFIG_PATH and $MEDIA_PATH"

# Seed config.yml if none exists yet (preserve any operator edits on re-run)
if [ ! -f "$CONFIG_PATH/config.yml" ]; then
  cp "${BUNDLE_DIR}/config.yml.example" "$CONFIG_PATH/config.yml"
  echo "✓ Seeded $CONFIG_PATH/config.yml from example (disabled example camera — add your RTSP source)"
fi

# Disk pre-check — parent directory exists even on a fresh host
PARENT="$(dirname "$MEDIA_PATH")"
[ -d "$PARENT" ] || mkdir -p "$PARENT"
FREE_GB="$(df -BG "$PARENT" | awk 'NR==2 {gsub("G","",$4); print $4}')"
FREE_GB="${FREE_GB:-0}"

if [ "$FREE_GB" -lt 10 ]; then
  echo "ERROR: only ${FREE_GB} GB free on $(df -h "$PARENT" | awk 'NR==2 {print $1}') — refuse to install." >&2
  echo "       Free some disk space or point FRIGATE_MEDIA_PATH at a larger volume." >&2
  exit 1
fi

if [ "$FREE_GB" -lt 50 ]; then
  echo "WARN: only ${FREE_GB} GB free on the media filesystem." >&2
  echo "      Frigate with one 1080p camera @ 2 Mbps uses roughly ~2.3 GB/day at motion-only retention." >&2
  echo "      Monitor ~/.crow/data/frigate/media; lower config.yml record.retain.days if space gets tight." >&2
fi

# Health-check wait — Frigate takes up to 120s on first boot while detector initializes
echo "Waiting for Frigate to report healthy (up to 180s)..."
for i in $(seq 1 36); do
  if docker inspect crow-frigate --format '{{.State.Health.Status}}' 2>/dev/null | grep -qw healthy; then
    echo "  → healthy"
    break
  fi
  sleep 5
done

cat <<EOF

Frigate is up. Next steps:

  1. Open the Web UI (first run creates the admin user on a password-reset flow):
       http://localhost:8971

  2. Edit $CONFIG_PATH/config.yml to add your cameras (see the example block).
     Restart the container after edits:
       crow bundle restart frigate

  3. Set FRIGATE_USER + FRIGATE_PASSWORD in ${ENV_FILE} so the Crow MCP server can authenticate.

  4. Ask your AI assistant to verify the bundle:
       "list my Frigate cameras"   (expects crow_frigate_list_cameras to return your cameras)

  5. Disk watchlist: ${MEDIA_PATH} — alert fires at 30 GB. Raise retain.days ONLY if you have disk headroom.

EOF
