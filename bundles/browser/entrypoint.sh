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
# RFB is a unix socket inside this container, never a TCP port (RFB_PORT, an
# older compose's setting, is no longer used).
VNC_DIR=/run/crow-vnc
RFB_SOCK="${VNC_DIR}/rfb.sock"
TOKEN_FILE="${VNC_DIR}/tokens"
# The token arrives as a file (compose `configs`, mode 0400, copied into the
# container at create), never as an environment variable.
TOKEN_SRC=/run/secrets/crow-vnc-token
PROFILE_DIR=/root/.config/chromium-crow
INSTANCE_MARKER="${PROFILE_DIR}/.crow-instance"
SCREEN="1920x1080x24"

log() { echo "[crow-browser] $*"; }
die() { echo "[crow-browser] FATAL: $*" >&2; exit 1; }

# The noVNC viewer has no password prompt: it is reached only through the Crow
# gateway's signed-in /proxy/browser/ route. Loopback alone is NOT a boundary
# under network_mode: host (any local process, or a web page via ws://127.0.0.1
# or DNS rebinding, can reach a loopback port), so:
#   - RFB (x11vnc) listens on NO TCP port at all: only on a 0600 unix socket in
#     a 0700 directory inside this container, which host processes cannot see;
#   - websockify (127.0.0.1 only) connects a WebSocket to that socket only when
#     the upgrade's Host header is the per-instance token (--host-token) that the
#     gateway adds server-side from the bundle's .env. No page or URL carries
#     it, and a wrong token is refused without being logged (QuietTokenFile);
#   - the X display has a real per-container MIT cookie and listens on no TCP
#     and no abstract socket (abstract sockets belong to the network namespace,
#     which is the host's here): only the unix socket in this container's own
#     /tmp. x11vnc runs -noremote.
# NOT covered here: Chrome DevTools (CDP) on 127.0.0.1:${CDP_PORT} has no
# authentication, so any process of any uid on this machine can drive the
# browser through it. That is tracked separately.
# An older install's .env may still pass VNC_PASSWORD: it is ignored, and
# never printed.
if [ -n "${VNC_PASSWORD:-}" ]; then
  log "VNC_PASSWORD is set but no longer used (the viewer is behind the Crow sign-in); ignoring it."
fi
unset VNC_PASSWORD

# The token: read from its 0400 file into websockify's 0600 token file. Never
# echoed, never exported (a VNC_TOKEN env from an earlier build is dropped).
unset VNC_TOKEN
VNC_TOKEN_VALUE="$(tr -d '\r\n' < "$TOKEN_SRC" 2>/dev/null)"
if ! [[ "$VNC_TOKEN_VALUE" =~ ^[A-Za-z0-9_-]{32,256}$ ]]; then
  die "the viewer token (${TOKEN_SRC}) is missing or malformed. Crow generates CROW_BROWSER_VNC_TOKEN at install, in this bundle's .env, and compose hands it in as that file."
fi
rm -rf "$VNC_DIR"
mkdir -m 700 "$VNC_DIR" || die "cannot create ${VNC_DIR}"
( umask 077; printf '%s: unix_socket:%s\n' "$VNC_TOKEN_VALUE" "$RFB_SOCK" > "$TOKEN_FILE" ) || die "cannot write the token file"
unset VNC_TOKEN_VALUE

# websockify's token lookup that never echoes the token it was handed: stock
# websockify logs "Token '<value>' not found", which would print a valid token
# whenever the gateway's (.env) and this container's copy differ.
cat > "${VNC_DIR}/crow_quiet_token.py" <<'PY'
from websockify.token_plugins import ReadOnlyTokenFile
from websockify.websockifyserver import WebSockifyServer


class QuietTokenFile(ReadOnlyTokenFile):
    def lookup(self, token):
        target = super().lookup(token)
        if target is None:
            raise WebSockifyServer.EClose("token not accepted")
        return target
PY
chmod 600 "${VNC_DIR}/crow_quiet_token.py"

