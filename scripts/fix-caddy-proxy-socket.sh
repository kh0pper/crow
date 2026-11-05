#!/usr/bin/env bash
#
# Point this machine's Caddy at the gateway's dedicated proxy socket, which
# SYSTEMD owns (the security audit's finding N1a-3/N1a-4).
#
# WHY: the installer used to write `reverse_proxy localhost:3001`, so visitors
# came to the gateway as a loopback socket carrying X-Forwarded-For — a shape
# the gateway must call `unverified` (any local process can write the same
# header), so Crow's Nest turned the owner away right after first-run setup.
#
# WHAT IT DOES (idempotent, so it is safe to re-run):
#   1. installs the socket unit crow-gateway-proxy.socket — root:caddy 0660 on
#      /run/crow-proxy/gateway.sock — so only the local Caddy can open it and the
#      gateway's own user (the bots running as it included) cannot;
#   2. adds the three unit lines to the gateway through a systemd drop-in
#      (Sockets=/Requires=/After=), so the gateway receives the socket's
#      listening fd by socket activation instead of creating a path itself;
#   3. rewrites only the matching loopback `reverse_proxy` line in the Caddyfile;
#   4. daemon-reloads, starts the socket, restarts the gateway and RESTARTS Caddy
#      (a reload would leave the old loopback upstream in place);
#   5. proves it works: https://<the Caddyfile's site>/health through Caddy must
#      answer 200.
#
# Any failure — a failed rewrite assertion, a failed validate, a gateway that
# will not start, or a health check that is not 200 — restores every file, stops
# the socket if this run created it, and exits non-zero.
#
# No user is added to any group: the socket's group is `caddy`, not the
# operator's, so Caddy never reads the operator's files.
#
# USAGE:  sudo bash scripts/fix-caddy-proxy-socket.sh
#
set -uo pipefail

CADDYFILE="${CROW_CADDYFILE:-/etc/caddy/Caddyfile}"
GATEWAY_UNIT_NAME="crow-gateway.service"
GATEWAY_UNIT="/etc/systemd/system/$GATEWAY_UNIT_NAME"
SOCKET_UNIT_NAME="crow-gateway-proxy.socket"
SOCKET_UNIT="/etc/systemd/system/$SOCKET_UNIT_NAME"
SOCKET_PATH="/run/crow-proxy/gateway.sock"
DROP_IN_DIR="/etc/systemd/system/$GATEWAY_UNIT_NAME.d"
DROP_IN="$DROP_IN_DIR/proxy-socket.conf"
CADDY_GROUP="caddy"

# The loopback dial and the unix dial, as one pair of shapes shared by the grep
# check and the sed rewrite: the address must be followed by something that is
# not part of an address (a space, a ` {`, a comment, the end of the line), so
# `:3001` matches and `:30010`/`:3001.5` do not.
LOOPBACK_RE='^[[:space:]]*reverse_proxy[[:space:]]+(localhost|127\.0\.0\.1):3001([^[:alnum:].:]|$)'
UNIX_RE='^[[:space:]]*reverse_proxy[[:space:]]+unix//run/crow-proxy/gateway\.sock([^[:alnum:].:]|$)'

log() { echo "$*"; }

