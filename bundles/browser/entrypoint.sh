#!/bin/bash
set -e

CDP_PORT="${CDP_PORT:-9222}"

# Start virtual framebuffer
echo "[crow-browser] Starting Xvfb..."
Xvfb :99 -screen 0 1920x1080x24 -ac &
sleep 1

# Start VNC server (password required)
echo "[crow-browser] Starting x11vnc..."
if [ -z "$VNC_PASSWORD" ]; then
  echo "[crow-browser] ERROR: VNC_PASSWORD is required"
  exit 1
fi
x11vnc -display :99 -forever -passwd "$VNC_PASSWORD" -rfbport 5900 &
sleep 1

# Start noVNC web viewer
echo "[crow-browser] Starting noVNC at http://localhost:6080..."
websockify --web /usr/share/novnc 6080 localhost:5900 &
sleep 1

# Launch Chromium with remote debugging
echo "[crow-browser] Launching Chromium with CDP on port $CDP_PORT..."
CHROME_PATH=$(find /root/.cache/ms-playwright -name "chrome" -type f 2>/dev/null | head -1)
if [ -z "$CHROME_PATH" ]; then
  echo "[crow-browser] ERROR: Chrome not found in Playwright cache"
  exit 1
fi

DISPLAY=:99 $CHROME_PATH \
  --no-sandbox --disable-setuid-sandbox \
  --remote-debugging-port="$CDP_PORT" \
  --remote-debugging-address=0.0.0.0 \
  --disable-blink-features=AutomationControlled \
  --window-size=1920,1080 --start-maximized \
  --no-first-run --no-default-browser-check \
  --disable-infobars --disable-extensions \
  "about:blank" &
sleep 3

echo ""
echo "============================================="
echo "  Crow Browser — Ready"
echo "  VNC viewer:  http://localhost:6080/vnc.html"
echo "  CDP port:    $CDP_PORT"
echo "============================================="
echo ""

# Keep container alive
tail -f /dev/null
