#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# Change Detection ships with NO password at all: everything a browser reaches on
# 127.0.0.1:5010 is admin, so anything else on the machine can watch what it is signed in to
# as the owner. Its own settings page is where the password goes, so this script sets it
# there with the value Crow generated, before the operator's first visit.
#
# Change Detection has no account names — the manifest's `user` is the protocol's name for
# "who owns this login" and is never sent to the app, which asks for a password only.
#
# Every request is made inside the container by a python snippet (this image has no curl),
# with urllib and a cookie jar, and the password arrives on that snippet's STDIN, so it is
# never an argument, an environment value or output. The snippet prints exactly ONE status
# word per run.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin.
# Exit 0 = the app's password is now exactly that value, 3 = this install already has a
# password of its own and nothing of Crow's was saved, 4 = not running / not answering /
# unreadable, 5 = the app confirmed Crow's own change but logging in with it did not
# succeed, anything else = failed. A save that answers unclearly is settled by reading the
# app's own state again — never by the status code alone.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-changedetection}"
# Inside its own container Change Detection serves the app on port 5000.
BASE_URL="http://127.0.0.1:5000"
# The interpreter this image's own healthcheck uses (`python`, the app's runtime).
PYTHON=python
# The protocol needs a username; the app ignores it. An empty value is refused below rather
# than silently replaced, because an empty one means the declaration is broken — only an
# UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-admin}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; Change Detection was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; Change Detection was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; Change Detection was not touched."

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Change Detection container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Change Detection is not running; nothing was changed." 4

# ── the snippet: fixed text, one status word, no secret baked in ───────────────────
# `detect` reports the app's password state from what `GET /` answers (a redirect to /login
# IS the password), `set` re-posts the WHOLE settings form (every input, hidden csrf_token
# included, checkboxes only when checked, each select's selected option, textareas) with
# Crow's password added — a partial body would wipe the owner's other settings — and `prove`
# logs in through the app's own login form. Every request carries its own 10 s timeout.
CD='import sys
import urllib.parse
import urllib.request
import urllib.error
import http.cookiejar
from html.parser import HTMLParser

BASE = "http://127.0.0.1:5000"
TIMEOUT = 10


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Report a redirect as an answer instead of following it: the Location is the signal."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Fields(HTMLParser):
    """Every field of one form, with the value a browser would send."""

    def __init__(self):
        HTMLParser.__init__(self, convert_charrefs=True)
        self.fields = []
        self.select_name = None
        self.selected = None
        self.first = None
        self.textarea = None
        self.text = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "input":
            name = attrs.get("name")
            if not name:
                return
            kind = (attrs.get("type") or "text").lower()
            if kind in ("checkbox", "radio"):
                if "checked" in attrs:
                    self.fields.append((name, attrs.get("value") or "on"))
            elif kind in ("submit", "button", "image", "file", "reset"):
                return
            else:
                self.fields.append((name, attrs.get("value") or ""))
        elif tag == "select":
            self.select_name = attrs.get("name")
            self.selected = None
            self.first = None
        elif tag == "option" and self.select_name:
            value = attrs.get("value")
            if value is None:
                value = ""
            if self.first is None:
                self.first = value
            if "selected" in attrs:
                self.selected = value
        elif tag == "textarea":
            self.textarea = attrs.get("name")
            self.text = []

    def handle_data(self, data):
        if self.textarea:
            self.text.append(data)

    def handle_endtag(self, tag):
        if tag == "select" and self.select_name:
            value = self.selected
            if value is None:
                value = self.first or ""
            self.fields.append((self.select_name, value))
            self.select_name = None
        elif tag == "textarea" and self.textarea:
            self.fields.append((self.textarea, "".join(self.text)))
            self.textarea = None
            self.text = []


def opener(follow):
    handlers = [urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())]
    if not follow:
        handlers.append(NoRedirect())
    return urllib.request.build_opener(*handlers)


def fetch(op, url, data=None):
    """(status, Location, body). A status of 0 means the app did not answer at all."""
    try:
        resp = op.open(url, data=data, timeout=TIMEOUT)
        try:
            return resp.status, (resp.headers.get("Location") or ""), resp.read().decode("utf-8", "replace")
        finally:
            resp.close()
    except urllib.error.HTTPError as err:
        try:
            where = ""
            if err.headers:
                where = err.headers.get("Location") or ""
            return err.code, where, err.read().decode("utf-8", "replace")
        except Exception:
            return err.code, "", ""
    except Exception:
        return 0, "", ""


def form_fields(page):
    form = Fields()
    form.feed(page)
    return list(form.fields)


def path_of(location):
    if not location:
        return ""
    return (urllib.parse.urlparse(location).path or location).rstrip("/")


