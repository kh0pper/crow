#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# AdGuard Home's first start serves its own setup wizard on port 3000 inside the container,
# and the first caller that fills that form in owns the DNS server. That form answers on
# 127.0.0.1:3000, so an install left alone is claimable by anything else on the machine.
# This script fills it in itself, with the password Crow generated, before the operator's
# first visit — and it pins the admin web port to 3000, because the wizard's own default
# (port 80) is not the port the compose file maps, and an admin UI on 80 would be
# unreachable through `127.0.0.1:3020`.
#
# Every request is made INSIDE the container with the wget its image ships (this image has
# no curl). The JSON body travels to wget on its own stdin (`--post-file=/dev/stdin`), so
# the admin username and the password are never an argument, an environment value or
# output. The HTTP status is read from the response HEADERS, which busybox wget prints on
# stderr when -S is given; its stdout carries the body and is dropped wherever only the
# status matters.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin.
# Exit 0 = the admin now has exactly that password, 3 = this install already has its own
# admin (its setup was finished earlier) and nothing of Crow's was saved, 4 = not running /
# not answering / unreadable, 5 = AdGuard Home confirmed Crow's own change but logging in
# with it did not succeed, anything else = failed. A configure answer that does not say the
# setup happened is settled by reading AdGuard Home's own state again: an install that now
# has its admin is proved with a real login (0, or 3 when that login does not work — the
# admin is then someone else's), one that still reports a fresh wizard changed nothing (1).
#
# AdGuard Home locks an account out for 15 minutes after five failed logins, so the proof
# makes at most TWO attempts and never retries past them.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-adguard}"
# Inside its own container AdGuard Home serves the wizard and the admin UI on port 3000.
BASE_URL="http://127.0.0.1:3000"
# Crow creates `admin`; an empty value is refused below rather than silently replaced,
# because an empty one means the declaration is broken — only an UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-admin}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; AdGuard Home was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; AdGuard Home was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; AdGuard Home was not touched."

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the AdGuard Home container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "AdGuard Home is not running; nothing was changed." 4

# Escaping for a JSON string value: a backslash and a double quote are the only two
# characters JSON escapes, and the body is built as one line by hand.
esc() { local s="${1//\\/\\\\}"; printf '%s' "${s//\"/\\\"}"; }

# ── one HTTP call inside the container ─────────────────────────────────────────────
# Bounded twice: `timeout` on the host around the whole exec, and wget's own `-T`, so a
# stuck container can never outlive the manifest's budget.
#
# The status of a request whose body (stdout) nobody needs: `2>&1 >/dev/null` sends the
# stderr headers into the capture and wget's stdout to /dev/null. busybox wget answers a
# 4xx with a nonzero exit code, which is not an error here — the headers are still printed,
# so the status line is read out of them either way.
status_of_get() { # $1 = path
  local headers
  headers="$(timeout 15 docker exec -i "$CONTAINER" wget -q -T 10 -O /dev/null -S "$BASE_URL$1" </dev/null 2>&1 >/dev/null || true)"
  printf '%s\n' "$headers" | sed -n 's/.*HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*/\1/p' | tail -n 1
}
status_of_post() { # $1 = path, $2 = JSON body (on wget's stdin)
  local headers
  headers="$(printf '%s' "$2" | timeout 15 docker exec -i "$CONTAINER" wget -q -T 10 -O /dev/null -S \
    --post-file=/dev/stdin --header 'Content-Type: application/json' "$BASE_URL$1" 2>&1 >/dev/null || true)"
  printf '%s\n' "$headers" | sed -n 's/.*HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*/\1/p' | tail -n 1
}
body_of_post() { # $1 = path, $2 = JSON body (on wget's stdin)
  printf '%s' "$2" | timeout 15 docker exec -i "$CONTAINER" wget -q -T 10 -O - \
    --post-file=/dev/stdin --header 'Content-Type: application/json' "$BASE_URL$1" 2>/dev/null || true
}

# FRESH (its setup wizard is still open) / DONE (a setup already exists) / OFFLINE /
# UNKNOWN. Only a 200 on the install endpoint is a POSITIVE "nothing is set up yet" signal,
# and only a 403 is a positive "already set up"; anything else is unreadable and changes
# nothing.
setup_state() {
  local code
  code="$(status_of_get /control/install/get_addresses)"
  if [ -z "$code" ]; then printf '%s' "OFFLINE"; return 0; fi
  case "$code" in
    200) printf '%s' "FRESH" ;;
    403) printf '%s' "DONE" ;;
    *) printf '%s' "UNKNOWN" ;;
  esac
}

