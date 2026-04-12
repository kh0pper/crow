#!/bin/bash
set -e

echo "=== Crow AI Companion ==="

# Check for additional Live2D models
bash /app/scripts/download-models.sh

# Patch Open-LLM-VTuber for reliable multi-turn tool calling
echo "Applying tool calling patches..."
python3 /app/scripts/patch-tool-calling.py

# Patch auto-grouping for household mode (if profiles are configured)
echo "Applying auto-group patch..."
python3 /app/scripts/patch-auto-group.py

# Maker Lab: patch tutor-event WebSocket handler (idempotent; no-op if missing)
if [ -f /app/scripts/patch-tutor-event.py ]; then
  echo "Applying Maker Lab tutor-event patch..."
  python3 /app/scripts/patch-tutor-event.py || echo "  (patch failed; companion will continue without tutor-event support)"
fi

# Generate conf.yaml from Crow's AI profiles
echo "Generating config from Crow AI profiles..."
APP_DIR=/app uv run python3 /app/scripts/generate-config.py

# Start notification bridge in the background
echo "Starting notification bridge..."
uv run python3 /app/scripts/notify-bridge.py &

# Inject Crow Dark Editorial theme (CSS into <head>, must run first)
echo "Injecting theme..."
bash /app/scripts/inject-theme.sh

# Inject SDXL background auto-refresh into frontend
echo "Injecting background refresh..."
bash /app/scripts/inject-bg-refresh.sh

# Inject window manager (must run after bg-refresh for shared WS bridge)
echo "Injecting window manager..."
bash /app/scripts/inject-wm.sh

# Inject WebRTC audio bridge (must run after bg-refresh for shared WS bridge)
echo "Injecting WebRTC audio bridge..."
bash /app/scripts/inject-webrtc.sh

# Inject voice panel (must run after WebRTC for stream API access)
echo "Injecting voice panel..."
bash /app/scripts/inject-voice-panel.sh

# Inject face tracking (MediaPipe Face Mesh → Live2D, optional toggle)
echo "Injecting face tracking..."
bash /app/scripts/inject-face-tracking.sh

# If calls bundle is installed, layer enhancements on top
CALLS_DIR="/crow-bundles/calls"
if [ -d "$CALLS_DIR/scripts" ]; then
  echo "Calls bundle detected, injecting enhancements..."
  bash /app/scripts/inject-call-enhancements.sh "$CALLS_DIR"
fi

# Start Open-LLM-VTuber
echo "Starting companion server..."
exec uv run run_server.py
