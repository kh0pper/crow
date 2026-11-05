#!/usr/bin/env bash
#
# Point this machine's Caddy at the gateway's dedicated proxy socket
# (the security audit's finding N1a-3/N1a-4).
#
# WHY: the installer used to write `reverse_proxy localhost:3001`, so visitors
# came to the gateway as a loopback socket carrying X-Forwarded-For — a shape
# the gateway must call `unverified` (any local process can write the same
# header), so Crow's Nest turned the owner away right after first-run setup.
# The gateway now listens on a unix socket (CROW_PROXY_SOCKET) whose filesystem
# permissions decide who may connect, and Caddy dials that instead.
#
# WHAT IT DOES (idempotent, so it is safe to re-run):
#   1. backs up the Caddyfile and the gateway unit;
#   2. adds the proxy-socket settings through a systemd drop-in;
#   3. rewrites only the matching `reverse_proxy localhost:3001` line;
#   4. adds the caddy service user to this user's group (so it may traverse
#      /run/crow and open the 0660 socket);
#   5. validates the Caddyfile, then reloads systemd, restarts the gateway and
#      reloads Caddy.
# Any failure restores the backups and says so.
#
# USAGE:  sudo bash scripts/fix-caddy-proxy-socket.sh
#
set -uo pipefail

CADDYFILE="${CROW_CADDYFILE:-/etc/caddy/Caddyfile}"
GATEWAY_UNIT="/etc/systemd/system/crow-gateway.service"
DROP_IN_DIR="/etc/systemd/system/crow-gateway.service.d"
DROP_IN="$DROP_IN_DIR/proxy-socket.conf"
SOCKET_PATH="/run/crow/gateway.sock"
CADDY_GROUP="caddy"
OWNER="${CROW_PROXY_SOCKET_OWNER:-${SUDO_USER:-$(id -un)}}"

log() { echo "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo: sudo bash $0" >&2
  exit 1
fi

if [ ! -r "$CADDYFILE" ]; then
  log "No readable Caddyfile at $CADDYFILE — nothing to fix here."
  exit 0
fi

# Already applied? Then there is nothing to restart.
needs_caddyfile_edit=1
if ! grep -Eq '^[[:space:]]*reverse_proxy[[:space:]]+(localhost|127\.0\.0\.1):3001([[:space:]]|$)' "$CADDYFILE"; then
  needs_caddyfile_edit=0
fi
needs_drop_in=1
if [ -f "$DROP_IN" ] && grep -q 'CROW_PROXY_SOCKET=' "$DROP_IN"; then
  needs_drop_in=0
fi
if [ "$needs_caddyfile_edit" -eq 0 ] && [ "$needs_drop_in" -eq 0 ]; then
  log "Caddy already dials the gateway's proxy socket — nothing to do."
  exit 0
fi

BACKUP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$BACKUP_DIR"; }
trap cleanup EXIT

cp -a "$CADDYFILE" "$BACKUP_DIR/Caddyfile"
if [ -f "$GATEWAY_UNIT" ]; then cp -a "$GATEWAY_UNIT" "$BACKUP_DIR/crow-gateway.service"; fi
if [ -f "$DROP_IN" ]; then cp -a "$DROP_IN" "$BACKUP_DIR/proxy-socket.conf"; fi

restore() {
  local rc=$?
  trap - ERR
  echo "FAILED (exit $rc) — restoring the backups." >&2
  cp -a "$BACKUP_DIR/Caddyfile" "$CADDYFILE"
  if [ -f "$BACKUP_DIR/crow-gateway.service" ]; then
    cp -a "$BACKUP_DIR/crow-gateway.service" "$GATEWAY_UNIT"
  fi
  if [ -f "$BACKUP_DIR/proxy-socket.conf" ]; then
    cp -a "$BACKUP_DIR/proxy-socket.conf" "$DROP_IN"
  else
    rm -f "$DROP_IN"
  fi
  systemctl daemon-reload >/dev/null 2>&1 || true
  if systemctl is-enabled --quiet crow-gateway >/dev/null 2>&1; then
    systemctl restart crow-gateway >/dev/null 2>&1 || true
  fi
  systemctl reload caddy >/dev/null 2>&1 || true
  echo "The Caddyfile and the gateway unit are back the way they were." >&2
  exit "$rc"
}
trap restore ERR
set -e

# 1. The unit settings, as a drop-in so the shipped unit keeps its shape.
mkdir -p "$DROP_IN_DIR"
cat > "$DROP_IN" <<'EOF'
# Crow: the gateway also listens on a dedicated proxy socket (the security
# audit's finding), so Caddy's visitors are a verified `proxy` with the client
# Caddy names instead of an unverifiable loopback peer the dashboard refuses.
# RuntimeDirectory=crow creates /run/crow for the gateway's user; Caddy, in the
# same group, traverses it and opens the 0660 socket.
[Service]
RuntimeDirectory=crow
RuntimeDirectoryMode=0750
Environment=CROW_PROXY_SOCKET=/run/crow/gateway.sock
EOF

# 2. Only the loopback dial line is rewritten; everything else stays as it is.
tmp_caddy="$(mktemp)"
sed -E 's#^([[:space:]]*)reverse_proxy[[:space:]]+(localhost|127\.0\.0\.1):3001([[:space:]]*)$#\1reverse_proxy unix//run/crow/gateway.sock#' \
  "$CADDYFILE" > "$tmp_caddy"
cat "$tmp_caddy" > "$CADDYFILE"
rm -f "$tmp_caddy"

# 3. Caddy must be in this user's group to reach the socket.
if getent group "$CADDY_GROUP" >/dev/null 2>&1; then
  usermod -aG "$OWNER" "$CADDY_GROUP"
else
  log "No '$CADDY_GROUP' service user on this machine — skipping the group change."
fi

# 4. Validate before touching the running services.
caddy validate --config "$CADDYFILE"

systemctl daemon-reload
systemctl restart crow-gateway
systemctl reload caddy

trap - ERR
log "Done: Caddy now dials unix/$SOCKET_PATH, and the gateway serves it."
log "Give the gateway a moment after the restart, then open Crow's Nest as usual."