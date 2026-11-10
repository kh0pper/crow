#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# TriliumNext has no admin username: the FIRST password set on its own pages owns the whole
# database, and those pages answer on 127.0.0.1:8080 inside the container. An install left
# alone is therefore claimable by anything else on the machine, and a database that was
# initialised but has no password yet is claimable too. This script sets that password
# itself, with the value Crow generated, before the operator's first visit.
#
# The manifest still declares `user` — the protocol needs an account name to report — but
# TriliumNext's HTTP API takes a password only, so the username is never sent anywhere; it
# appears in this script's messages and nowhere else.
#
# Every request is made INSIDE the container with the curl its image ships, and the request
# config travels on stdin (`curl -K -`): the password is never an argument, an environment
# value or output. Following a redirect belongs to a READ only. The one place a redirect is
# the ANSWER is `GET /login`, which this script reads as headers and never follows: its
# Location says whether a password already exists.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin.
# Exit 0 = the admin password is now exactly that value, 3 = this install already has its
# own password and nothing of Crow's was saved, 4 = not running / not answering /
# unreadable, 5 = TriliumNext confirmed Crow's own change but logging in with it did not
# succeed, anything else = failed. A database step that answers unclearly is settled by
# reading TriliumNext's own state again, never by the status code alone.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-trilium}"
# Inside its own container TriliumNext serves the app and the ETAPI on port 8080.
BASE_URL="http://127.0.0.1:8080"
# Crow's declaration names `trilium`; an empty value is refused below rather than silently
# replaced, because an empty one means the declaration is broken — only an UNSET one takes
# the default. TriliumNext itself has no account names, so this is never sent to the app.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-trilium}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; TriliumNext was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; TriliumNext was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; TriliumNext was not touched."

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the TriliumNext container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "TriliumNext is not running; nothing was changed." 4

# Escaping for a curl config value (curl reads its config from stdin with `-K -`): a
# double-quoted value there understands exactly two escapes, `\\` and `\"`. It is used for
# the JSON body (where it is also the JSON string escape) and for the config line itself.
esc() { local s="${1//\\/\\\\}"; printf '%s' "${s//\"/\\\"}"; }

# ── one HTTP call inside the container, its config on stdin ────────────────────────
# The answer is the body, then one line with the status code, then one line with the
# redirect target a request that did NOT follow would use (`-w`). Nothing at all means the
# request did not happen. Bounded twice: `timeout` on the host around the whole exec, and
# `max-time` in the request's own config.
http_get() { printf '%s' "$1" | timeout 15 docker exec -i "$CONTAINER" curl -sS -L -K - -w '\n%{http_code}\n%{redirect_url}\n' 2>/dev/null || true; }
http_post() { printf '%s' "$1" | timeout 15 docker exec -i "$CONTAINER" curl -sS -K - -w '\n%{http_code}\n%{redirect_url}\n' 2>/dev/null || true; }
# The response HEADERS of a request that must not be followed: for `GET /login` the Location
# IS the answer, so replaying it would destroy the signal.
http_headers() { printf '%s' "$1" | timeout 15 docker exec -i "$CONTAINER" curl -sS -o /dev/null -D - -K - 2>/dev/null || true; }

# The three fields of a recorded answer. curl's write-out ends with the redirect target, which
# is an empty line when the request did not redirect — and the shell drops that trailing
# newline — so the LAST line is the redirect only when it is not a status code.
last_line() { printf '%s' "$1" | tail -n 1 | tr -d '[:space:]'; }
answer_status() {
  local last
  last="$(last_line "$1")"
  case "$last" in
    [0-9][0-9][0-9]) printf '%s' "$last"; return 0 ;;
  esac
  printf '%s' "$(printf '%s' "$1" | tail -n 2 | head -n 1 | tr -d '[:space:]')"
}
answer_redirect() {
  local last
  last="$(last_line "$1")"
  case "$last" in
    [0-9][0-9][0-9]) printf '' ;;
    *) printf '%s' "$last" ;;
  esac
}
answer_body() {
  local last
  last="$(last_line "$1")"
  case "$last" in
    [0-9][0-9][0-9]) printf '%s' "$1" | sed '$d' ;;
    *) printf '%s' "$1" | sed '$d' | sed '$d' ;;
  esac
}

cfg_get() { printf 'url = "%s"\nmax-time = 10\n' "$1"; }
cfg_post() {
  printf 'url = "%s"\nmax-time = 10\nrequest = "POST"\nheader = "Content-Type: application/json"\ndata = "%s"\n' \
    "$1" "$(esc "$2")"
}

# One boolean field of a JSON document, whitespace stripped first so formatting cannot hide
# it: `true` / `false` / nothing readable.
json_flag() {
  printf '%s' "$1" | tr -d '[:space:]' | grep -o "\"$2\":\(true\|false\)" | tail -n 1 | sed 's/^.*://' || true
}

# FRESH (the database still has to be created) / INITIALIZED (a database exists) /
# OFFLINE / UNKNOWN. Only a JSON `isInitialized` of true or false is a reading; anything
# else changes nothing.
setup_state() {
  local resp code body flag
  resp="$(http_get "$(cfg_get "$BASE_URL/api/setup/status")")"
  code="$(answer_status "$resp")"
  body="$(answer_body "$resp")"
  if [ -z "$code" ] || [ "$code" = "000" ]; then printf '%s' "OFFLINE"; return 0; fi
  [ "$code" = "200" ] || { printf '%s' "UNKNOWN"; return 0; }
  flag="$(json_flag "$body" isInitialized)"
  case "$flag" in
    false) printf '%s' "FRESH" ;;
    true) printf '%s' "INITIALIZED" ;;
    *) printf '%s' "UNKNOWN" ;;
  esac
}

