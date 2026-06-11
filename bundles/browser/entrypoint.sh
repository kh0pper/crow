#!/bin/bash
# crow-browser entrypoint — hardened.
# Fails loudly (non-zero exit) so `restart: unless-stopped` actually recovers,
# instead of zombie-ing on a dead X server. Cleans stale X locks, waits for
# each component to be genuinely ready, and monitors Chromium so a crash
# recycles the container.
set -uo pipefail

DISP_NUM=99
DISPLAY=":${DISP_NUM}"
export DISPLAY
CDP_PORT="${CDP_PORT:-9222}"
SCREEN="1920x1080x24"

log() { echo "[crow-browser] $*"; }
die() { echo "[crow-browser] FATAL: $*" >&2; exit 1; }

if [ -z "${VNC_PASSWORD:-}" ]; then
  die "VNC_PASSWORD is required"
fi

# --- Clean stale X locks/sockets (root cause of the 2026-05 crash loop) ---
log "Cleaning stale X locks for display :${DISP_NUM}..."
rm -f "/tmp/.X${DISP_NUM}-lock" "/tmp/.X11-unix/X${DISP_NUM}" 2>/dev/null || true
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# --- Xauthority so x11vnc never falls into the MIT-MAGIC-COOKIE hunt ---
export XAUTHORITY=/root/.Xauthority
touch "$XAUTHORITY"

# --- Xvfb ---
log "Starting Xvfb on :${DISP_NUM} (${SCREEN})..."
Xvfb ":${DISP_NUM}" -screen 0 "${SCREEN}" -ac -nolisten tcp &
XVFB_PID=$!

# Wait until the X server actually answers (xdpyinfo), not a blind sleep.
ready=0
for i in $(seq 1 30); do
  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    die "Xvfb process died during startup (see logs above)"
  fi
  if xdpyinfo -display ":${DISP_NUM}" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
[ "$ready" = 1 ] || die "Xvfb did not become ready on :${DISP_NUM} within 15s"
log "Xvfb ready (pid ${XVFB_PID})."

# --- x11vnc ---
log "Starting x11vnc..."
x11vnc -display ":${DISP_NUM}" -auth "$XAUTHORITY" -forever -shared \
  -passwd "$VNC_PASSWORD" -rfbport 5900 -noxdamage -quiet &
X11VNC_PID=$!
sleep 1
kill -0 "$X11VNC_PID" 2>/dev/null || die "x11vnc failed to start"
log "x11vnc up (pid ${X11VNC_PID})."

# --- noVNC / websockify ---
log "Starting noVNC on :6080..."
websockify --web /usr/share/novnc 6080 localhost:5900 &
WEBSOCKIFY_PID=$!
sleep 1
kill -0 "$WEBSOCKIFY_PID" 2>/dev/null || die "websockify failed to start"

# --- Chromium with CDP ---
CHROME_PATH=$(find /root/.cache/ms-playwright -name "chrome" -type f 2>/dev/null | head -1)
[ -n "$CHROME_PATH" ] || die "Chrome not found in Playwright cache"

# Optional upstream proxy (http://host:port or socks5://host:port). Empty = direct.
PROXY_FLAG=""
if [ -n "${CHROME_PROXY:-}" ]; then
  log "Routing through proxy: ${CHROME_PROXY}"
  PROXY_FLAG="--proxy-server=${CHROME_PROXY}"
fi

log "Launching Chromium ($CHROME_PATH) with CDP on 127.0.0.1:${CDP_PORT}..."
"$CHROME_PATH" \
  --no-sandbox --disable-setuid-sandbox \
  --remote-debugging-port="$CDP_PORT" \
  --remote-debugging-address=127.0.0.1 \
  --remote-allow-origins=* \
  --disable-blink-features=AutomationControlled \
  --window-size=1920,1080 --start-maximized \
  --no-first-run --no-default-browser-check \
  --disable-infobars --disable-extensions \
  --user-data-dir=/root/.config/chromium-crow \
  ${PROXY_FLAG} \
  "about:blank" &
CHROME_PID=$!

# Wait for the CDP endpoint to actually answer.
ready=0
for i in $(seq 1 40); do
  if ! kill -0 "$CHROME_PID" 2>/dev/null; then
    die "Chromium exited during startup (X server / flags problem)"
  fi
  if curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
[ "$ready" = 1 ] || die "CDP did not come up on 127.0.0.1:${CDP_PORT} within 20s"

echo ""
echo "============================================="
echo "  Crow Browser — Ready (verified)"
echo "  noVNC:     http://localhost:6080/vnc.html"
echo "  CDP:       http://127.0.0.1:${CDP_PORT}/json/version"
echo "============================================="
echo ""

# --- Supervise: if Chromium dies, take the container down so it restarts ---
wait "$CHROME_PID"
EXIT_CODE=$?
log "Chromium exited (code ${EXIT_CODE}); shutting down so the container restarts."
kill "$X11VNC_PID" "$WEBSOCKIFY_PID" "$XVFB_PID" 2>/dev/null || true
exit "${EXIT_CODE:-1}"
