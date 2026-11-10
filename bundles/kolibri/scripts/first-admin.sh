#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# Kolibri's first start sends every browser to its own setup wizard: the first learner who
# fills it in owns the facility as its superuser. That wizard answers on 127.0.0.1:8080
# inside the container, so an install left alone is claimable by anything else on the
# machine. This script creates the superuser and the facility itself, with the password Crow
# generated, before the operator's first visit.
#
# How: `kolibri manage shell -c` runs a snippet inside the container as the app's own user,
# so Kolibri's provisioning code (`kolibri.core.device.utils` + the provisiondevice command's `validate_options`) writes the database the way its own
# wizard would. The password, the username and the facility name reach that snippet as its
# first three stdin lines — never an argument, an environment value or output — and it prints
# ONE status word.
#
# The provisioning TASKS API (`/api/tasks/tasks/` with provisiondevice) is deliberately not
# used: it keeps the plaintext password in a task record that anyone who can read the task
# list can read back.
#
# KOLIBRI_FACILITY_NAME is not a Kolibri variable — nothing in the image reads it. It is this
# bundle's own setting, read here from the installed bundle's `./.env` (the installer's
# working directory) and used as the facility name only; with no value, the default is
# "Home Lab".
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin.
# Exit 0 = the superuser now has exactly that password, 3 = this install was already
# provisioned earlier and nothing of Crow's was saved, 4 = not running / not answering /
# unreadable, 5 = Kolibri confirmed Crow's own change but logging in with it did not
# succeed, anything else = failed. A provisioning answer that does not say what it did is
# settled by reading Kolibri's own state again, never by the exit code alone.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-kolibri}"
# Inside its own container Kolibri serves the app on port 8080.
BASE_URL="http://127.0.0.1:8080"
# The interpreter this image ships (its own healthcheck uses the same one).
PYTHON=python3
# Crow creates `admin`; an empty value is refused below rather than silently replaced,
# because an empty one means the declaration is broken — only an UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-admin}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; Kolibri was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; Kolibri was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; Kolibri was not touched."

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Kolibri container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Kolibri is not running; nothing was changed." 4

# ── the facility name: this bundle's own setting, from the installed .env ──────────
FACILITY=""
if [ -f ./.env ]; then
  FACILITY="$(sed -n 's/^KOLIBRI_FACILITY_NAME=//p' ./.env | tail -n 1)"
  FACILITY="${FACILITY%\"}"; FACILITY="${FACILITY#\"}"
  FACILITY="${FACILITY%\'}"; FACILITY="${FACILITY#\'}"
fi
# One line only: it is handed to the snippet as a single stdin line.
FACILITY="$(printf '%s' "$FACILITY" | tr -d '\r\n')"
[ -n "$FACILITY" ] || FACILITY="Home Lab"

# ── the snippets: fixed text, one status word each, no secret baked in ────────────
# `detect` reads the redirect Kolibri's own root answers with (/setup while the device is
# unprovisioned, /auth once it is) and never follows it; `prove` signs in through Kolibri's
# own session API and requires the superuser kind — a plain learner account is not an admin.
HTTP='import json
import sys
import urllib.error
import urllib.parse
import urllib.request
import http.cookiejar

BASE = "http://127.0.0.1:8080"
TIMEOUT = 10


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Report a redirect as an answer instead of following it: the Location is the signal."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def opener(follow):
    handlers = [urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())]
    if not follow:
        handlers.append(NoRedirect())
    return urllib.request.build_opener(*handlers)


def detect():
    op = opener(False)
    try:
        resp = op.open(BASE + "/", timeout=TIMEOUT)
        resp.close()
        return "UNKNOWN"
    except urllib.error.HTTPError as err:
        where = ""
        if err.headers:
            where = err.headers.get("Location") or ""
        if "/setup" in where:
            return "FRESH"
        if "/auth" in where:
            return "DONE"
        return "UNKNOWN"
    except Exception:
        return "OFFLINE"


def prove(name, password):
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    token = ""
    try:
        # Kolibri 0.19.5 accepts an anonymous session POST without a CSRF cookie (its
        # session/current endpoint answers GET with 405), so the login is asked directly.
        data = json.dumps({"username": name, "password": password}).encode()
        req = urllib.request.Request(
            BASE + "/api/auth/session/",
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Referer": BASE + "/",
            },
        )
        resp = op.open(req, timeout=TIMEOUT)
        try:
            status = resp.status
            body = resp.read().decode("utf-8", "replace")
        finally:
            resp.close()
    except urllib.error.HTTPError as err:
        return "LOGIN-FAIL" if err.code in (400, 401, 403) else "LOGIN-UNKNOWN"
    except Exception:
        return "LOGIN-UNKNOWN"
    kind = ""
    try:
        kind = str(json.loads(body).get("kind") or "")
    except Exception:
        kind = ""
    if status == 200 and "superuser" in kind:
        return "LOGIN-OK"
    return "LOGIN-FAIL"


action = sys.argv[1] if len(sys.argv) > 1 else ""
if action == "detect":
    print(detect())
elif action == "prove":
    print(prove(sys.stdin.readline().rstrip("\n"), sys.stdin.readline().rstrip("\n")))
