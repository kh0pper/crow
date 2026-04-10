#!/bin/bash
# Inject the Crow WebRTC audio bridge into the Open-LLM-VTuber frontend.
# Adds peer-to-peer voice chat between room participants.

FRONTEND_HTML="/app/frontend/index.html"
GATEWAY_URL="${CROW_GATEWAY_URL:-}"

if grep -q "crow-webrtc" "$FRONTEND_HTML" 2>/dev/null; then
    echo "WebRTC audio bridge already injected."
    exit 0
fi

# Inject config block with STUN and gateway URL (no TURN creds — fetched at runtime)
cat >> "$FRONTEND_HTML" << CONFIGSCRIPT
<script id="crow-webrtc-config">
window.CrowWebRTC = {
  gatewayUrl: "${GATEWAY_URL}",
  stunUrl: "stun:stun.l.google.com:19302"
};
</script>
CONFIGSCRIPT

# Inject the WebRTC script
echo '<script id="crow-webrtc">' >> "$FRONTEND_HTML"
cat /app/scripts/crow-webrtc.js >> "$FRONTEND_HTML"
echo '</script>' >> "$FRONTEND_HTML"

echo "Injected WebRTC audio bridge"
