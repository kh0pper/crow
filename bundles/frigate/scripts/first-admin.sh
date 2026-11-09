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
# has an admin of its own (left alone), 4 = not running / not answering, anything else =
# failed.
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

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Frigate container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Frigate is not running; nothing was changed." 4

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

# ── prove the new login works through the authenticated port ────────────────────────
# TLS on 8971 is off in this bundle's config.yml, so plain HTTP is tried first; a
# Frigate that was configured with tls.enabled: true answers on HTTPS with its own
# certificate, which is retried without verification (loopback only).
LOGIN_PY='
import ssl, sys, time, urllib.error, urllib.request

payload = sys.stdin.buffer.read()

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

code="$(printf '{"user":"%s","password":"%s"}' "$ADMIN_USER" "$PW" | docker exec -i "$CONTAINER" python3 -c "$LOGIN_PY" 2>/dev/null || true)"
[ "$code" = "200" ] || die "Frigate did not accept the new login; open Frigate's own UI and set its admin password there."

say "Frigate's admin login for '$ADMIN_USER' now uses the password Crow generated."