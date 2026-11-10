#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# Navidrome's first start shows a "create the first admin" page, and the first caller that
# fills it in owns the server. That page answers on 127.0.0.1:4533 inside the container, so
# an install left alone is claimable by anything else on the machine. This script creates
# that account itself, with the password Crow generated, before the operator's first visit.
#
# Every request is made INSIDE the container, with the curl its image ships, and the request
# config travels on stdin (`curl -K -`): the admin username and the password are never an
# argument, an environment value or output.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin.
# Exit 0 = the admin now has exactly that password, 3 = Navidrome already has its first
# admin (nothing changed), 4 = not running / not answering / unreadable, 5 = Navidrome took
# the new password but logging in with it did not succeed, anything else = failed. A create
# answer that does not say the account was made is settled by reading Navidrome's own state
# again: an install that now has its first admin keeps the password and proves it (0 or 5),
# one that still has none changed nothing (1).
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-navidrome}"
BASE_URL="http://127.0.0.1:4533"
# Crow creates `admin`; an empty value is refused below rather than silently replaced,
# because an empty one means the declaration is broken — only an UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-admin}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; Navidrome was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; Navidrome was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; Navidrome was not touched."

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Navidrome container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Navidrome is not running; nothing was changed." 4

# Escaping for a curl config value (curl reads its config from stdin with `-K -`): a
# double-quoted value there understands exactly two escapes, `\\` and `\"`. It is used for
# the JSON body (where it is also the JSON string escape) and for the config line itself.
esc() { local s="${1//\\/\\\\}"; printf '%s' "${s//\"/\\\"}"; }

# ── one HTTP call inside the container, its config on stdin ────────────────────────
# Prints the body and then one final line with the HTTP status code (that is what
# `-w '\n%{http_code}'` appends). Nothing at all means the request did not happen.
http() { printf '%s' "$1" | docker exec -i "$CONTAINER" curl -sS -L -K - -w '\n%{http_code}' 2>/dev/null || true; }
code_of() { printf '%s' "${1##*$'\n'}"; }
body_of() { printf '%s' "${1%$'\n'*}"; }

cfg_get() { printf 'url = "%s"\nmax-time = 10\n' "$1"; }
cfg_post() {
  printf 'url = "%s"\nmax-time = 10\nrequest = "POST"\nheader = "Content-Type: application/json"\ndata = "%s"\n' \
    "$1" "$(esc "$2")"
}

# Does the body carry this pattern? `grep` exiting 1 on no match is not an error here.
has() { printf '%s' "$1" | grep -q -- "$2"; }
# One boolean field of a JSON document, whitespace stripped first so formatting cannot
# hide it: `true` / `false` / nothing readable.
json_flag() {
  printf '%s' "$1" | tr -d '[:space:]' | grep -o "\"$2\":\(true\|false\)" | tail -n 1 | sed 's/^.*://' || true
}

# FRESH (no admin yet) / DONE / UNKNOWN / OFFLINE. Navidrome puts its config in the page as
# JSON, where the flag arrives escaped as `firstTime\":true`; the unescaped spelling is the
# same signal, so both are matched. Only a POSITIVE "not set up yet" signal may lead to a
# change; anything else is reported as unreadable.
first_time_state() {
  local resp code body
  resp="$(http "$(cfg_get "$BASE_URL/app/")")"
  code="$(code_of "$resp")"
  body="$(body_of "$resp")"
  if [ -z "$resp" ] || [ -z "$code" ] || [ "$code" = "000" ]; then printf '%s' "OFFLINE"; return 0; fi
  if [ "$code" != "200" ]; then printf '%s' "UNKNOWN"; return 0; fi
  if has "$body" 'firstTime":true' || has "$body" 'firstTime\\":true'; then
    printf '%s' "FRESH"
  elif has "$body" 'firstTime":false' || has "$body" 'firstTime\\":false'; then
    printf '%s' "DONE"
  else
    printf '%s' "UNKNOWN"
  fi
}

# ── wait for the app (a first start prepares its own database first) ───────────────
# Bounded twice: a $SECONDS budget well inside the manifest's 180 s, and max-time 10 in the
# probe's own config, so a single stuck request cannot outlive the wait.
state=""
wait_deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$wait_deadline" ]; do
  state="$(first_time_state)"
  if [ "$state" != "OFFLINE" ]; then break; fi
  sleep 2
done
case "$state" in
  FRESH) ;;
  DONE) die "Navidrome already has its own first admin, so this install was left alone; nothing was changed." 3 ;;
  OFFLINE | "") die "Navidrome did not answer on its web port; nothing was changed." 4 ;;
  *) die "Navidrome's setup state could not be read; nothing was changed." 4 ;;
esac

# ── create the first admin ─────────────────────────────────────────────────────────
create_body="{\"username\":\"$ADMIN_USER\",\"password\":\"$(esc "$PW")\"}"
resp="$(http "$(cfg_post "$BASE_URL/auth/createAdmin" "$create_body")")"
code="$(code_of "$resp")"
created_flag=""
if [ "$code" = "200" ]; then created_flag="$(json_flag "$(body_of "$resp")" isAdmin)"; fi
if [ "$created_flag" != "true" ]; then
  # Navidrome refused, or did not say what it did. Its own state decides: a second create
  # answers 403 with a message, never a 4xx that alone means "already set up".
  again="$(first_time_state)"
  case "$again" in
    DONE) die "Navidrome already has its own first admin, so this install was left alone; nothing was changed." 3 ;;
    FRESH) die "Navidrome did not create the admin account, so nothing was changed; check the app's own login." 1 ;;
    *) die "Navidrome did not report whether it created the admin account; check the app's own login before trying again." 1 ;;
  esac
fi
say "Navidrome's admin account '$ADMIN_USER' is in place."

# ── prove the new login works ───────────────────────────────────────────────────────
login_body="{\"username\":\"$ADMIN_USER\",\"password\":\"$(esc "$PW")\"}"
cfg_login() {
  printf 'url = "%s"\nmax-time = 10\nrequest = "POST"\nheader = "Content-Type: application/json"\ndata = "%s"\n' \
    "$BASE_URL/auth/login" "$(esc "$login_body")"
}
prove() {
  local answer
  answer="$(http "$(cfg_login)")"
  if [ "$(code_of "$answer")" = "200" ]; then printf '%s' "LOGIN-OK"; else printf '%s' "LOGIN-FAIL"; fi
}
attempt=1
proof=""
proof_deadline=$((SECONDS + 40))
while :; do
  proof="$(prove)"
  if [ "$proof" = "LOGIN-OK" ]; then break; fi
  if [ "$attempt" -ge 3 ]; then break; fi
  if [ "$SECONDS" -ge "$proof_deadline" ]; then break; fi
  attempt=$((attempt + 1))
  sleep 3
done
if [ "$proof" != "LOGIN-OK" ]; then
  # Navidrome confirmed the change, so the new password IS its password: Crow keeps it and
  # says it could not log in with it (exit 5).
  die "Navidrome accepted the new password, but logging in with it did not succeed; Crow kept the new password; use the login in Settings → Passwords." 5
fi

say "Navidrome's admin login for '$ADMIN_USER' now uses the password Crow generated."