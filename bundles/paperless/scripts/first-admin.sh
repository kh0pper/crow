#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# Paperless-ngx has no environment variable for its first admin: the account is made with
# its own `createsuperuser` console command, or on a page that anyone reaching it can use.
# Paperless also keeps a guardian `AnonymousUser` row in its users table, so "no admin yet"
# is "no row other than that one". This script creates the superuser itself, with the
# password Crow generated.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin and is
# passed on only through a pipe — never in an argument or the environment, and this script
# prints no secret. Exit 0 = the admin now has that password, 3 = Paperless already has a
# superuser of its own (left alone), 4 = not running / not answering, 5 = Paperless took the
# new password but the login could not be proved, anything else = failed.
#
# How: the app runs as the `paperless` user under s6 and its Django project lives in
# /usr/src/paperless/src, so everything goes through `docker exec` + `s6-setuidgid` and
# Django's own shell. The username and the password reach a snippet as the first and second
# stdin line, so no value is ever interpolated into code. The snippet is passed inside a
# single-quoted argument to the container's own shell, so it uses double quotes only.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-paperless}"
# Paperless-ngx's admin account, as the container's console creates it. An empty value is
# refused below rather than silently replaced: only an UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-admin}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; Paperless-ngx was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; Paperless-ngx was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; Paperless-ngx was not touched."

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Paperless-ngx container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Paperless-ngx is not running; nothing was changed." 4

# ── wait for the app (a first start migrates the database, then serves) ─────────────
up=""
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" curl -fsS -o /dev/null http://localhost:8000 </dev/null >/dev/null 2>&1; then
    up=1
    break
  fi
  sleep 2
done
[ -n "$up" ] || die "Paperless-ngx did not answer on its web port; nothing was changed." 4

# ── is there already a superuser? ───────────────────────────────────────────────────
# The guardian `AnonymousUser` is in the table from the first migration on, so it is
# excluded: any other row is an account somebody made.
MANAGE='cd /usr/src/paperless/src && s6-setuidgid paperless python3 manage.py'
DETECT='from django.contrib.auth import get_user_model
print("USERS=%d" % get_user_model().objects.exclude(username="AnonymousUser").count())'
state="$(docker exec "$CONTAINER" sh -c "$MANAGE shell -c '$DETECT'" </dev/null 2>/dev/null || true)"
users="$(printf '%s\n' "$state" | sed -n 's/^USERS=\([0-9][0-9]*\)$/\1/p' | tail -n 1)"
[ -n "$users" ] || die "Paperless-ngx's user table could not be read; nothing was changed." 4
[ "$users" = "0" ] || die "Paperless-ngx already has an account; left alone." 3

# ── create it (username on the first stdin line, password on the second) ────────────
CREATE='import sys
from django.contrib.auth import get_user_model
username = sys.stdin.readline().rstrip("\n")
password = sys.stdin.readline().rstrip("\n")
users = get_user_model()
if users.objects.exclude(username="AnonymousUser").exists():
    print("EXISTS-NOOP")
else:
    users.objects.create_superuser(username=username, email="admin@localhost", password=password)
    print("CREATED")'
created="$(printf '%s\n%s\n' "$ADMIN_USER" "$PW" | docker exec -i "$CONTAINER" sh -c "$MANAGE shell -c '$CREATE'" 2>/dev/null)" || true
result="$(printf '%s\n' "$created" | tail -n 1)"
case "$result" in
  CREATED) ;;
  EXISTS-NOOP) die "Paperless-ngx already has an account; left alone." 3 ;;
  *) die "Paperless-ngx did not report whether the account was created; the login could not be confirmed." ;;
esac
say "Created Paperless-ngx's admin account '$ADMIN_USER'."

# ── prove the new login works ───────────────────────────────────────────────────────
# No authenticate() here: it raises without a request in this project. The stored password
# hash is checked instead, which is the same test the login form makes.
PROVE='import sys
from django.contrib.auth import get_user_model
username = sys.stdin.readline().rstrip("\n")
password = sys.stdin.readline().rstrip("\n")
user = get_user_model().objects.filter(username=username).first()
print("LOGIN-OK" if (user is not None and user.is_superuser and user.check_password(password)) else "LOGIN-FAIL")'
attempt=1
while :; do
  proof="$(printf '%s\n%s\n' "$ADMIN_USER" "$PW" | docker exec -i "$CONTAINER" sh -c "$MANAGE shell -c '$PROVE'" 2>/dev/null | tail -n 1)" || true
  if [ "$proof" = "LOGIN-OK" ]; then break; fi
  if [ "$attempt" -ge 3 ]; then break; fi
  attempt=$((attempt + 1))
  sleep 3
done
if [ "$proof" != "LOGIN-OK" ]; then
  # The account already exists with this password, so Crow keeps it and says it could not
  # prove the login (exit 5).
  die "Paperless-ngx accepted the new password, but logging in with it did not succeed; reset it in Paperless-ngx's own user settings." 5
fi

say "Paperless-ngx's admin login for '$ADMIN_USER' now uses the password Crow generated."