# ── wait for the app (its first start prepares its own files first) ────────────────
state=""
wait_deadline=$((SECONDS + 40))
while [ "$SECONDS" -lt "$wait_deadline" ]; do
  state="$(setup_state)"
  if [ "$state" != "OFFLINE" ]; then break; fi
  sleep 2
done
case "$state" in
  FRESH) ;;
  DONE) die "AdGuard Home already has its own admin login, so this install was left alone; nothing was changed." 3 ;;
  OFFLINE | "") die "AdGuard Home did not answer on its setup port; nothing was changed." 4 ;;
  *) die "AdGuard Home's setup state could not be read; nothing was changed." 4 ;;
esac

# ── finish the setup wizard with Crow's own login ─────────────────────────────────
# The web UI MUST stay on 3000: 80 is the wizard's default and this bundle maps 3020 → 3000.
configure_body="{\"web\":{\"ip\":\"0.0.0.0\",\"port\":3000},\"dns\":{\"ip\":\"0.0.0.0\",\"port\":53},\"username\":\"$ADMIN_USER\",\"password\":\"$(esc "$PW")\"}"
# `confirmed` records the one thing that lets Crow keep the password after a login that does
# not work: AdGuard Home itself answering the configure call with its own OK.
confirmed=""
answer="$(body_of_post /control/install/configure "$configure_body")"
if [ "$(printf '%s' "$answer" | tr -d '[:space:]')" = "OK" ]; then
  confirmed=1
else
  # AdGuard Home refused, or did not say what it did. Its own state decides: a setup wizard
  # that is now closed means this password may be the one it holds, and a real login says
  # whether it really is. A wizard that is still open means nothing was written.
  again="$(setup_state)"
  case "$again" in
    DONE) ;;
    FRESH) die "AdGuard Home did not finish its setup wizard, so nothing was changed; check the app's own login." 1 ;;
    *) die "AdGuard Home did not report whether it kept the new setup; check the app's own login before trying again." 1 ;;
  esac
fi
if [ -n "$confirmed" ]; then say "AdGuard Home's admin account '$ADMIN_USER' is in place."; fi

# AdGuard Home switches from the wizard to its normal server once the setup is written:
# waiting for that keeps a restart from being read as a failed login.
up_deadline=$((SECONDS + 15))
while [ "$SECONDS" -lt "$up_deadline" ]; do
  if [ -n "$(status_of_get /control/install/get_addresses)" ]; then break; fi
  sleep 2
done

# ── prove the new login works (at most two attempts: five failures lock the account) ─
login_body="{\"name\":\"$ADMIN_USER\",\"password\":\"$(esc "$PW")\"}"
prove() {
  local code
  code="$(status_of_post /control/login "$login_body")"
  if [ "$code" = "200" ]; then printf '%s' "LOGIN-OK"; else printf '%s' "LOGIN-FAIL"; fi
}
attempt=1
proof=""
proof_deadline=$((SECONDS + 20))
while :; do
  proof="$(prove)"
  if [ "$proof" = "LOGIN-OK" ]; then break; fi
  if [ "$attempt" -ge 2 ]; then break; fi
  if [ "$SECONDS" -ge "$proof_deadline" ]; then break; fi
  attempt=$((attempt + 1))
  sleep 3
done
if [ "$proof" != "LOGIN-OK" ]; then
  # AdGuard Home itself confirmed the change, so the new password IS its password: Crow
  # keeps it and says it could not log in with it (exit 5). Without that confirmation a
  # setup that appeared is not Crow's — Crow's password does not open it — so nothing is
  # saved (exit 3).
  if [ -n "$confirmed" ]; then
    die "AdGuard Home accepted the new password, but logging in with it did not succeed; Crow kept the new password; use the login in Settings → Passwords." 5
  fi
  die "AdGuard Home already has an admin login that is not Crow's: logging in with Crow's password did not succeed; left alone, and nothing of Crow's was saved." 3
fi

say "AdGuard Home's admin login for '$ADMIN_USER' now uses the password Crow generated."