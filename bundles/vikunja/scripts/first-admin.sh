#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# Vikunja answers on 127.0.0.1:3456 and, on a fresh install, its own registration page
# accepts anyone who reaches it — so anything else on the machine could claim the server
# before the operator's first visit. This script registers the owner's account itself, with
# the password Crow generated; the manifest's after-step then turns registration off and
# recreates the container so Vikunja reads it.
#
# The pinned image is distroless (no shell, no curl inside), so every request is made from
# THIS host with curl reading its config from stdin (`curl -K -`). The container is only
# looked at with `docker inspect`, and asked for its own user list with its own binary.
# Nothing secret is ever an argument, an environment value or a line of this script's output.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin.
#   0 = Vikunja's account for the declared user now has exactly that password
#   3 = Vikunja already has accounts (set up earlier); left alone, nothing changed
#   4 = not running / not answering / no docker or curl on this host / registration closed
#       with no account at all (Crow cannot register into a closed app)
#   5 = Vikunja took the password, but logging in with it did not succeed
#   1 = anything else (a registration that did not happen and left no account behind)
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-vikunja}"
# The bundle publishes Vikunja on the loopback only (127.0.0.1:3456); that is the address
# anything on this machine reaches the app at.
BASE_URL="http://127.0.0.1:3456"
# The image is distroless: its own binary is the only way to ask Vikunja about its accounts.
VIKUNJA_BIN="/app/vikunja/vikunja"
# An empty value is refused below rather than silently replaced, because an empty one means
# the declaration is broken — only an UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-admin}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; Vikunja was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; Vikunja was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; Vikunja was not touched."

# Escaping for a curl config value (curl reads its config from stdin with `-K -`): a
# double-quoted value there understands exactly two escapes, `\\` and `\"`. It is used for
# the JSON bodies (where it is also the JSON string escape) and for the config line itself.
esc() { local s="${1//\\/\\\\}"; printf '%s' "${s//\"/\\\"}"; }

# ── docker, the container, and the tool this script talks to Vikunja with ───────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Vikunja container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Vikunja is not running; nothing was changed." 4
command -v curl >/dev/null 2>&1 || die "curl is not available on this host, so Vikunja cannot be reached from it; nothing was changed." 4

# ── one HTTP call, its config on stdin ──────────────────────────────────────────────
# Prints the body and then one final line with the HTTP status code (that is what
# `-w '\n%{http_code}'` appends). Nothing at all means curl could not reach Vikunja.
# Following a redirect belongs to a READ only: a POST answered with one has to show up as
# that answer instead of being replayed to wherever the redirect points.
http_get() { printf '%s' "$1" | curl -sS -L -K - -w '\n%{http_code}' 2>/dev/null || true; }
http_post() { printf '%s' "$1" | curl -sS -K - -w '\n%{http_code}' 2>/dev/null || true; }
code_of() { printf '%s' "${1##*$'\n'}"; }
body_of() { printf '%s' "${1%$'\n'*}"; }

cfg_get() { printf 'url = "%s"\nmax-time = 10\n' "$1"; }
cfg_post() {
  printf 'url = "%s"\nmax-time = 10\nrequest = "POST"\nheader = "Content-Type: application/json"\ndata = "%s"\n' \
    "$1" "$(esc "$2")"
}

# ── what the app says about itself ──────────────────────────────────────────────────
# FRESH (registration open, no account) / ACCOUNTS (accounts exist) / CLOSED (registration
# off and no account) / OFFLINE / UNREADABLE. Every answer is read from data Vikunja prints
# itself: nothing is inferred from a status code alone.
info_state() {
  local resp code body flag
  resp="$(http_get "$(cfg_get "$BASE_URL/api/v1/info")")"
  code="$(code_of "$resp")"
  body="$(body_of "$resp")"
  if [ -z "$resp" ] || [ -z "$code" ] || [ "$code" = "000" ]; then printf '%s' "OFFLINE"; return 0; fi
  if [ "$code" != "200" ]; then printf '%s' "UNREADABLE"; return 0; fi
  flag="$(printf '%s' "$body" | tr -d '[:space:]' | grep -o '"registration_enabled":\(true\|false\)' | head -n 1 || true)"
  case "$flag" in
    '"registration_enabled":true') printf '%s' "OPEN" ;;
    '"registration_enabled":false') printf '%s' "CLOSED" ;;
    *) printf '%s' "UNREADABLE" ;;
  esac
}

# The accounts Vikunja itself reports. `vikunja user list` renders a table: border lines
# (`+---+---+`), one header line naming USERNAME, and one line per account — so anything
# left after dropping blanks, borders and the header IS an account.
users_state() {
  local raw rows
  if ! raw="$(timeout 20 docker exec "$CONTAINER" "$VIKUNJA_BIN" user list 2>/dev/null)"; then
    printf '%s' "UNREADABLE"; return 0
  fi
  rows="$(printf '%s\n' "$raw" | grep -v -E '^[[:space:]]*$' | grep -v -E '^\+[-+]+\+$' | grep -v -i 'USERNAME' || true)"
  if [ -n "$rows" ]; then printf '%s' "PRESENT"; else printf '%s' "NONE"; fi
}