def detect():
    status, location, _ = fetch(opener(False), BASE + "/")
    if status == 0:
        return "OFFLINE"
    if status == 200:
        return "FRESH"
    if 300 <= status < 400 and "/login" in location:
        return "DONE"
    return "UNKNOWN"


def set_password(password):
    op = opener(True)
    status, _, page = fetch(op, BASE + "/settings")
    if status != 200:
        return "UNKNOWN"
    fields = form_fields(page)
    if not fields:
        return "UNKNOWN"
    fields.append(("application-password", password))
    fields.append(("save_button", "Save"))
    data = urllib.parse.urlencode(fields).encode()
    status, _, answer = fetch(op, BASE + "/settings", data=data)
    if "Password protection enabled" in answer:
        return "CONFIRMED"
    return "UNKNOWN"


def prove(password):
    op = opener(False)
    status, _, page = fetch(op, BASE + "/login")
    if status != 200:
        return "LOGIN-UNKNOWN"
    token = ""
    for name, value in form_fields(page):
        if name == "csrf_token":
            token = value
    data = urllib.parse.urlencode({"csrf_token": token, "password": password}).encode()
    status, location, _ = fetch(op, BASE + "/login", data=data)
    if 300 <= status < 400:
        where = path_of(location)
        if where == "":
            return "LOGIN-OK"
        if where == "/login":
            return "LOGIN-FAIL"
    if status in (400, 401, 403):
        return "LOGIN-FAIL"
    return "LOGIN-UNKNOWN"


action = sys.argv[1] if len(sys.argv) > 1 else ""
if action == "detect":
    print(detect())
elif action == "set":
    print(set_password(sys.stdin.readline().rstrip("\n")))
elif action == "prove":
    print(prove(sys.stdin.readline().rstrip("\n")))
else:
    print("UNKNOWN")'

# One snippet run. Bounded twice: `timeout` on the host around the whole exec, and the
# snippet's own per-request 10 s timeout. Only the LAST line is kept, because the app can
# write its own log lines around the snippet's answer.
cd_word() { # $1 = action; the password, when the action takes one, arrives on stdin
  local out
  out="$(timeout 20 docker exec -i "$CONTAINER" "$PYTHON" -c "$CD" "$1" 2>/dev/null | tail -n 1 || true)"
  printf '%s' "${out//[[:space:]]/}"
}
detect_word() { cd_word detect </dev/null; }

# ── wait for the app (a first start prepares its own database and settings first) ───
state=""
wait_deadline=$((SECONDS + 40))
while [ "$SECONDS" -lt "$wait_deadline" ]; do
  state="$(detect_word)"
  if [ "$state" != "OFFLINE" ]; then break; fi
  sleep 2
done
case "$state" in
  FRESH) ;;
  DONE) die "Change Detection already has a password of its own, so this install was left alone; nothing was changed." 3 ;;
  OFFLINE | "") die "Change Detection did not answer on its web port; nothing was changed." 4 ;;
  *) die "Change Detection's password state could not be read; nothing was changed." 4 ;;
esac

# ── set the password through the app's own settings form ───────────────────────────
# `confirmed` records the one thing that lets Crow keep the password after a login that does
# not work: the app itself answering the save with "Password protection enabled".
confirmed=""
answer="$(printf '%s\n' "$PW" | cd_word set)"
if [ "$answer" = "CONFIRMED" ]; then
  confirmed=1
else
  # The save answered unclearly. The app's own state decides: a password that is now set may
  # be Crow's, and a real login says whether it really is. Still no password means nothing
  # was written.
  again="$(detect_word)"
  case "$again" in
    DONE) ;;
    FRESH) die "Change Detection did not take the new password, so nothing was changed; check the app's own settings." 1 ;;
    *) die "Change Detection did not report whether it took the new password; check the app's own login before trying again." 1 ;;
  esac
fi
if [ -n "$confirmed" ]; then say "Change Detection's password protection is enabled."; fi

# ── prove the new login works ───────────────────────────────────────────────────────
prove_word() {
  local out
  out="$(printf '%s\n' "$PW" | timeout 20 docker exec -i "$CONTAINER" "$PYTHON" -c "$CD" prove 2>/dev/null | tail -n 1 || true)"
  printf '%s' "${out//[[:space:]]/}"
}
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
  # The app itself confirmed the change, so the new password IS its password: Crow keeps it
  # and says it could not log in with it (exit 5). Without that confirmation a password that
  # appeared is not Crow's — Crow's value does not open it — so nothing is saved (exit 3).
  if [ -n "$confirmed" ]; then
    die "Change Detection accepted the new password, but logging in with it did not succeed; Crow kept the new password; use the login in Settings → Passwords." 5
  fi
  die "Change Detection already has a password that is not Crow's: logging in with Crow's password did not succeed; left alone, and nothing of Crow's was saved." 3
fi

say "Change Detection's password protection now uses the password Crow generated (declared as '$ADMIN_USER')."