else:
    print("UNKNOWN")'

# `provision` creates the facility and its superuser through Kolibri's own provisioning code.
# The three values arrive on stdin, so nothing is interpolated into the code. Only the status
# word is read back, because Kolibri logs around it.
PROVISION='import sys

password = sys.stdin.readline().rstrip("\n")
username = sys.stdin.readline().rstrip("\n")
facility = sys.stdin.readline().rstrip("\n")

try:
    from kolibri.core.device.utils import device_provisioned, setup_device_and_facility
    from kolibri.core.device.management.commands.provisiondevice import validate_options
except Exception:
    print("UNKNOWN")
    sys.exit(0)

# An already provisioned device is never provisioned again (that would add a second
# facility and superuser): nothing changes.
if device_provisioned():
    print("DONE")
    sys.exit(0)

try:
    args = validate_options({
        "interactive": False,
        "facility": facility,
        "preset": "informal",
        "language_id": "en",
        "superusername": username,
        "superuserpassword": password,
        "facility_settings": {},
        "device_settings": {},
    })
    setup_device_and_facility(*args)
    print("CREATED")
except Exception:
    print("UNKNOWN")'

# One snippet run, its answer cut down to the ONE status word the snippet printed. Bounded
# twice: `timeout` on the host around the whole exec, and the snippet's own request timeouts.
word_of() { printf '%s\n' "$1" | grep -Ex 'CREATED|DONE|UNKNOWN|FRESH|OFFLINE|LOGIN-OK|LOGIN-FAIL|LOGIN-UNKNOWN' | tail -n 1 || true; }

detect_word() {
  local out
  out="$(timeout 20 docker exec -i -u kolibri "$CONTAINER" "$PYTHON" -c "$HTTP" detect </dev/null 2>/dev/null || true)"
  word_of "$out"
}
prove_word() {
  local out
  out="$(printf '%s\n%s\n' "$ADMIN_USER" "$PW" | timeout 20 docker exec -i -u kolibri "$CONTAINER" "$PYTHON" -c "$HTTP" prove 2>/dev/null || true)"
  word_of "$out"
}

# ── wait for the app (a first start creates its database and content dirs first) ───
state=""
wait_deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$wait_deadline" ]; do
  state="$(detect_word)"
  if [ "$state" != "OFFLINE" ]; then break; fi
  sleep 2
done
case "$state" in
  FRESH) ;;
  DONE) die "Kolibri already has its own superuser, so this install was left alone; nothing was changed." 3 ;;
  OFFLINE | "") die "Kolibri did not answer on its web port; nothing was changed." 4 ;;
  *) die "Kolibri's setup state could not be read; nothing was changed." 4 ;;
esac

# ── create the facility and its superuser ─────────────────────────────────────────
# `confirmed` records the one thing that lets Crow keep the password after a login that does
# not work: Kolibri's own provisioning answering that it created the device.
confirmed=""
created="$(printf '%s\n%s\n%s\n' "$PW" "$ADMIN_USER" "$FACILITY" | timeout 40 docker exec -i -u kolibri "$CONTAINER" kolibri manage shell -c "$PROVISION" 2>/dev/null || true)"
result="$(word_of "$created")"
case "$result" in
  CREATED) confirmed=1; say "Kolibri's facility '$FACILITY' and its superuser '$ADMIN_USER' are in place." ;;
  DONE)
    # Already provisioned (a previous run, or the wizard got there first): nothing of ours to
    # claim, and the login below says whose password it holds.
    ;;
  *)
    # Unclearly reported: the device may already be provisioned. Kolibri's own state decides.
    again="$(detect_word)"
    case "$again" in
      DONE) ;;
      FRESH) die "Kolibri did not create the superuser, so nothing was changed; check the app's own setup." 1 ;;
      *) die "Kolibri did not report whether it created the superuser; check the app's own login before trying again." 1 ;;
    esac
    ;;
esac

# ── prove the new login works ───────────────────────────────────────────────────────
attempt=1
proof=""
proof_deadline=$((SECONDS + 20))
while :; do
  proof="$(prove_word)"
  if [ "$proof" = "LOGIN-OK" ]; then break; fi
  if [ "$attempt" -ge 3 ]; then break; fi
  if [ "$SECONDS" -ge "$proof_deadline" ]; then break; fi
  attempt=$((attempt + 1))
  sleep 3
done
if [ "$proof" != "LOGIN-OK" ]; then
  # Kolibri itself confirmed the change, so the new password IS the superuser's password:
  # Crow keeps it and says it could not log in with it (exit 5). Without that confirmation a
  # provisioned device is not Crow's — Crow's value does not open it — so nothing is saved
  # (exit 3).
  if [ -n "$confirmed" ]; then
    die "Kolibri accepted the new password, but logging in with it did not succeed; Crow kept the new password; use the login in Settings → Passwords." 5
  fi
  die "Kolibri already has a superuser that is not Crow's: logging in with Crow's password did not succeed; left alone, and nothing of Crow's was saved." 3
fi

say "Kolibri's superuser login for '$ADMIN_USER' now uses the password Crow generated."