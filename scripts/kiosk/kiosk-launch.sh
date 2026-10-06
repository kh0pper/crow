#!/bin/bash
# Started by cage (crow-kiosk-cage.service) as the kiosk user. Opens the Crow kiosk page full-screen.
set -euo pipefail
# shellcheck source=/dev/null
. /etc/crow-kiosk/kiosk.env            # CROW_URL=https://<tailnet-host>:8444
PROFILE="${HOME}/.config/chromium-kiosk"
# Bluetooth speaker: give it up to 20 s to appear as a PipeWire sink before Chromium opens its audio
# output, so the stream starts on the speaker and not on the (silent) headphone jack. If it does not
# come, start anyway: the agent moves Chromium's streams when the speaker connects, and captions cover it.
if [ -n "${BT_SINK:-}" ] && command -v pactl >/dev/null; then
  want="bluez_output.$(printf '%s' "$BT_SINK" | tr ':a-f' '_A-F')"
  for _ in $(seq 1 20); do
    pactl list short sinks 2>/dev/null | grep -q "	$want" && break
    sleep 1
  done
fi
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
