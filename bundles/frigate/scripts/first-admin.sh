#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# Frigate creates the user `admin` on its first start with a random password it prints
# into the container log, and offers no environment variable for it. This script
# replaces that password with the one Crow generated, so the account is never a window
# someone else on the machine can reach first.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin and
# is passed on only through pipes — never in an argument or the environment, and this
# script prints no secret. Exit 0 = the admin now has that password, 3 = Frigate already
# has an admin of its own (left alone), 4 = not running / not answering, 5 = Frigate took
# the new password but the login could not be proved, anything else = failed.
#
# A password the operator already put into this bundle's .env (FRIGATE_PASSWORD) is tried
# first: when it logs in, this install already has its login and Crow changes nothing.
# Only that login attempt reads the value; it reaches the container on stdin, and nothing
# here prints it.
#
# How: port 5000 INSIDE the container is Frigate's internal, unauthenticated API (the
# compose file does not publish it), which is the only way to set the password without
# knowing the old one. Port 8971 is the authenticated UI, and logging in through it is
# what proves the new password really works.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-frigate}"
ADMIN_USER="${CROW_FIRST_ADMIN_USER:-admin}"

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; Frigate was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; Frigate was not touched."
# The body below is JSON built with printf, and a quote or a backslash would need
# escaping inside it. Crow's generated passwords never contain either.
case "$PW" in
  *'"'* | *'\'*) die "The password on stdin contains a quote or a backslash; Frigate was not touched." ;;
esac
case "$ADMIN_USER" in
  '' | *[!A-Za-z0-9._-]*) die "The admin username is not one Frigate can carry; Frigate was not touched." ;;
esac

# ── a password this extension's settings already carry ─────────────────────────────
# Read only, never printed: the value below only ever reaches the container on a pipe.
env_value() {
  [ -f ./.env ] || return 0
  local line
  line="$(grep -E "^[[:space:]]*$1=" ./.env 2>/dev/null | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  line="${line#*=}"
  case "$line" in
    \"*\") line="${line#\"}"; line="${line%\"}" ;;
    \'*\') line="${line#\'}"; line="${line%\'}" ;;
  esac
  line="${line%$'\r'}"
  printf '%s' "$line"
}
env_password="$(env_value FRIGATE_PASSWORD)"

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Frigate container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Frigate is not running; nothing was changed." 4

# ── does the password in this extension's settings already log in? ──────────────────
# Frigate's admin login is the one Crow creates; an install that was set up before this
# bundle could do it itself may already have that password recorded in .env. Replacing a
# login that works is not Crow's call, so it is tried before anything is changed.
LOGIN_PY='
import json, ssl, sys, time, urllib.error, urllib.request

password = sys.stdin.buffer.readline().decode("utf-8", "replace").rstrip("\n")
payload = json.dumps({"user": sys.argv[1], "password": password}).encode()

def attempt(url, context=None):
    req = urllib.request.Request(url, data=payload, method="POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20, context=context) as resp:
            return resp.status
    except urllib.error.HTTPError as err:
        return err.code
    except Exception:
        return 0

code = attempt("http://127.0.0.1:8971/api/login")
if code != 200:
    time.sleep(2)
    insecure = ssl.create_default_context()
    insecure.check_hostname = False
    insecure.verify_mode = ssl.CERT_NONE
    code = attempt("https://127.0.0.1:8971/api/login", insecure)
print(code)
'

if [ -n "$env_password" ]; then
  code="$(printf '%s\n' "$env_password" | docker exec -i "$CONTAINER" python3 -c "$LOGIN_PY" "$ADMIN_USER" 2>/dev/null || true)"
  if [ "$code" = "200" ]; then
    die "Frigate already has the password from this extension's settings; left alone." 3
  fi
  # Frigate rate-limits login attempts to about one per second.
  sleep 2
fi

# ── has anyone already set the admin password? ──────────────────────────────────────
# Frigate keeps its users in /config/frigate.db; `password_changed_at` is NULL until
# somebody replaces the password printed in the log. The database only appears once a
# first start has got far enough, so a missing one is "still starting", not "no admin".
DETECT_PY='
import os, sqlite3, sys

path = "/config/frigate.db"
if not os.path.exists(path):
    print("nodatabase")
    raise SystemExit(0)
try:
    con = sqlite3.connect("file:" + path + "?mode=ro", uri=True)
    row = con.execute("select password_changed_at from user where username = ?", (sys.argv[1],)).fetchone()
except Exception:
    print("unreadable")
    raise SystemExit(0)
if row is None:
    print("nouser")
else:
    print("null" if row[0] in (None, "") else "changed")
'

state=""
for _ in $(seq 1 30); do
  state="$(docker exec "$CONTAINER" python3 -c "$DETECT_PY" "$ADMIN_USER" < /dev/null 2>/dev/null || true)"
  case "$state" in
    null | changed | nouser) break ;;
  esac
  sleep 3
done
case "$state" in
  null) ;;
  changed) die "Frigate's admin password has already been changed here; left alone." 3 ;;
  nouser) die "Frigate has no admin account to set a password on; left alone." 3 ;;
  *) die "Frigate's database did not become readable in time; nothing was changed." 4 ;;
esac

# ── set the password through the internal API ───────────────────────────────────────
# The JSON body is on stdin, so the password never shows up in any process list.
SET_PY='
import sys, urllib.error, urllib.request

body = sys.stdin.buffer.read()
url = "http://127.0.0.1:5000/api/users/" + sys.argv[1] + "/password"
req = urllib.request.Request(url, data=body, method="PUT", headers={"Content-Type": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=20) as resp:
        sys.stdout.write(resp.read().decode("utf-8", "replace"))
except urllib.error.HTTPError as err:
    sys.stdout.write(err.read().decode("utf-8", "replace"))
    raise SystemExit(1)
except Exception:
    raise SystemExit(1)
'

answer=""
if ! answer="$(printf '{"password":"%s"}' "$PW" | docker exec -i "$CONTAINER" python3 -c "$SET_PY" "$ADMIN_USER" 2>/dev/null)"; then
  die "Frigate refused the new password; the old one is unchanged."
fi
printf '%s' "$answer" | grep -Eq '"success"[[:space:]]*:[[:space:]]*true' ||
  die "Frigate did not confirm the new password; check Frigate itself."

# Frigate rate-limits these calls to about one per second.
sleep 2

# ── prove the new login works through the authenticated port (three tries) ──────────
# LOGIN_PY is defined above (it is the same routine the .env password was tried with):
# TLS on 8971 is off in this bundle's config.yml, so plain HTTP is tried first; a Frigate
# that was configured with tls.enabled: true answers on HTTPS with its own certificate,
# which is retried without verification (loopback only).
attempt=1
while :; do
  code="$(printf '%s\n' "$PW" | docker exec -i "$CONTAINER" python3 -c "$LOGIN_PY" "$ADMIN_USER" 2>/dev/null || true)"
  if [ "$code" = "200" ]; then break; fi
  if [ "$attempt" -ge 3 ]; then break; fi
  attempt=$((attempt + 1))
  sleep 2
done
if [ "$code" != "200" ]; then
  # Frigate confirmed the change ("success": true), so the new password IS the app's
  # password: Crow keeps it and says it could not prove it (exit 5).
  die "Frigate accepted the new password, but logging in with it did not succeed; open Frigate's own UI and set its admin password there." 5
fi

say "Frigate's admin login for '$ADMIN_USER' now uses the password Crow generated."