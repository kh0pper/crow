#!/usr/bin/env bash
#
# Move this machine's Caddy admin API off its default http://localhost:2019 and
# onto a unix socket only the caddy user (and root) can open.
#
# WHY: Caddy's admin API defaults to a plain TCP listener on localhost:2019 with
# no authentication. Any local account — a default-tier bot included — can POST
# /load there and rewrite the HTTPS front door Caddy serves for Crow, which
# defeats the point of the dedicated proxy socket (a bot that can rewrite the
# front door no longer needs to forge a proxy peer).
#
# WHAT IT DOES (idempotent, so it is safe to re-run):
#   1. adds `admin unix//run/caddy/admin.sock` to the Caddyfile's global block —
#      as the first block when the file has none, inside it when it does. No
#      `|mode` suffix: Caddy's default for a unix listen address is 0200 (owner
#      write only), and the process that creates the socket is the caddy user,
#      which is stricter than root:caddy 0660. `admin off` is never used — that
#      would make `caddy reload` impossible;
#   2. writes a systemd drop-in for caddy.service (RuntimeDirectory=caddy,
#      RuntimeDirectoryMode=0750), because Caddy runs as the caddy user and
#      cannot create a directory under /run itself;
#   3. validates the Caddyfile, daemon-reloads and RESTARTS Caddy — a reload goes
#      through the OLD admin address and cannot move it;
#   4. proves it works: the socket exists, https://<the Caddyfile's site>/health
#      through Caddy answers 200, and `systemctl reload caddy` succeeds (the
#      packaged unit's ExecReload reads the admin address out of THIS Caddyfile,
#      so it must reach the new socket).
#
# Any failure — a failed rewrite assertion, a failed validate, no socket, a
# health check that is not 200, a reload that fails — restores the Caddyfile and
# the drop-in, restarts Caddy the way it was, and exits non-zero.
#
# An admin line that is not Crow's (a TCP address the operator chose, another
# socket, `admin off`) is left alone: that is the owner's own decision.
#
# USAGE:  sudo bash scripts/fix-caddy-admin-socket.sh
#
set -uo pipefail

CADDYFILE="${CROW_CADDYFILE:-/etc/caddy/Caddyfile}"
SYSTEMD_DIR="${CROW_SYSTEMD_DIR:-/etc/systemd/system}"
ADMIN_SOCKET="${CROW_CADDY_ADMIN_SOCKET:-/run/caddy/admin.sock}"
# Only the retry sleeps between checks; tests make it 0 to stay fast.
RETRY_SLEEP="${CROW_FIX_RETRY_SLEEP:-1}"

CADDY_USER="caddy"
CADDY_UNIT_NAME="caddy.service"
DROP_IN_DIR="$SYSTEMD_DIR/$CADDY_UNIT_NAME.d"
DROP_IN="$DROP_IN_DIR/crow-admin-socket.conf"
# The global option this script owns. `unix/` + an absolute path is Caddy's
# unix listen address, so `unix//run/caddy/admin.sock` names /run/caddy/admin.sock.
ADMIN_LINE="admin unix/$ADMIN_SOCKET"

log()  { echo "$*"; }
warn() { echo "$*" >&2; }

