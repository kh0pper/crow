#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# motionEye ships with the user `admin` and NO password, and its settings page offers no
# way to hand that account over to whoever installed it. This script sets the password
# Crow generated before the empty login can be used by anything else on the machine.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin and is
# passed on only through pipes — never in an argument or the environment, and this script
# prints no secret. Exit 0 = the admin now has that password, 3 = motionEye already has a
# password of its own, or its admin account is called something else (left alone),
# 4 = not running / not answering, 5 = motionEye took the new password but the login could
# not be proved, anything else = failed.
#
# How: the password hash lives in /etc/motioneye/motion.conf, which only root can read,
# so everything goes through `docker exec` into the container and uses motionEye's own
# Python module. The running server caches its configuration, hence the mandatory restart.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-motioneye}"
# motionEye has exactly one admin account, and it is normally called `admin`.
ADMIN_USER="${CROW_FIRST_ADMIN_USER:-admin}"

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; motionEye was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; motionEye was not touched."
# The login body below is JSON built with printf, and a quote or a backslash would need
# escaping inside it. Crow's generated passwords never contain either.
case "$PW" in
  *'"'* | *'\'*) die "The password on stdin contains a quote or a backslash; motionEye was not touched." ;;
esac

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the motionEye container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "motionEye is not running; nothing was changed." 4

# ── is there already a password? ────────────────────────────────────────────────────
state="$(docker exec "$CONTAINER" python3 -c 'from motioneye import config; c = config.get_main(); print("%s\t%s" % (c.get("@admin_username") or "", "empty" if not (c.get("@admin_password") or "") else "set"))' < /dev/null 2>/dev/null || true)"
# The probe prints `<username>\t<empty|set>`: an install whose admin account was renamed
# has no password Crow may set, because `admin` is not the account the operator uses.
state_user=""
state_password=""
IFS=$'\t' read -r state_user state_password <<< "$state" || true
if [ -z "$state_user" ] || [ -z "$state_password" ]; then
  die "motionEye's configuration could not be read; nothing was changed."
fi
if [ "$state_user" != "$ADMIN_USER" ]; then
  die "motionEye's admin account is called '$state_user', not '$ADMIN_USER'; left alone." 3
fi
case "$state_password" in
  empty) ;;
  set) die "motionEye already has an admin password; left alone." 3 ;;
  *) die "motionEye's configuration could not be read; nothing was changed." ;;
esac

# ── set it, then restart so the running server reads it ─────────────────────────────
printf '%s\n' "$PW" | docker exec -i "$CONTAINER" python3 -c 'import sys; from motioneye import config; config.set_admin_password(sys.stdin.readline().rstrip("\n"))' ||
  die "motionEye refused the new password; the empty login is unchanged."
say "Set the admin password; restarting motionEye so it takes effect."
docker restart "$CONTAINER" >/dev/null 2>&1 || die "motionEye's container could not be restarted; the new password may not be active yet."

up=""
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" python3 -c 'import http.client; http.client.HTTPConnection("127.0.0.1", 8765, timeout=5).request("HEAD", "/")' < /dev/null >/dev/null 2>&1; then
    up=1
    break
  fi
  sleep 2
done
[ -n "$up" ] || die "motionEye did not answer after the restart; the new password may not be active yet."

# ── prove the new login works ───────────────────────────────────────────────────────
attempt=1
while :; do
  code="$(printf '{"username":"%s","password":"%s"}' "$ADMIN_USER" "$PW" | docker exec -i "$CONTAINER" curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:8765/login 2>/dev/null || true)"
  if [ "$code" = "200" ]; then break; fi
  if [ "$attempt" -ge 3 ]; then break; fi
  attempt=$((attempt + 1))
  sleep 3
done
if [ "$code" != "200" ]; then
  # The configuration is already changed and the server restarted, so the new password IS
  # motionEye's password: Crow keeps it and says it could not prove it (exit 5).
  die "motionEye accepted the new password, but logging in with it did not succeed; open motionEye's own UI and set its admin password there." 5
fi

say "motionEye's admin login for '$ADMIN_USER' now uses the password Crow generated."