# SET (a password already guards the database) / NONE (a database with no password yet —
# still claimable) / OFFLINE / UNKNOWN. TriliumNext answers `GET /login` with a relative
# redirect: to `.` when it still has no password, and to `…?login` once it has one.
password_state() {
  local headers loc
  headers="$(http_headers "$(cfg_get "$BASE_URL/login")")"
  [ -n "$headers" ] || { printf '%s' "OFFLINE"; return 0; }
  loc="$(printf '%s\n' "$headers" | tr -d '\r' | sed -n 's/^[Ll]ocation:[[:space:]]*//p' | tail -n 1)"
  case "$loc" in
    "") printf '%s' "UNKNOWN" ;;
    *'?login') printf '%s' "SET" ;;
    ".") printf '%s' "NONE" ;;
    *) printf '%s' "UNKNOWN" ;;
  esac
}

# ── wait for the app (a first start prepares its own database first) ───────────────
state=""
wait_deadline=$((SECONDS + 40))
while [ "$SECONDS" -lt "$wait_deadline" ]; do
  state="$(setup_state)"
  if [ "$state" != "OFFLINE" ]; then break; fi
  sleep 2
done
case "$state" in
  FRESH) need_db=1 ;;
  INITIALIZED) need_db="" ;;
  OFFLINE | "") die "TriliumNext did not answer on its web port; nothing was changed." 4 ;;
  *) die "TriliumNext's setup state could not be read; nothing was changed." 4 ;;
esac

if [ -z "$need_db" ]; then
  # A database that already has a password is someone's install: leave it alone. One
  # WITHOUT a password is still claimable, so it only needs the password step.
  pw_state="$(password_state)"
  case "$pw_state" in
    NONE) ;;
    SET) die "TriliumNext already has its own admin password, so this install was left alone; nothing was changed." 3 ;;
    OFFLINE | "") die "TriliumNext did not answer on its login page; nothing was changed." 4 ;;
    *) die "TriliumNext's password state could not be read; nothing was changed." 4 ;;
  esac
fi

# ── create the database, when there is none ───────────────────────────────────────
if [ -n "$need_db" ]; then
  resp="$(http_post "$(cfg_post "$BASE_URL/api/setup/new-document?skipDemoDb" '{}')")"
  code="$(answer_status "$resp")"
  if [ "$code" != "204" ]; then
    # Not an error on its own: the database may have been created by a request that was cut
    # off. TriliumNext's own state decides.
    again="$(setup_state)"
    case "$again" in
      INITIALIZED) ;;
      FRESH) die "TriliumNext did not create its database, so nothing was changed." 1 ;;
      *) die "TriliumNext did not report whether it created its database; check the app before trying again." 1 ;;
    esac
  else
    say "TriliumNext's database is in place."
  fi
fi

# ── set the password (both fields on the request's own stdin) ──────────────────────
# `data-urlencode` percent-encodes the value, so the password never has to be shell-safe;
# it still travels inside the config on stdin, never as an argument.
cfg_setpw() {
  printf 'url = "%s"\nmax-time = 10\nrequest = "POST"\ndata-urlencode = "password1=%s"\ndata-urlencode = "password2=%s"\n' \
    "$BASE_URL/set-password" "$(esc "$PW")" "$(esc "$PW")"
}
confirmed=""
resp="$(http_post "$(cfg_setpw)")"
code="$(answer_status "$resp")"
target="$(answer_redirect "$resp")"
if [ "$code" = "302" ] && printf '%s' "$target" | grep -q 'login'; then confirmed=1; fi
if [ -z "$confirmed" ]; then
  # TriliumNext did not say what it did. Its own login page decides: a password that is now
  # set may be Crow's, and a real login says whether it really is. A page that still offers
  # to set one means nothing was written.
  pw_state="$(password_state)"
  case "$pw_state" in
    SET) ;;
    NONE) die "TriliumNext did not set the password, so nothing was changed." 1 ;;
    *) die "TriliumNext did not report whether it set the password; check the app's own login before trying again." 1 ;;
  esac
else
  say "TriliumNext's admin password is in place."
fi

# ── prove the new login works ───────────────────────────────────────────────────────
# The ETAPI answers 201 with a token for the right password, and 401 for a wrong one.
login_body="{\"password\":\"$(esc "$PW")\"}"
prove() {
  local answer
  answer="$(http_post "$(cfg_post "$BASE_URL/etapi/auth/login" "$login_body")")"
  if [ "$(answer_status "$answer")" = "201" ]; then printf '%s' "LOGIN-OK"; else printf '%s' "LOGIN-FAIL"; fi
}
attempt=1
proof=""
proof_deadline=$((SECONDS + 20))
while :; do
  proof="$(prove)"
  if [ "$proof" = "LOGIN-OK" ]; then break; fi
  if [ "$attempt" -ge 3 ]; then break; fi
  if [ "$SECONDS" -ge "$proof_deadline" ]; then break; fi
  attempt=$((attempt + 1))
  sleep 3
done
if [ "$proof" != "LOGIN-OK" ]; then
  # TriliumNext itself confirmed the change (302 to its login page), so the new password IS
  # the database's password: Crow keeps it and says it could not log in with it (exit 5).
  # Without that confirmation a password that appeared is not Crow's — Crow's value does not
  # open it — so nothing is saved (exit 3).
  if [ -n "$confirmed" ]; then
    die "TriliumNext accepted the new password, but logging in with it did not succeed; Crow kept the new password; use the login in Settings → Passwords." 5
  fi
  die "TriliumNext already has an admin password that is not Crow's: logging in with Crow's password did not succeed; left alone, and nothing of Crow's was saved." 3
fi

say "TriliumNext's admin login (declared as '$ADMIN_USER') now uses the password Crow generated."