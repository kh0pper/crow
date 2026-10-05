#!/bin/bash
# Started by cage (crow-kiosk-cage.service) as the kiosk user. Opens the Crow kiosk page full-screen.
set -euo pipefail
# shellcheck source=/dev/null
. /etc/crow-kiosk/kiosk.env            # CROW_URL=https://<tailnet-host>:8444
PROFILE="${HOME}/.config/chromium-kiosk"
# Display rotation (pi-setup --rotate). cage 0.3 has no rotate option; wlr-randr talks to cage's
# output-management protocol. Touch is rotated separately by a udev calibration rule.
case "${ROTATE:-0}" in
  90|180|270) TRANSFORM="$ROTATE" ;;
  *) TRANSFORM="" ;;
esac
if [ -n "$TRANSFORM" ] && command -v wlr-randr >/dev/null; then
  OUTPUT="$(wlr-randr 2>/dev/null | awk '/^[^ ]/ {print $1; exit}')"
  if [ -n "$OUTPUT" ]; then
    wlr-randr --output "$OUTPUT" --transform "$TRANSFORM" || echo "kiosk-launch: rotation failed on $OUTPUT" >&2
  fi
fi
mkdir -p "$PROFILE/Default"
# A power cut must not leave a "restore pages?" bubble on an unattended screen.
if [ -f "$PROFILE/Default/Preferences" ]; then
  sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' \
    "$PROFILE/Default/Preferences"
fi
exec /usr/bin/chromium \
  --user-data-dir="$PROFILE" \
  --ozone-platform=wayland \
  --kiosk --noerrdialogs --disable-session-crashed-bubble --no-first-run \
  --password-store=basic \
  --autoplay-policy=no-user-gesture-required \
  --renderer-process-limit=2 \
  --disable-features=Translate,MediaRouter \
  --overscroll-history-navigation=0 --disable-pinch \
  "${CROW_URL}/display?agent=1"