# One word for "what state is this install in", from the registration flag this run already
# read ($1) and Vikunja's own account list. Accounts come first: an install that already has
# them is left alone whatever its registration page says.
detect() {
  local reg="$1" users
  users="$(users_state)"
  case "$users" in
    UNREADABLE) printf '%s' "UNREADABLE"; return 0 ;;
    PRESENT) printf '%s' "ACCOUNTS"; return 0 ;;
  esac
  case "$reg" in
    OPEN) printf '%s' "FRESH" ;;
    CLOSED) printf '%s' "CLOSED" ;;
    *) printf '%s' "UNREADABLE" ;;
  esac
}

# ── wait for the app (a first start migrates its own database first) ───────────────
# Bounded twice: a $SECONDS budget well inside the manifest's 180 s, and max-time 10 in the
# probe's own config, so a single stuck request cannot outlive the wait.
info=""
wait_deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$wait_deadline" ]; do
  info="$(info_state)"
  if [ "$info" != "OFFLINE" ]; then break; fi
  sleep 2
done
[ "$info" != "OFFLINE" ] || die "Vikunja did not answer on its web port; nothing was changed." 4

state="$(detect "$info")"
case "$state" in
  FRESH) ;;
  ACCOUNTS) die "Vikunja already has accounts; left alone, and nothing was changed." 3 ;;
  CLOSED) die "Vikunja's registration is closed and it has no account, so Crow cannot create one: set VIKUNJA_ENABLE_REGISTRATION=true on its Extensions card, press Restart, and try again — nothing was changed." 4 ;;
  *) die "Vikunja's accounts could not be read; nothing was changed." 4 ;;
esac

# ── register the account ────────────────────────────────────────────────────────────
# Vikunja's registration wants an email address; the account is a local one, so the address
# is derived from the username in the reserved .invalid domain and never receives mail.
# `confirmed` is the one thing that lets Crow keep the password after a login that does not
# work: Vikunja itself answering 200 with Crow's own user object.
register_body="{\"username\":\"$ADMIN_USER\",\"email\":\"$ADMIN_USER@localhost.invalid\",\"password\":\"$(esc "$PW")\"}"
confirmed=""
resp="$(http_post "$(cfg_post "$BASE_URL/api/v1/register" "$register_body")")"
code="$(code_of "$resp")"
body="$(body_of "$resp")"
if [ "$code" = "200" ] && printf '%s' "$body" | grep -q '"username"'; then confirmed=1; fi
resp=""
body=""
if [ -z "$confirmed" ]; then
  # Vikunja refused (registration closed in the meantime, validation, or a second
  # registration) or did not say what it did. Its own account list decides, never the status
  # code alone: an account that appeared is proved with a real login below.
  again="$(detect "$(info_state)")"
  case "$again" in
    ACCOUNTS) ;;
    FRESH | CLOSED) die "Vikunja did not create the account, so nothing was changed; check the app's own login." 1 ;;
    *) die "Vikunja did not report whether it created the account; check the app's own login before trying again." 1 ;;
  esac
fi

# ── prove the new login works ───────────────────────────────────────────────────────
# Three tries, and never more than 30 s of them: each request is bounded by max-time in its
# config, this budget bounds the whole loop.
cfg_login() {
  printf 'url = "%s/api/v1/login"\nmax-time = 10\nrequest = "POST"\nheader = "Content-Type: application/json"\ndata = "%s"\n' \
    "$BASE_URL" "$(esc "{\"username\":\"$ADMIN_USER\",\"password\":\"$(esc "$PW")\"}")"
}
prove() {
  local answer
  answer="$(http_post "$(cfg_login)")"
  if [ "$(code_of "$answer")" = "200" ]; then printf '%s' "LOGIN-OK"; else printf '%s' "LOGIN-FAIL"; fi
}
attempt=1
proof=""
proof_deadline=$((SECONDS + 30))
while :; do
  proof="$(prove)"
  if [ "$proof" = "LOGIN-OK" ]; then break; fi
  if [ "$attempt" -ge 3 ]; then break; fi
  if [ "$SECONDS" -ge "$proof_deadline" ]; then break; fi
  attempt=$((attempt + 1))
  sleep 3
done
if [ "$proof" != "LOGIN-OK" ]; then
  # Vikunja itself confirmed the change, so the new password IS its password: Crow keeps it
  # and says it could not log in with it (exit 5). Without that confirmation an account that
  # appeared is not Crow's — Crow's password does not open it — so nothing is saved (exit 3).
  if [ -n "$confirmed" ]; then
    die "Vikunja accepted the new password, but logging in with it did not succeed; Crow kept the new password; use the login in Settings → Passwords." 5
  fi
  die "Vikunja already has an account that is not Crow's: logging in with Crow's password did not succeed; left alone, and nothing of Crow's was saved." 3
fi

say "Vikunja's admin login for '$ADMIN_USER' now uses the password Crow generated."