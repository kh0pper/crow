#!/bin/bash
# Inject the Crow Voice Panel into the Open-LLM-VTuber frontend.
# Shows a Discord-style side panel with peer avatars and speaking indicators.

FRONTEND_HTML="/app/frontend/index.html"

if grep -q 'id="crow-voice-panel"' "$FRONTEND_HTML" 2>/dev/null; then
    echo "Voice panel already injected."
    exit 0
fi

# Determine profile name and color from env vars
PROFILE_NAME="${COMPANION_PROFILE_1_NAME:-${COMPANION_CHARACTER_NAME:-User}}"
PROFILE_COLOR="${COMPANION_PROFILE_1_COLOR:-#818cf8}"

# Inject profile config
cat >> "$FRONTEND_HTML" << CONFIGSCRIPT
<script id="crow-voice-panel-config">
window.CrowProfile = {
  name: "${PROFILE_NAME}",
  color: "${PROFILE_COLOR}"
};
</script>
CONFIGSCRIPT

# Inject the voice panel script
echo '<script id="crow-voice-panel">' >> "$FRONTEND_HTML"
cat /app/scripts/crow-voice-panel.js >> "$FRONTEND_HTML"
echo '</script>' >> "$FRONTEND_HTML"

echo "Injected voice panel (profile: ${PROFILE_NAME})"
