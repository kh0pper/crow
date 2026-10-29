#!/bin/bash
# crow-browser entrypoint — hardened.
# Fails loudly (non-zero exit) so `restart: unless-stopped` actually recovers,
# instead of zombie-ing on a dead X server. Cleans stale X locks, waits for
# each component to be genuinely ready, and monitors Chromium so a crash
# recycles the container.
set -uo pipefail

DISP_NUM="${DISPLAY_NUM:-99}"
DISPLAY=":${DISP_NUM}"
export DISPLAY
CDP_PORT="${CDP_PORT:-9222}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
RFB_PORT="${RFB_PORT:-5900}"
SCREEN="1920x1080x24"

log() { echo "[crow-browser] $*"; }
die() { echo "[crow-browser] FATAL: $*" >&2; exit 1; }

# The noVNC viewer has no password of its own: it is reached only through the
# Crow gateway's signed-in /proxy/browser/ route, so the dashboard session is
# the credential and LOOPBACK-ONLY listening is the security boundary (checked
# below; the container refuses to run without it). An older install's .env may
# still pass VNC_PASSWORD: it is ignored, and never printed.
if [ -n "${VNC_PASSWORD:-}" ]; then
  log "VNC_PASSWORD is set but no longer used (the viewer is behind the Crow sign-in); ignoring it."
fi
unset VNC_PASSWORD

# loopback_only PORT TABLE... — true only when something LISTENs on PORT in the
# given /proc/net/tcp{,6}-format tables and every such listener is a loopback
# address: 127.0.0.0/8, ::1 or ::ffff:127.x. Addresses there are hex in host
# byte order, so 127.0.0.1 reads 0100007F. Host networking shares the host's
# socket tables with this container, so this sees exactly what the LAN sees.
loopback_only() {
  local port="$1"; shift
  local hex addr found=0
  hex=$(printf '%04X' "$port")
  while read -r addr; do
    [ -n "$addr" ] || continue
    found=1
    case "$addr" in
      ??????7F|00000000000000000000000001000000|0000000000000000FFFF0000??????7F) ;;
      *) echo "[crow-browser] port ${port} has a listener on a non-loopback address (${addr})" >&2; return 1 ;;
    esac
  done < <(awk -v p="$hex" 'FNR > 1 && $4 == "0A" { n = split($2, a, ":"); if (a[n] == p) print a[1] }' "$@" 2>/dev/null)
  [ "$found" = 1 ] || { echo "[crow-browser] nothing listens on port ${port}" >&2; return 1; }
}

# require_loopback PORT NAME — wait up to 10 s for NAME to listen on PORT, then
# insist that every listener is loopback. Anything else stops the container.
require_loopback() {
  local i
  for i in $(seq 1 20); do
    if loopback_only "$1" /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
      log "$2 listens on loopback only (port $1)."
      return 0
    fi
    sleep 0.5
  done
  loopback_only "$1" /proc/net/tcp /proc/net/tcp6 || true
  die "$2 on port $1 is not loopback-only. Refusing to run: the viewer has no password, so it must never be reachable from the network."
}

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

# A display answering is NOT proof it is OURS. Abstract X sockets
# (@/tmp/.X11-unix/XNN) are scoped to the network namespace, which
# network_mode:host shares, so a co-hosted instance already on this number
# answers xdpyinfo while our own Xvfb loses the bind and dies — and x11vnc
# would then attach to THEIR display. Confirm our process actually survived.
sleep 0.5
if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  die "Xvfb on :${DISP_NUM} died — another container is already using that display. Set CROW_BROWSER_DISPLAY to a number no other Crow instance uses."
fi
log "Xvfb ready (pid ${XVFB_PID})."

# --- x11vnc ---
log "Starting x11vnc..."
# -localhost: listen on 127.0.0.1 only. -nopw: no password, and no warning
# about it (the gateway's sign-in is the gate).
x11vnc -display ":${DISP_NUM}" -auth "$XAUTHORITY" -forever -shared \
  -localhost -nopw -rfbport "${RFB_PORT}" -noxdamage -quiet &
X11VNC_PID=$!
sleep 1
kill -0 "$X11VNC_PID" 2>/dev/null || die "x11vnc failed to start"
require_loopback "${RFB_PORT}" x11vnc
log "x11vnc up (pid ${X11VNC_PID})."

# --- noVNC / websockify ---
log "Starting noVNC on 127.0.0.1:${NOVNC_PORT}..."
websockify --web /usr/share/novnc "127.0.0.1:${NOVNC_PORT}" "127.0.0.1:${RFB_PORT}" &
WEBSOCKIFY_PID=$!
sleep 1
kill -0 "$WEBSOCKIFY_PID" 2>/dev/null || die "websockify failed to start"
require_loopback "${NOVNC_PORT}" websockify

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
echo "  noVNC:     http://127.0.0.1:${NOVNC_PORT}/vnc.html (loopback; open it through the Crow dashboard)"
echo "  CDP:       http://127.0.0.1:${CDP_PORT}/json/version"
echo "============================================="
echo ""

# --- Supervise: if Chromium dies, take the container down so it restarts ---
wait "$CHROME_PID"
EXIT_CODE=$?
log "Chromium exited (code ${EXIT_CODE}); shutting down so the container restarts."
kill "$X11VNC_PID" "$WEBSOCKIFY_PID" "$XVFB_PID" 2>/dev/null || true
exit "${EXIT_CODE:-1}"