# The Caddyfile's first site address (the line that opens a site block), without
# scheme or path: `example.local {` and `https://example.local:8443 {` yield
# `example.local` and `example.local:8443`. Empty when none can be read.
site_address() {
  awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    {
      line = $0
      sub(/[ \t]+#.*$/, "", line)
      # The first block of a Caddyfile may be the global options block: a bare
      # `{`. Its nested options (`log {`, `servers {`) are not sites, so skip the
      # whole block by its brace depth.
      if (depth == 0 && first && line ~ /^[ \t]*\{[ \t]*$/) is_global = 1
      first = 0
      if (depth == 0 && !is_global && index(line, "{") > 0) {
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
      o = gsub(/\{/, "{", line)
      c = gsub(/\}/, "}", line)
      depth += o - c
      if (depth <= 0) { depth = 0; is_global = 0 }
    }
    BEGIN { first = 1 }
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

# Caddy runs as this user and creates the socket itself, so the user must exist
# before a unit that runs it and a socket it owns are worth writing.
if ! getent passwd "$CADDY_USER" >/dev/null 2>&1; then
  echo "No '$CADDY_USER' user on this machine, so there is no Caddy to move. Nothing was changed." >&2
  exit 1
fi

# The admin option, if any: the first token of a line has to be `admin`, so a
# comment mentioning it (and a `respond "admin …"` line) never counts.
ADMIN_OPTION_RE='^[[:space:]]*admin([[:space:]]|$)'
ADMIN_OPTIONS="$(grep -E "$ADMIN_OPTION_RE" "$CADDYFILE" || true)"

DROP_IN_ONLY=0
if [ -n "$ADMIN_OPTIONS" ]; then
  # Only the first word after `admin` counts: a trailing `{` or `# comment` on
  # the line does not change which address it names.
  FIRST_ADMIN="$(printf '%s\n' "$ADMIN_OPTIONS" | head -n 1 | awk '{ print $2 }')"
  case "$FIRST_ADMIN" in
    off)
      log "Already set up: $CADDYFILE has 'admin off', so nothing on this machine can reach Caddy's admin API — nothing to do."
      exit 0
      ;;
    unix/*)
      if [ "$FIRST_ADMIN" = "unix/$ADMIN_SOCKET" ]; then
        # Crow's own line: only the drop-in can still be missing, and without it
        # systemd never creates the directory the socket lives in.
        if [ -f "$DROP_IN" ] && grep -q '^RuntimeDirectory=caddy$' "$DROP_IN" 2>/dev/null; then
          log "Already set up: $CADDYFILE pins the admin API to unix/$ADMIN_SOCKET and $DROP_IN creates its directory — nothing to do."
          exit 0
        fi
        log "$CADDYFILE already pins the admin API to unix/$ADMIN_SOCKET; installing the systemd drop-in that creates its directory."
        DROP_IN_ONLY=1
      else
        log "Already set up: $CADDYFILE already puts the admin API on a unix socket ($FIRST_ADMIN) — nothing to do."
        exit 0
      fi
      ;;
    *)
      echo "The admin line in $CADDYFILE is '$FIRST_ADMIN' — that is your own choice, not Crow's, so this script leaves it alone. Nothing was changed." >&2
      exit 1
      ;;
  esac
fi

BACKUP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$BACKUP_DIR"; }
trap cleanup EXIT

# Restore one file from the backup: absent in the backup means it did not exist
# before this run, so the target goes away again.
restore_file() {
  if [ -f "$1" ]; then cp -a "$1" "$2"; else rm -f "$2"; fi
}

# No backup, no change: these run before the ERR trap exists, so a failed copy
# must stop the script here, not leave a restore that has nothing to restore.
if ! cp -a "$CADDYFILE" "$BACKUP_DIR/Caddyfile"; then
  echo "Could not back up $CADDYFILE — nothing was changed." >&2
  exit 1
fi
if [ -f "$DROP_IN" ] && ! cp -a "$DROP_IN" "$BACKUP_DIR/crow-admin-socket.conf"; then
  echo "Could not back up $DROP_IN — nothing was changed." >&2
  exit 1
fi
SERVICES_TOUCHED=0

restore() {
  local rc=$?
  set +e
  trap - ERR
  echo "FAILED (exit $rc) — restoring the previous setup." >&2
  cp -a "$BACKUP_DIR/Caddyfile" "$CADDYFILE"
  restore_file "$BACKUP_DIR/crow-admin-socket.conf" "$DROP_IN"
  # A failure before any service was touched (a failed assertion or validate)
  # restarts nothing: Caddy was never stopped, so a restart would only be an outage.
  if [ "$SERVICES_TOUCHED" -eq 1 ]; then
    systemctl daemon-reload >/dev/null 2>&1
    systemctl restart "$CADDY_UNIT_NAME" >/dev/null 2>&1
  fi
  echo "The Caddyfile and the caddy.service drop-in are back the way they were." >&2
  exit "$rc"
}
trap restore ERR
set -e

# 1. The admin line. A global options block must be the FIRST block of a
#    Caddyfile, so: inside the existing one when the file already opens with
#    `{`, otherwise as a new block of its own at the top.
if [ "$DROP_IN_ONLY" -eq 0 ]; then
  tmp_caddy="$(mktemp)"
  awk -v line="$ADMIN_LINE" '
    { lines[NR] = $0 }
    END {
      first = 0
      for (i = 1; i <= NR; i++) {
        s = lines[i]
        if (s ~ /^[[:space:]]*$/) continue
        if (s ~ /^[[:space:]]*#/) continue
        first = i
        break
      }
      g = (first > 0) ? lines[first] : ""
      sub(/[ \t]+#.*$/, "", g)
      if (first > 0 && g ~ /^[[:space:]]*\{[[:space:]]*$/) {
        for (i = 1; i <= NR; i++) {
          print lines[i]
          if (i == first) print "\t" line
        }
      } else {
        print "{"
        print "\t" line
        print "}"
        print ""
        for (i = 1; i <= NR; i++) print lines[i]
      }
    }
  ' "$CADDYFILE" > "$tmp_caddy"
  cat "$tmp_caddy" > "$CADDYFILE"
  rm -f "$tmp_caddy"
fi

# 1b. Assert the rewrite before anything is restarted: exactly one admin line,
#     and it is the socket.
ADMIN_COUNT="$(grep -cE "$ADMIN_OPTION_RE" "$CADDYFILE" || true)"
if [ "$ADMIN_COUNT" != "1" ]; then
  echo "The Caddyfile has $ADMIN_COUNT admin option lines after the rewrite instead of 1 — nothing was restarted." >&2
  false
fi
if [ "$(grep -cF "$ADMIN_LINE" "$CADDYFILE" || true)" != "1" ]; then
  echo "The Caddyfile has no '$ADMIN_LINE' line after the rewrite — nothing was restarted." >&2
  false
fi

# The socket's directory. Caddy cannot create it (it is not root), so systemd
# does, on every start, owned by the service user.
mkdir -p "$DROP_IN_DIR"
cat > "$DROP_IN" <<'EOF'
# Crow: Caddy's admin API listens on unix//run/caddy/admin.sock, so only the
# caddy user (and root) can reach it. Caddy cannot create /run/caddy itself, so
# systemd makes it on every start — owned by the service user, mode 0750.
[Service]
RuntimeDirectory=caddy
RuntimeDirectoryMode=0750
EOF

if ! grep -q '^RuntimeDirectory=caddy$' "$DROP_IN"; then
  echo "Could not write $DROP_IN — nothing was restarted." >&2
  false
fi

# 2. Validate before touching the running services, then daemon-reload and a FULL
#    restart: a reload goes through the old admin address and cannot move it.
caddy validate --config "$CADDYFILE"

SERVICES_TOUCHED=1
systemctl daemon-reload
systemctl restart "$CADDY_UNIT_NAME"

# 3. The socket has to exist: Caddy creates it on start, so give it a moment.
SOCKET_READY=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [ -S "$ADMIN_SOCKET" ]; then SOCKET_READY=1; break; fi
  sleep "$RETRY_SLEEP"
done
if [ "$SOCKET_READY" -ne 1 ]; then
  echo "No socket at $ADMIN_SOCKET after restarting $CADDY_UNIT_NAME, so the fix does not work — undoing it." >&2
  false
fi

# 4. Prove it end to end: Caddy must answer /health with 200 for the site it
#    serves. A Caddy that never started, and one that started with a broken
#    config, both fail here.
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
  sleep "$RETRY_SLEEP"
done
if [ "$HEALTH_CODE" != "200" ]; then
  echo "https://$SITE_HOST:$SITE_PORT/health answered '${HEALTH_CODE:-nothing}' instead of 200, so the fix does not work — undoing it." >&2
  false
fi

# 5. A reload must still work: the packaged unit's ExecReload runs `caddy reload`,
#    which reads the admin address out of this Caddyfile. If it fails, the
#    operator's `sudo systemctl reload caddy` is broken and the fix is not kept.
if ! systemctl reload "$CADDY_UNIT_NAME"; then
  echo "'systemctl reload $CADDY_UNIT_NAME' failed with the new admin socket, so the fix does not work — undoing it." >&2
  false
fi

trap - ERR

# 6. Not fatal, only worth saying: something still listening on the old default
#    (127.0.0.1, port 2019) means a Caddy that did not pick the new config up
#    (or a second one). A connection is opened and nothing is sent — no request
#    of any kind, so nothing can act on this.
if (exec 3<>/dev/tcp/127.0.0.1/2019) 2>/dev/null; then
  warn "Note: something still accepts connections on Caddy's old default admin address (127.0.0.1, port 2019). If that is this machine's Caddy, it did not pick up $CADDYFILE — check 'systemctl status $CADDY_UNIT_NAME'."
fi

log "Done: Caddy's admin API is on unix/$ADMIN_SOCKET (owner: $CADDY_USER), not on Caddy's default local TCP port."
log "Verified: https://$SITE_HOST:$SITE_PORT/health answered 200 through Caddy, and 'systemctl reload caddy' works."
log "The drop-in at $DROP_IN creates /run/$CADDY_USER on every start."