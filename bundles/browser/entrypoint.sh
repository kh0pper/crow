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
# The tokens arrive as files (compose `configs`, mode 0400, copied into the
# container at create), never as environment variables.
TOKEN_SRC=/run/secrets/crow-vnc-token
CDP_TOKEN_SRC=/run/secrets/crow-cdp-token
# The relay writes this once Chromium's pipe answers Browser.getVersion.
CDP_READY_FILE=/tmp/cdp-relay.ready
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
# Chrome DevTools is not a network port at all (1.5.0): Chromium runs with
# --remote-debugging-pipe, and the only door is cdp-relay.mjs, which owns fds 3/4
# and serves 127.0.0.1:${CDP_PORT} ONLY to a caller holding this instance's
# CROW_BROWSER_CDP_TOKEN (constant-time bearer check; /json/version and one
# WebSocket path, everything else 404; header cap, connection cap, handshake
# timeout; no header value is ever logged). Chromium gets no
# --remote-debugging-port and no --remote-allow-origins, so there is no
# unauthenticated door and no Origin check to disable.
# What that keeps out: other uids, other containers, web pages (including pages
# this browser itself loads), and a bot whose network is unshared. What it does
# NOT keep out: a same-uid process that can read this bundle's .env, which is
# where the token lives — a default (`auto`-tier) bot can, until the CROW_BOT_UID
# containment work lands. The token arrives as a 0400 file, is never in any argv,
# and is stripped from the environment Chromium inherits.
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

# The CDP token: the relay reads this file itself, so the value is never a shell
# variable, never an argv and never an environment variable. Checked here only to
# fail fast and say why; the relay applies the same rule and refuses to open a port
# without it (compose passes ${CROW_BROWSER_CDP_TOKEN:-}, so an unminted one arrives
# as an empty file rather than a compose error).
[ -s "$CDP_TOKEN_SRC" ] || die "the CDP token (${CDP_TOKEN_SRC}) is missing or empty. Crow generates CROW_BROWSER_CDP_TOKEN at install, in this bundle's .env, and compose hands it in as that file; the container does not start without it."
grep -qE '^[A-Za-z0-9_-]{32,256}$' "$CDP_TOKEN_SRC" || die "the CDP token (${CDP_TOKEN_SRC}) is malformed (32-256 characters of A-Za-z0-9_-). Crow generates it at install; fix this bundle's .env and recreate the container."

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
  die "$2 on port $1 is not loopback-only. Refusing to run: nothing here may be reachable from the network."
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
  die "an abstract X socket for :${DISP_NUM} exists on this host (another Crow browser from before 1.4.0 on the same display number?). Refusing to run: it is reachable by every process on the machine."
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

# --- Chromium, behind the CDP relay ---
CHROME_PATH=$(find /root/.cache/ms-playwright -name "chrome" -type f 2>/dev/null | head -1)
[ -n "$CHROME_PATH" ] || die "Chrome not found in Playwright cache"

# Optional upstream proxy (http://host:port or socks5://host:port). Empty = direct.
# The relay turns CHROME_PROXY into Chromium's --proxy-server flag (it is the one that
# execs Chromium now).
if [ -n "${CHROME_PROXY:-}" ]; then
  log "Routing through proxy: ${CHROME_PROXY}"
fi

RELAY="$(dirname "$0")/cdp-relay.mjs"
[ -f "$RELAY" ] || die "the CDP relay (${RELAY}) is missing from the image: rebuild the browser image"
# Paths only: the relay reads the token from its 0400 file and strips any
# token-shaped variable from the environment Chromium inherits.
export CHROME_PATH
export CROW_CHROMIUM_PROFILE="$PROFILE_DIR"
export CROW_CDP_TOKEN_FILE="$CDP_TOKEN_SRC"
export CROW_CDP_READY_FILE="$CDP_READY_FILE"
# docker start keeps /tmp: a ready file from an earlier run of this container would
# let the readiness loop pass before Chromium has answered.
rm -f "$CDP_READY_FILE"

log "Launching Chromium on a pipe (CDP relay on 127.0.0.1:${CDP_PORT})..."
node "$RELAY" &
RELAY_PID=$!

# Readiness is the relay's ready file: it appears only once Chromium's pipe has
# answered Browser.getVersion, so a pass means the browser really is there.
ready=0
for i in $(seq 1 120); do
  if ! kill -0 "$RELAY_PID" 2>/dev/null; then
    die "the CDP relay exited during startup (token, Chromium or flags; see the log above)"
  fi
  if [ -s "$CDP_READY_FILE" ]; then
    ready=1; break
  fi
  sleep 0.5
done
[ "$ready" = 1 ] || die "the CDP relay did not report ready on 127.0.0.1:${CDP_PORT} within 60s"
# The relay is the only listener; Chromium itself opens no port at all.
require_loopback "${CDP_PORT}" cdp-relay

echo ""
echo "============================================="
echo "  Crow Browser — Ready (verified)"
echo "  noVNC:     http://127.0.0.1:${NOVNC_PORT}/vnc.html (loopback; open it through the Crow dashboard)"
echo "  CDP:       http://127.0.0.1:${CDP_PORT}/json/version (bearer token required)"
echo "============================================="
echo ""

# --- Graceful stop: docker stop (SIGTERM via init) reaches this shell only.
# The relay owns the graceful part (Chromium's own SIGTERM path exits WITHOUT
# committing its cookie store): it sends Browser.close over the pipe, waits up to
# 10 s for Chromium to exit, then kills it. We allow 15 s here, inside compose's
# 30 s stop_grace_period, and stop the display only after the browser is gone.
shutdown() {
  log "stopping: closing Chromium through the relay..."
  kill -TERM "$RELAY_PID" 2>/dev/null || true
  for i in $(seq 1 30); do
    kill -0 "$RELAY_PID" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$RELAY_PID" 2>/dev/null; then
    log "the relay did not stop within 15s; killing it"
    kill -KILL "$RELAY_PID" 2>/dev/null || true
  fi
  rm -f "$CDP_READY_FILE"
  kill "$X11VNC_PID" "$WEBSOCKIFY_PID" "$XVFB_PID" 2>/dev/null || true
  log "stopped."
  exit 0
}
trap shutdown TERM INT

# --- Supervise: the relay owns Chromium's fate (it exits with Chromium's code), so a
# dead relay means a dead browser: take the container down so it restarts.
wait "$RELAY_PID"
EXIT_CODE=$?
log "the CDP relay exited (code ${EXIT_CODE}); shutting down so the container restarts."
rm -f "$CDP_READY_FILE"
kill "$X11VNC_PID" "$WEBSOCKIFY_PID" "$XVFB_PID" 2>/dev/null || true
exit "${EXIT_CODE:-1}"
