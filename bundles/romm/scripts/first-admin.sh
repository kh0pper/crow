#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# RomM shows its setup wizard until an admin account exists, and that wizard answers on
# 127.0.0.1 — an install left alone is claimable by anything else on the machine. RomM has
# no environment variable for its admin, so this script makes the account through RomM's own
# HTTP API, with the password Crow generated.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin and is
# passed on only through a pipe — never in an argument or the environment, and this script
# prints no secret. Exit 0 = the admin now has that password, 3 = RomM already has an admin
# of its own (left alone), 4 = not running / not answering, 5 = RomM took the new password
# but the login could not be proved, anything else = failed. A create step that answers
# unclearly is re-checked against RomM's own state: if the account appeared, the password is
# kept and proved (exit 0 or 5); if it did not, nothing was changed (exit 1).
#
# How: RomM's venv interpreter is /src/.venv/bin/python3 in the container, and every request
# is made by a python snippet over http://localhost:8080 with urllib and a cookie jar (the
# `romm_csrftoken` cookie is echoed back in the x-csrftoken header). The username and the
# password reach a snippet as the first and second stdin line, so no value is ever
# interpolated into code.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

# The app service has no fixed container_name (an install made before this script keeps
# its own compose file), so the container is found by the two labels compose itself writes:
# the service name, and the real path of the folder compose ran in — this script's own cwd,
# the installed bundle dir. Compose files are not read at all.
CONTAINER="${CROW_FA_CONTAINER:-}"
# RomM's setup wizard asks for the admin's username; Crow creates `admin`. An empty value
# is refused below rather than silently replaced: only an UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-admin}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; RomM was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; RomM was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; RomM was not touched."

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the RomM container cannot be reached; nothing was changed." 4
if [ -z "$CONTAINER" ]; then
  romm_ids() { docker ps -q --filter label=com.docker.compose.service=romm --filter "label=com.docker.compose.project.working_dir=$1" 2>/dev/null || true; }
  ids="$(romm_ids "$(pwd -P)")"
  # Compose records the folder it ran in; if that path went through a symlink, try it as given.
  if [ -z "$(printf '%s' "$ids" | tr -d '[:space:]')" ] && [ "$PWD" != "$(pwd -P)" ]; then ids="$(romm_ids "$PWD")"; fi
  ids="$(printf '%s\n' "$ids" | sed '/^[[:space:]]*$/d')"
  total=0
  if [ -n "$ids" ]; then total="$(printf '%s\n' "$ids" | wc -l | tr -d ' ')"; fi
  [ "$total" -gt 0 ] || die "RomM is not running; nothing was changed." 4
  [ "$total" -le 1 ] || die "More than one RomM container matches this install's folder; nothing was changed."
  CONTAINER="$ids"
fi
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "RomM is not running; nothing was changed." 4

PY=/src/.venv/bin/python3

# ── wait for the app (a first start migrates its database first) ────────────────────
WAIT='import urllib.request
urllib.request.urlopen("http://localhost:8080/api/heartbeat", timeout=10)'
up=""
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" "$PY" -c "$WAIT" </dev/null >/dev/null 2>&1; then
    up=1
    break
  fi
  sleep 2
done
[ -n "$up" ] || die "RomM did not answer its heartbeat; nothing was changed." 4

# ── is there already an admin? ──────────────────────────────────────────────────────
# RomM's heartbeat carries its own answer: SHOW_SETUP_WIZARD is true only while no admin
# account exists and false once one does. A missing or non-boolean value means the field is
# not what this script expects, which is not the same as an existing admin.
DETECT='import json, urllib.request
data = json.load(urllib.request.urlopen("http://localhost:8080/api/heartbeat", timeout=10))
v = data.get("SYSTEM", {}).get("SHOW_SETUP_WIZARD")
if v is True:
    print("FRESH")
elif v is False:
    print("EXISTS")
else:
    print("UNKNOWN")'
state="$(docker exec "$CONTAINER" "$PY" -c "$DETECT" </dev/null 2>/dev/null || true)"
result="$(printf '%s\n' "$state" | tail -n 1)"
case "$result" in
  FRESH) ;;
  EXISTS) die "RomM already has an admin; left alone." 3 ;;
  *) die "RomM's heartbeat could not be read; nothing was changed." 4 ;;
esac

