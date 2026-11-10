#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# Linkding's own first-run page lets whoever reaches it first create the superuser, and
# that page answers on 127.0.0.1 — an install left alone is claimable by anything else on
# the machine. This script creates that account itself, with the password Crow generated,
# before the operator's first visit.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin and is
# passed on only through a pipe — never in an argument or the environment, and this script
# prints no secret. Exit 0 = the admin now has that password, 3 = Linkding already has an
# account of its own (left alone), 4 = not running / not answering, 5 = Linkding took the
# new password but the login could not be proved, anything else = failed.
#
# How: Linkding ships Django, runs as root and keeps manage.py in the container's workdir,
# so everything goes through `docker exec` and Django's own shell. The username and the
# password reach a snippet as the first and second stdin line, so no value is ever
# interpolated into code.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-linkding}"
# Linkding's own first-run page asks for a username; Crow creates `admin`. An empty value
# is refused below rather than silently replaced, because an empty one means the
# declaration is broken — only an UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-admin}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; Linkding was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; Linkding was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; Linkding was not touched."

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Linkding container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Linkding is not running; nothing was changed." 4

# ── wait for the app (a first start migrates the database first) ────────────────────
up=""
for _ in $(seq 1 45); do
  if docker exec "$CONTAINER" curl -fsS -o /dev/null http://127.0.0.1:9090/health </dev/null >/dev/null 2>&1; then
    up=1
    break
  fi
  sleep 2
done
[ -n "$up" ] || die "Linkding did not answer on its health endpoint; nothing was changed." 4

# ── is there already an account? ────────────────────────────────────────────────────
# Linkding has no separate admin flag: the first account made on its setup page IS the
# superuser, so any existing user means the operator already has a login of their own.
DETECT='from django.contrib.auth import get_user_model as g
print("USERS=%d" % g().objects.count())'
state="$(docker exec "$CONTAINER" python manage.py shell -c "$DETECT" </dev/null 2>/dev/null || true)"
users="$(printf '%s\n' "$state" | sed -n 's/^USERS=\([0-9][0-9]*\)$/\1/p' | tail -n 1)"
[ -n "$users" ] || die "Linkding's user table could not be read; nothing was changed." 4
[ "$users" = "0" ] || die "Linkding already has an account; left alone." 3

# ── create it (username on the first stdin line, password on the second) ────────────
CREATE='import sys
from django.contrib.auth import get_user_model
username = sys.stdin.readline().rstrip("\n")
password = sys.stdin.readline().rstrip("\n")
users = get_user_model()
if users.objects.exists():
    print("EXISTS-NOOP")
else:
    users.objects.create_superuser(username=username, email="", password=password)
    print("CREATED")'
created="$(printf '%s\n%s\n' "$ADMIN_USER" "$PW" | docker exec -i "$CONTAINER" python manage.py shell -c "$CREATE" 2>/dev/null)" || true
result="$(printf '%s\n' "$created" | tail -n 1)"
case "$result" in
  CREATED) ;;
  EXISTS-NOOP) die "Linkding already has an account; left alone." 3 ;;
  *) die "Linkding did not report whether the account was created; the login could not be confirmed." ;;
esac
say "Created Linkding's admin account '$ADMIN_USER'."

# ── prove the new login works ───────────────────────────────────────────────────────
PROVE='import sys
from django.contrib.auth import authenticate
username = sys.stdin.readline().rstrip("\n")
password = sys.stdin.readline().rstrip("\n")
user = authenticate(username=username, password=password)
print("LOGIN-OK" if (user is not None and user.is_superuser) else "LOGIN-FAIL")'
attempt=1
while :; do
  proof="$(printf '%s\n%s\n' "$ADMIN_USER" "$PW" | docker exec -i "$CONTAINER" python manage.py shell -c "$PROVE" 2>/dev/null | tail -n 1)" || true
  if [ "$proof" = "LOGIN-OK" ]; then break; fi
  if [ "$attempt" -ge 3 ]; then break; fi
  attempt=$((attempt + 1))
  sleep 3
done
if [ "$proof" != "LOGIN-OK" ]; then
  # The account already exists with this password, so Crow keeps it and says it could not
  # prove the login (exit 5).
  die "Linkding accepted the new password, but logging in with it did not succeed; reset it on Linkding's own login page." 5
fi

say "Linkding's admin login for '$ADMIN_USER' now uses the password Crow generated."