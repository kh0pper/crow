#!/bin/bash
# Inject the Crow Window Manager into the Open-LLM-VTuber frontend.
# This is a thin wrapper that inlines crow-wm.js as a <script> block.

FRONTEND_HTML="/app/frontend/index.html"

if grep -q "crow-wm" "$FRONTEND_HTML" 2>/dev/null; then
    echo "Window manager already injected."
    exit 0
fi

echo '<script id="crow-wm">' >> "$FRONTEND_HTML"
cat /app/scripts/crow-wm.js >> "$FRONTEND_HTML"
echo '</script>' >> "$FRONTEND_HTML"

echo "Injected window manager"