# ── create it (username on the first stdin line, password on the second) ────────────
# CREATED and REFUSED are certain answers. 403 means an admin appeared between the check
# above and this POST (an install is claimable in that window) → TAKEN. A 5xx, a reset or a
# timeout can arrive after RomM wrote the row, so those print UNKNOWN and the account is
# looked for again below instead of the password being thrown away.
CREATE='import http.cookiejar, json, sys, urllib.error, urllib.request
username = sys.stdin.readline().rstrip("\n")
password = sys.stdin.readline().rstrip("\n")
base = "http://localhost:8080"
try:
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.open(base + "/api/heartbeat", timeout=15).read()
    token = ""
    for cookie in jar:
        if cookie.name == "romm_csrftoken":
            token = cookie.value
    body = json.dumps({"username": username, "email": "admin@romm.invalid", "password": password, "role": "admin"}).encode("utf-8")
    request = urllib.request.Request(base + "/api/users", data=body, method="POST", headers={"Content-Type": "application/json", "x-csrftoken": token})
    try:
        code = opener.open(request, timeout=30).status
    except urllib.error.HTTPError as err:
        code = err.code
    if code == 201:
        print("CREATED")
    elif code == 403:
        print("TAKEN")
    elif 400 <= code < 500:
        print("REFUSED")
    else:
        print("UNKNOWN")
except Exception:
    print("UNKNOWN")'
created="$(printf '%s\n%s\n' "$ADMIN_USER" "$PW" | docker exec -i "$CONTAINER" "$PY" -c "$CREATE" 2>/dev/null)" || true
result="$(printf '%s\n' "$created" | tail -n 1)"
case "$result" in
  CREATED) ;;
  TAKEN)
    # A 403 is also RomM's answer to a CSRF check it rejected, so it is not proof that an
    # admin exists: ask the heartbeat. Only a definite "admin exists" is exit 3.
    again="$(docker exec "$CONTAINER" "$PY" -c "$DETECT" </dev/null 2>/dev/null || true)"
    case "$(printf '%s\n' "$again" | tail -n 1)" in
      EXISTS) die "RomM already has an admin; left alone." 3 ;;
      FRESH) die "RomM refused the request to create the admin account; nothing was changed." ;;
      *) die "RomM refused the request, and its heartbeat could not be read afterwards; nothing was changed." ;;
    esac
    ;;
  REFUSED) die "RomM refused the new admin account; nothing was changed." ;;
  *)
    # Unclearly reported create: the row may already be there. Ask RomM itself rather than
    # guess — an account that exists means this password is the only one anybody has.
    again="$(docker exec "$CONTAINER" "$PY" -c "$DETECT" </dev/null 2>/dev/null || true)"
    recheck="$(printf '%s\n' "$again" | tail -n 1)"
    case "$recheck" in
      FRESH) die "RomM did not create the admin account; nothing was changed." ;;
      EXISTS) ;;
      *) die "RomM did not report whether it created the admin account, and its heartbeat could not be read afterwards; look at RomM's own user list before trying again." ;;
    esac
    ;;
esac
say "RomM's admin account '$ADMIN_USER' is in place."

# ── prove the new login works ───────────────────────────────────────────────────────
# A working login alone is not enough: the account has to be an admin, because that is
# what Crow tells the operator it created.
PROVE='import base64, http.cookiejar, json, sys, urllib.error, urllib.request
username = sys.stdin.readline().rstrip("\n")
password = sys.stdin.readline().rstrip("\n")
base = "http://localhost:8080"
try:
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.open(base + "/api/heartbeat", timeout=15).read()
    token = ""
    for cookie in jar:
        if cookie.name == "romm_csrftoken":
            token = cookie.value
    credentials = base64.b64encode((username + ":" + password).encode("utf-8")).decode("ascii")
    request = urllib.request.Request(base + "/api/login", data=b"", method="POST", headers={"x-csrftoken": token, "Authorization": "Basic " + credentials})
    try:
        code = opener.open(request, timeout=30).status
    except urllib.error.HTTPError as err:
        code = err.code
    me = {}
    if code == 200:
        me = json.load(opener.open(urllib.request.Request(base + "/api/users/me"), timeout=30))
    print("LOGIN-OK" if (code == 200 and me.get("role") == "admin") else "LOGIN-FAIL")
except Exception:
    print("LOGIN-FAIL")'
attempt=1
while :; do
  proof="$(printf '%s\n%s\n' "$ADMIN_USER" "$PW" | docker exec -i "$CONTAINER" "$PY" -c "$PROVE" 2>/dev/null | tail -n 1)" || true
  if [ "$proof" = "LOGIN-OK" ]; then break; fi
  if [ "$attempt" -ge 3 ]; then break; fi
  attempt=$((attempt + 1))
  sleep 3
done
if [ "$proof" != "LOGIN-OK" ]; then
  # The account already exists with this password, so Crow keeps it and says it could not
  # prove the login (exit 5).
  die "RomM accepted the new password, but logging in with it did not succeed; reset it in RomM's own user settings." 5
fi

say "RomM's admin login for '$ADMIN_USER' now uses the password Crow generated."