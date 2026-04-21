#!/usr/bin/env bash
# motionEye bundle post-install hook.
#
# 1. Create host data directories (config + media).
# 2. Soft disk check: warn if < 50 GB free, abort only if < 10 GB.
# 3. Wait for crow-motioneye to report healthy.
# 4. Print first-login guidance (admin / <empty password>).

set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${BUNDLE_DIR}/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

CONFIG_PATH="${MOTIONEYE_CONFIG_PATH:-${HOME}/.crow/data/motioneye/config}"
MEDIA_PATH="${MOTIONEYE_MEDIA_PATH:-${HOME}/.crow/data/motioneye/media}"

# Tilde-expand if the env file literally stored ~/...
CONFIG_PATH="${CONFIG_PATH/#\~/$HOME}"
MEDIA_PATH="${MEDIA_PATH/#\~/$HOME}"

mkdir -p "$CONFIG_PATH" "$MEDIA_PATH"
echo "✓ motionEye data directories ready at $CONFIG_PATH and $MEDIA_PATH"

# Disk pre-check — parent directory exists even on a fresh host
PARENT="$(dirname "$MEDIA_PATH")"
[ -d "$PARENT" ] || mkdir -p "$PARENT"
FREE_GB="$(df -BG "$PARENT" | awk 'NR==2 {gsub("G","",$4); print $4}')"
FREE_GB="${FREE_GB:-0}"

if [ "$FREE_GB" -lt 10 ]; then
  echo "ERROR: only ${FREE_GB} GB free on $(df -h "$PARENT" | awk 'NR==2 {print $1}') — refuse to install." >&2
  echo "       Free some disk space or point MOTIONEYE_MEDIA_PATH at a larger volume." >&2
  exit 1
fi

if [ "$FREE_GB" -lt 50 ]; then
  echo "WARN: only ${FREE_GB} GB free on the media filesystem." >&2
  echo "      motionEye with motion-triggered recording uses ~1-3 GB per camera per week at 720p." >&2
fi

# Health-check wait — motionEye boots quickly
echo "Waiting for motionEye to report healthy (up to 60s)..."
for i in $(seq 1 12); do
  if docker inspect crow-motioneye --format '{{.State.Health.Status}}' 2>/dev/null | grep -qw healthy; then
    echo "  → healthy"
    break
  fi
  sleep 5
done

cat <<EOF

motionEye is up. Next steps:

  1. Open the Web UI:
       http://localhost:8765
     Default login: username 'admin', password '' (empty).
     Rotate immediately via Settings → General.

  2. Add a camera via the UI:
     - Click the hamburger menu → "add camera"
     - For RTSP: Type "Network camera", paste the RTSP URL, click OK
     - For USB: Type "V4L2 camera", pick the /dev/videoN device

  3. Set recording retention under each camera's Settings → Movies → "preserve movies"

  4. Storage: recordings land in ${MEDIA_PATH} on the host.

Note: motionEye is iframe-only in Crow — no MCP tools yet. If you want
"list cameras" / "list events" from the AI, install the Frigate bundle
alongside.

EOF
