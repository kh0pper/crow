#!/bin/bash
# Inject Crow Face Tracking into the Open-LLM-VTuber frontend.
# MediaPipe Face Mesh → Live2D parameter mapping.

FRONTEND_HTML="/app/frontend/index.html"

if grep -q "crow-face-tracking" "$FRONTEND_HTML" 2>/dev/null; then
    echo "Face tracking already injected."
    exit 0
fi

echo '<script id="crow-face-tracking">' >> "$FRONTEND_HTML"
cat /app/scripts/crow-face-tracking.js >> "$FRONTEND_HTML"
echo '</script>' >> "$FRONTEND_HTML"

echo "Injected face tracking module."
