#!/bin/bash
# Inject the per-device kiosk config applier (Part 3) into the OLVV frontend.
# Reads ?device=<id>, fetches /companion/device-config, applies the bound bot's
# character preset + companion_features. Must run AFTER inject-bg-refresh (which
# sets up window.CrowWS) and inject-voice-panel (the social panel it toggles).

FRONTEND_HTML="/app/frontend/index.html"

if grep -q 'id="crow-device-config"' "$FRONTEND_HTML" 2>/dev/null; then
    echo "Device-config applier already injected."
    exit 0
fi

echo '<script id="crow-device-config">' >> "$FRONTEND_HTML"
cat /app/scripts/crow-device-config.js >> "$FRONTEND_HTML"
echo '</script>' >> "$FRONTEND_HTML"
echo "Injected per-device kiosk config applier."
