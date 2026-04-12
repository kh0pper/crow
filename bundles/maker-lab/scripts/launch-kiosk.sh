#!/bin/bash
#
# Maker Lab — same-host kiosk launcher.
#
# Opens the Blockly kiosk tile-left and the AI Companion web UI tile-right
# in fullscreen-ish browser windows. Designed for solo-mode-on-same-host
# deployments (e.g., a Raspberry Pi display running Chromium) where there's
# no separate grown-up admin device to hand off a QR code.
#
# Usage:
#   ./launch-kiosk.sh                     # uses http://localhost
#   CROW_HOST=pi5.local ./launch-kiosk.sh # custom host
#   BROWSER=firefox ./launch-kiosk.sh     # force a specific browser
#
# Requirements:
#   - `xdotool` (optional, for window positioning)
#   - A browser on PATH: chromium, google-chrome, chromium-browser, or firefox
#   - Maker Lab installed in solo mode with a default learner + LAN exposure
#     set appropriately (loopback-only works since this runs on the host).
#
# Not a substitute for the Phase 3 pet-mode overlay — this is the web-tiled
# fallback that ships with the bundle until Phase 3 lands.

set -euo pipefail

CROW_HOST="${CROW_HOST:-localhost}"
CROW_PROTO="${CROW_PROTO:-http}"
BROWSER="${BROWSER:-}"
GATEWAY_PORT="${CROW_GATEWAY_PORT:-3002}"
COMPANION_PORT="${COMPANION_PORT:-12393}"

BLOCKLY_URL="${CROW_PROTO}://${CROW_HOST}:${GATEWAY_PORT}/kiosk/"
COMPANION_URL="${CROW_PROTO}://${CROW_HOST}:${COMPANION_PORT}/"

# Pick a browser.
pick_browser() {
  if [ -n "$BROWSER" ]; then echo "$BROWSER"; return; fi
  for b in chromium chromium-browser google-chrome chrome firefox; do
    if command -v "$b" >/dev/null 2>&1; then echo "$b"; return; fi
  done
  echo ""
}

B="$(pick_browser)"
if [ -z "$B" ]; then
  echo "launch-kiosk: no supported browser found. Install chromium or firefox, or set BROWSER." >&2
  exit 1
fi

# Screen size for tiling (defaults to common 1920x1080 if xrandr missing).
SCREEN_W=1920
SCREEN_H=1080
if command -v xrandr >/dev/null 2>&1; then
  read -r SCREEN_W SCREEN_H < <(xrandr --current | awk '/\*/ {print $1; exit}' | awk -F'x' '{print $1" "$2}' || echo "1920 1080")
fi
LEFT_W=$((SCREEN_W * 2 / 3))
RIGHT_W=$((SCREEN_W - LEFT_W))

case "$B" in
  chromium*|google-chrome|chrome)
    "$B" --app="$BLOCKLY_URL" \
         --window-position=0,0 \
         --window-size="${LEFT_W},${SCREEN_H}" \
         --user-data-dir="$HOME/.crow/bundles/maker-lab/chromium-profile-blockly" \
         >/dev/null 2>&1 &
    sleep 1
    "$B" --app="$COMPANION_URL" \
         --window-position="${LEFT_W},0" \
         --window-size="${RIGHT_W},${SCREEN_H}" \
         --user-data-dir="$HOME/.crow/bundles/maker-lab/chromium-profile-companion" \
         >/dev/null 2>&1 &
    ;;
  firefox)
    "$B" --new-window "$BLOCKLY_URL" >/dev/null 2>&1 &
    sleep 1
    "$B" --new-window "$COMPANION_URL" >/dev/null 2>&1 &
    # Firefox can't split windows from the CLI — user needs to tile manually,
    # or call xdotool / the host WM.
    if command -v xdotool >/dev/null 2>&1; then
      sleep 2
      # Best-effort: the two newest Firefox windows get tiled side-by-side.
      readarray -t WINS < <(xdotool search --name "Mozilla Firefox" | tail -2)
      if [ "${#WINS[@]}" -ge 2 ]; then
        xdotool windowmove "${WINS[0]}" 0 0 windowsize "${WINS[0]}" "$LEFT_W" "$SCREEN_H"
        xdotool windowmove "${WINS[1]}" "$LEFT_W" 0 windowsize "${WINS[1]}" "$RIGHT_W" "$SCREEN_H"
      fi
    fi
    ;;
esac

echo "launched: $BLOCKLY_URL (2/3 left) + $COMPANION_URL (1/3 right)"