# The Caddyfile's first site address (the line that opens a site block), without
# scheme or path: `example.local {` and `https://example.local:8443 {` yield
# `example.local` and `example.local:8443`. Empty when none can be read.
site_address() {
  awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    index($0, "{") > 0 {
      line = $0
      sub(/\{.*/, "", line)
      n = split(line, parts, /[[:space:]]+/)
      for (i = 1; i <= n; i++) {
        addr = parts[i]
        if (addr == "") continue
        sub(/^[a-z]+:\/\//, "", addr)
        sub(/\/.*$/, "", addr)
        print addr
        exit
      }
    }
  ' "$CADDYFILE"
}

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo: sudo bash $0" >&2
  exit 1
fi

if [ ! -r "$CADDYFILE" ]; then
  log "No readable Caddyfile at $CADDYFILE — nothing to fix here."
  exit 0
fi

# The socket unit names the caddy user's group, so both must exist. Fail clearly
# rather than install a unit that cannot start.
if ! id "$CADDY_GROUP" >/dev/null 2>&1; then
  echo "No '$CADDY_GROUP' user on this machine, so there is no Caddy to point at the socket. Nothing was changed." >&2
  exit 1
fi
if ! getent group "$CADDY_GROUP" >/dev/null 2>&1; then
  echo "No '$CADDY_GROUP' group on this machine (the socket unit needs SocketGroup=$CADDY_GROUP). Nothing was changed." >&2
  exit 1
fi

# For the messages only: this script changes no group membership, so the
# gateway's user only has to be named back to the operator.
GATEWAY_USER="$(systemctl show -p User --value "$GATEWAY_UNIT_NAME" 2>/dev/null || true)"
GATEWAY_USER="${GATEWAY_USER:-unknown}"

# Already applied? The socket unit exists AND the gateway's Sockets= names it —
# then there is nothing to restart. (Two separate facts on purpose: a unit file
# alone does not prove the gateway uses it.)
GATEWAY_SOCKETS="$(systemctl show -p Sockets --value "$GATEWAY_UNIT_NAME" 2>/dev/null || true)"
ALREADY=0
if [ -f "$SOCKET_UNIT" ]; then
  case " $GATEWAY_SOCKETS " in
    *" $SOCKET_UNIT_NAME "*) ALREADY=1 ;;
  esac
fi
if [ "$ALREADY" -eq 1 ]; then
  log "Already set up: $SOCKET_UNIT_NAME owns $SOCKET_PATH and $GATEWAY_UNIT_NAME uses it — nothing to do."
  exit 0
fi

BACKUP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$BACKUP_DIR"; }
trap cleanup EXIT

# Restore one file from the backup: absent in the backup means it did not exist
# before this run, so the target goes away again.
restore_file() {
  if [ -f "$1" ]; then cp -a "$1" "$2"; else rm -f "$2"; fi
}

SOCKET_WAS_MISSING=0
if [ ! -f "$SOCKET_UNIT" ]; then SOCKET_WAS_MISSING=1; fi

cp -a "$CADDYFILE" "$BACKUP_DIR/Caddyfile"
if [ -f "$GATEWAY_UNIT" ]; then cp -a "$GATEWAY_UNIT" "$BACKUP_DIR/crow-gateway.service"; fi
if [ -f "$DROP_IN" ]; then cp -a "$DROP_IN" "$BACKUP_DIR/proxy-socket.conf"; fi
if [ -f "$SOCKET_UNIT" ]; then cp -a "$SOCKET_UNIT" "$BACKUP_DIR/crow-gateway-proxy.socket"; fi

restore() {
  local rc=$?
  set +e
  trap - ERR
  echo "FAILED (exit $rc) — restoring the previous setup." >&2
  cp -a "$BACKUP_DIR/Caddyfile" "$CADDYFILE"
  restore_file "$BACKUP_DIR/crow-gateway.service" "$GATEWAY_UNIT"
  restore_file "$BACKUP_DIR/proxy-socket.conf" "$DROP_IN"
  restore_file "$BACKUP_DIR/crow-gateway-proxy.socket" "$SOCKET_UNIT"
  if [ "$SOCKET_WAS_MISSING" -eq 1 ]; then
    systemctl disable --now "$SOCKET_UNIT_NAME" >/dev/null 2>&1
  fi
  systemctl daemon-reload >/dev/null 2>&1
  if systemctl is-enabled --quiet "$GATEWAY_UNIT_NAME" >/dev/null 2>&1; then
    systemctl restart "$GATEWAY_UNIT_NAME" >/dev/null 2>&1
  fi
  systemctl restart caddy >/dev/null 2>&1
  echo "The Caddyfile, the gateway unit and the proxy socket are back the way they were." >&2
  exit "$rc"
}
trap restore ERR
set -e

# 1. The socket unit: systemd, not the gateway, owns the socket. 0660 root:caddy
#    means exactly the local Caddy can connect; DirectoryMode=0755 gives it the
#    /run/crow-proxy directory to traverse, owned by the directory systemd creates root-owned.
cat > "$SOCKET_UNIT" <<'EOF'
[Unit]
Description=Crow gateway proxy socket (for the local Caddy only)
[Socket]
ListenStream=/run/crow-proxy/gateway.sock
Service=crow-gateway.service
SocketUser=root
SocketGroup=caddy
SocketMode=0660
DirectoryMode=0755
[Install]
WantedBy=sockets.target
EOF

# 2. The gateway's three lines, as a drop-in so the shipped unit keeps its shape.
#    Sockets= (a [Service] key) is what passes the listening fd to the
#    service: the gateway then calls listen({ fd }) and never touches a path.
mkdir -p "$DROP_IN_DIR"
cat > "$DROP_IN" <<'EOF'
# Crow: the gateway listens on the systemd-owned proxy socket (the security
# audit's finding) instead of creating one itself, so only the local Caddy can
# connect and no process running as the gateway's user can forge a proxy peer.
[Unit]
Requires=crow-gateway-proxy.socket
After=crow-gateway-proxy.socket
[Service]
Sockets=crow-gateway-proxy.socket
EOF

# 3. Only the loopback dial line is rewritten; everything else stays as it is,
#    including a trailing ` {` or a trailing comment on that line.
tmp_caddy="$(mktemp)"
sed -E 's#^([[:space:]]*reverse_proxy[[:space:]]+)(localhost|127\.0\.0\.1):3001([^[:alnum:].:]|$)#\1unix//run/crow-proxy/gateway.sock\3#' \
  "$CADDYFILE" > "$tmp_caddy"
cat "$tmp_caddy" > "$CADDYFILE"
rm -f "$tmp_caddy"

# 3b. Assert both halves of the rewrite before anything is restarted. Same shape
#     as the sed above, so the check and the rewrite cannot disagree.
if grep -Eq "$LOOPBACK_RE" "$CADDYFILE"; then
  echo "The Caddyfile still dials localhost:3001 after the rewrite — nothing was restarted." >&2
  false
fi
if ! grep -Eq "$UNIX_RE" "$CADDYFILE"; then
  echo "The Caddyfile has no 'reverse_proxy unix/$SOCKET_PATH' line after the rewrite — nothing was restarted." >&2
  false
fi

# 4. Validate before touching the running services, then: socket first, then the
#    gateway that requires it, then a full Caddy restart (a reload keeps the old
#    upstream connection pool).
caddy validate --config "$CADDYFILE"

systemctl daemon-reload
systemctl enable --now "$SOCKET_UNIT_NAME"
systemctl restart "$GATEWAY_UNIT_NAME"
systemctl restart caddy

# 5. Prove it end to end: Caddy must answer /health with 200 for the site it
#    serves. A gateway that is up but unlistened, a socket the gateway never got,
#    and a Caddy still on loopback all fail here — and restoring is the answer.
SITE_ADDR="$(site_address)"
if [ -z "$SITE_ADDR" ]; then
  echo "Could not read a site address from $CADDYFILE, so the fix cannot be verified — nothing to keep." >&2
  false
fi
SITE_HOST="${SITE_ADDR%%:*}"
SITE_PORT="${SITE_ADDR##*:}"
if [ "$SITE_PORT" = "$SITE_ADDR" ] || [ -z "$SITE_PORT" ]; then SITE_PORT=443; fi

log "Verifying https://$SITE_HOST:$SITE_PORT/health through Caddy ..."
HEALTH_CODE=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  HEALTH_CODE="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
    --resolve "$SITE_HOST:$SITE_PORT:127.0.0.1" \
    "https://$SITE_HOST:$SITE_PORT/health" 2>/dev/null || true)"
  if [ "$HEALTH_CODE" = "200" ]; then break; fi
  sleep 1
done
if [ "$HEALTH_CODE" != "200" ]; then
  echo "https://$SITE_HOST:$SITE_PORT/health answered '${HEALTH_CODE:-nothing}' instead of 200, so the fix does not work — undoing it." >&2
  false
fi

trap - ERR
log "Done: Caddy dials unix/$SOCKET_PATH, owned by $SOCKET_UNIT_NAME as root:$CADDY_GROUP 0660."
log "Verified: https://$SITE_HOST:$SITE_PORT/health answered 200 through Caddy."
log "The gateway ($GATEWAY_USER) received the socket from systemd; no group membership changed."