# --- Which Crow instance this profile belongs to ---
# The profile volume is named per instance; the marker inside it is the second
# lock: a volume mounted into another instance's container (a compose -p
# mistake) refuses to start instead of opening someone else's logins.
CROW_INSTANCE="${CROW_INSTANCE:-}"
[ -n "$CROW_INSTANCE" ] || die "CROW_INSTANCE is not set (compose passes this instance's CROW_HOME)"
# Compared canonically on both sides (a symlinked or trailing-slash CROW_HOME is
# the same instance). The path is the HOST's, so -m: it need not exist here.
CROW_INSTANCE="$(realpath -m -- "$CROW_INSTANCE")"
mkdir -p "$PROFILE_DIR"
if [ -f "$INSTANCE_MARKER" ]; then
  [ "$(realpath -m -- "$(cat "$INSTANCE_MARKER")")" = "$CROW_INSTANCE" ] \
    || die "this browser profile belongs to the Crow instance at '$(head -c 200 "$INSTANCE_MARKER")', not '${CROW_INSTANCE}'. Refusing to open another instance's logins: check the volume and the compose project."
else
  printf '%s' "$CROW_INSTANCE" > "$INSTANCE_MARKER"
  log "profile marked for instance ${CROW_INSTANCE}."
fi
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

# no_tcp_listeners PID TABLE... — true when process PID owns no LISTEN socket
# in the given /proc/net/tcp{,6}-format tables (matched by socket inode).
no_tcp_listeners() {
  local pid="$1"; shift
  local inodes
  inodes=$(for fd in /proc/"$pid"/fd/*; do readlink "$fd" 2>/dev/null; done | sed -n 's/^socket:\[\([0-9]*\)\]$/\1/p' | sort -u | tr '\n' ' ')
  [ -n "$inodes" ] || return 0
  ! awk -v want=" $inodes" 'FNR > 1 && $4 == "0A" && index(want, " " $10 " ") { found = 1 } END { exit found ? 0 : 1 }' "$@" 2>/dev/null
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
  die "$2 on port $1 is not loopback-only. Refusing to run: the viewer must never be reachable from the network."
}

# --- Clean stale X locks/sockets (root cause of the 2026-05 crash loop) ---
log "Cleaning stale X locks for display :${DISP_NUM}..."
rm -f "/tmp/.X${DISP_NUM}-lock" "/tmp/.X11-unix/X${DISP_NUM}" 2>/dev/null || true
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# --- A real X cookie, fresh per start (x11vnc and Chromium inherit XAUTHORITY) ---
export XAUTHORITY=/root/.Xauthority
rm -f "$XAUTHORITY"
( umask 077; : > "$XAUTHORITY" )
xauth -q -f "$XAUTHORITY" add ":${DISP_NUM}" . "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" \
  || die "cannot create the X cookie"
chmod 600 "$XAUTHORITY"

# --- Xvfb: cookie required; no TCP, no abstract socket (host-wide under host
# networking); only /tmp/.X11-unix/X<n> in this container's own /tmp ---
log "Starting Xvfb on :${DISP_NUM} (${SCREEN})..."
Xvfb ":${DISP_NUM}" -screen 0 "${SCREEN}" -auth "$XAUTHORITY" -nolisten tcp -nolisten local &
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
if grep -q "@/tmp/.X11-unix/X${DISP_NUM}\$" /proc/net/unix 2>/dev/null; then
  die "an abstract X socket for :${DISP_NUM} exists on this host (another Crow browser from before 1.3.12 on the same display number?). Refusing to run: it is reachable by every process on the machine."
fi
log "Xvfb ready (pid ${XVFB_PID}), cookie required, no TCP or abstract socket."

# --- x11vnc: RFB on a unix socket only ---
log "Starting x11vnc on a unix socket..."
# -unixsock: the only way in. -rfbport 0 -rfbportv6 0 -noipv6: no TCP listener,
# v4 or v6. -nopw: no VNC password, and no warning about it. -noremote: no
# `x11vnc -R` remote control (it could reopen an RFB TCP port).
x11vnc -display ":${DISP_NUM}" -auth "$XAUTHORITY" -forever -shared \
  -nopw -noremote -unixsock "$RFB_SOCK" -rfbport 0 -rfbportv6 0 -noipv6 -noxdamage -quiet &
X11VNC_PID=$!
ready=0
for i in $(seq 1 20); do
  kill -0 "$X11VNC_PID" 2>/dev/null || die "x11vnc failed to start"
  if [ -S "$RFB_SOCK" ]; then ready=1; break; fi
  sleep 0.5
done
[ "$ready" = 1 ] || die "x11vnc did not create ${RFB_SOCK} within 10s"
chmod 600 "$RFB_SOCK" || die "cannot restrict ${RFB_SOCK}"
sleep 0.5
no_tcp_listeners "$X11VNC_PID" /proc/net/tcp /proc/net/tcp6 \
  || die "x11vnc is listening on a TCP port. Refusing to run: RFB must only be reachable through the unix socket."
log "x11vnc up (pid ${X11VNC_PID}), RFB on a unix socket only."

# --- noVNC / websockify ---
log "Starting noVNC on 127.0.0.1:${NOVNC_PORT} (token required)..."
# The static noVNC files are served to anyone on loopback; a WebSocket reaches
# RFB only with the token as its Host header (TokenFile maps it to the socket).
PYTHONPATH="$VNC_DIR" websockify --web /usr/share/novnc \
  --token-plugin crow_quiet_token.QuietTokenFile --token-source "$TOKEN_FILE" \
  --host-token "127.0.0.1:${NOVNC_PORT}" &
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

# --- Graceful stop: docker stop (SIGTERM via init) reaches this shell only.
# Hand it to Chromium and wait, so it flushes cookies and logins to the profile
# (compose stop_grace_period: 30s) instead of being SIGKILLed with the rest. ---
# Chromium's own SIGTERM path exits WITHOUT committing its cookie store (proven
# in a throwaway container), so close it the way a user would: CDP
# Browser.close, then fall back to SIGTERM.
cdp_close() {
  timeout 10 python3 - "$CDP_PORT" <<'PY' >/dev/null 2>&1
import base64, json, os, socket, sys, urllib.request
port = int(sys.argv[1])
url = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json/version" % port, timeout=3))["webSocketDebuggerUrl"]
path = url.split(":%d" % port, 1)[1]
s = socket.create_connection(("127.0.0.1", port), timeout=5)
s.sendall(("GET %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, port, base64.b64encode(os.urandom(16)).decode())).encode())
head = b""
while b"\r\n\r\n" not in head:
    d = s.recv(4096)
    if not d:
        sys.exit(1)
    head += d
if b" 101 " not in head.split(b"\r\n")[0]:
    sys.exit(1)
msg = json.dumps({"id": 1, "method": "Browser.close"}).encode()
mask = os.urandom(4)
s.sendall(bytes([0x81, 0x80 | len(msg)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(msg)))
try:
    s.recv(4096)
except OSError:
    pass
PY
}

shutdown() {
  log "stopping: closing Chromium..."
  cdp_close || true
  for i in $(seq 1 30); do
    kill -0 "$CHROME_PID" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$CHROME_PID" 2>/dev/null; then
    kill -TERM "$CHROME_PID" 2>/dev/null
    for i in $(seq 1 10); do
      kill -0 "$CHROME_PID" 2>/dev/null || break
      sleep 0.5
    done
  fi
  kill "$X11VNC_PID" "$WEBSOCKIFY_PID" "$XVFB_PID" 2>/dev/null || true
  log "stopped."
  exit 0
}
trap shutdown TERM INT

# --- Supervise: if Chromium dies, take the container down so it restarts ---
wait "$CHROME_PID"
EXIT_CODE=$?
log "Chromium exited (code ${EXIT_CODE}); shutting down so the container restarts."
kill "$X11VNC_PID" "$WEBSOCKIFY_PID" "$XVFB_PID" 2>/dev/null || true
exit "${EXIT_CODE:-1}"
