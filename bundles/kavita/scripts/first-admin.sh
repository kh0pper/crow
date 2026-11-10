#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# Kavita's first start offers "register to make the first account an admin", and the first
# caller that registers owns the server. That page answers on 127.0.0.1:5000 inside the
# container, so an install left alone is claimable by anything else on the machine. This
# script registers that account itself, with the password Crow generated, before the
# operator's first visit.
#
# Every request is made INSIDE the container, with the curl its image ships, and the request
# config travels on stdin (`curl -K -`): the admin username and the password are never an
# argument, an environment value or output.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin.
# Exit 0 = the admin now has exactly that password, 3 = Kavita already has an admin (nothing
# changed), 4 = not running / not answering / unreadable, 5 = Kavita took the new password
# but logging in with it did not succeed, anything else = failed. A register answer that
# does not say the account was made is settled by reading Kavita's own state again: a
# server that now has an admin keeps the password and proves it (0 or 5), one that still
# has none changed nothing (1).
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-kavita}"
BASE_URL="http://127.0.0.1:5000"
# Crow creates `admin`; an empty value is refused below rather than silently replaced,
# because an empty one means the declaration is broken — only an UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-admin}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; Kavita was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; Kavita was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; Kavita was not touched."

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Kavita container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Kavita is not running; nothing was changed." 4

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

# Does the body carry this text? `grep` exiting 1 on no match is not an error here.
has() { printf '%s' "$1" | grep -q -- "$2"; }

# FRESH (no admin yet) / DONE / UNKNOWN / OFFLINE. Kavita answers this one anonymously with
# a bare JSON boolean. Only a POSITIVE `false` may lead to a change; anything else is
# reported as unreadable.
admin_state() {
  local resp code body answer
  resp="$(http "$(cfg_get "$BASE_URL/api/Admin/exists")")"
  code="$(code_of "$resp")"
  body="$(body_of "$resp")"
  if [ -z "$resp" ] || [ -z "$code" ] || [ "$code" = "000" ]; then printf '%s' "OFFLINE"; return 0; fi
  if [ "$code" != "200" ]; then printf '%s' "UNKNOWN"; return 0; fi
  answer="$(printf '%s' "$body" | tr -d '[:space:]')"
  case "$answer" in
    false) printf '%s' "FRESH" ;;
    true) printf '%s' "DONE" ;;
    *) printf '%s' "UNKNOWN" ;;
  esac
}

# ── wait for the app (a first start migrates its own database first) ───────────────
# Bounded twice: a $SECONDS budget well inside the manifest's 180 s, and max-time 10 in the
# probe's own config, so a single stuck request cannot outlive the wait.
state=""
wait_deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$wait_deadline" ]; do
  state="$(admin_state)"
  if [ "$state" != "OFFLINE" ]; then break; fi
  sleep 2
done
case "$state" in
  FRESH) ;;
  DONE) die "Kavita already has its own admin account, so this install was left alone; nothing was changed." 3 ;;
  OFFLINE | "") die "Kavita did not answer on its web port; nothing was changed." 4 ;;
  *) die "Kavita's admin state could not be read; nothing was changed." 4 ;;
esac

# ── register the first admin ───────────────────────────────────────────────────────
# Kavita's registration wants an email address; the account is a local one, so the address
# is derived from the username in the reserved .invalid domain and never receives mail.
register_body="{\"username\":\"$ADMIN_USER\",\"email\":\"$ADMIN_USER@localhost.invalid\",\"password\":\"$(esc "$PW")\"}"
resp="$(http "$(cfg_post "$BASE_URL/api/Account/register" "$register_body")")"
code="$(code_of "$resp")"
made_admin=""
if [ "$code" = "200" ] && has "$(body_of "$resp")" 'Admin'; then made_admin=1; fi
if [ -z "$made_admin" ]; then
  # Kavita refused (a second registration answers 400 "Not allowed"), or did not say what it
  # did. Its own state decides, never the status code alone.
  again="$(admin_state)"
  case "$again" in
    DONE) die "Kavita already has its own admin account, so this install was left alone; nothing was changed." 3 ;;
    FRESH) die "Kavita did not create the admin account, so nothing was changed; check the app's own login." 1 ;;
    *) die "Kavita did not report whether it created the admin account; check the app's own login before trying again." 1 ;;
  esac
fi
say "Kavita's admin account '$ADMIN_USER' is in place."

# ── prove the new login works ───────────────────────────────────────────────────────
login_body="{\"username\":\"$ADMIN_USER\",\"password\":\"$(esc "$PW")\"}"
cfg_login() {
  printf 'url = "%s"\nmax-time = 10\nrequest = "POST"\nheader = "Content-Type: application/json"\ndata = "%s"\n' \
    "$BASE_URL/api/Account/login" "$(esc "$login_body")"
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
  # Kavita confirmed the change, so the new password IS its password: Crow keeps it and says
  # it could not log in with it (exit 5).
  die "Kavita accepted the new password, but logging in with it did not succeed; Crow kept the new password; use the login in Settings → Passwords." 5
fi

say "Kavita's admin login for '$ADMIN_USER' now uses the password Crow generated."