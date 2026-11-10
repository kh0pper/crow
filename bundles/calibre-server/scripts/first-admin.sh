#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# The content server is started with `--enable-auth --auth-mode basic`, and the login it asks
# for is one this script has to create: a fresh install has an empty user database, so the
# first thing that creates an account decides who owns the library. Crow creates it here,
# with the password Crow generated, right after the container starts — before the operator's
# first visit and before anything else on the machine can reach the loopback port.
#
# Calibre's own binary, inside the container, is what lists and creates accounts; the proof
# is a login made from THIS host with curl reading its config from stdin (`curl -K -`). The
# password is never an argument, an environment value or a line of output.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin.
#   0 = the account for the declared user now has exactly that password
#   3 = Calibre already has accounts (set up earlier); left alone, nothing changed
#   4 = not running / not answering / account list unreadable / no docker or curl here
#   5 = Calibre confirmed Crow's create, but logging in with that password did not succeed
#   1 = anything else (a create that did not happen and left no account behind)
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-calibre-server}"
# The bundle publishes the content server on the loopback only (127.0.0.1:8081); that is the
# address anything on this machine reaches it at.
BASE_URL="http://127.0.0.1:8081"
# The image ships its own calibre at /opt/calibre; its user database is the file the compose
# command starts the server with.
CALIBRE_BIN="/opt/calibre/calibre-server"
USER_DB="/config/users.sqlite"
# Crow creates `admin`; an empty value is refused below rather than silently replaced,
# because an empty one means the declaration is broken — only an UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-admin}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; Calibre was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; Calibre was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; Calibre was not touched."

# Escaping for a curl config value (curl reads its config from stdin with `-K -`): a
# double-quoted value there understands exactly two escapes, `\\` and `\"`.
esc() { local s="${1//\\/\\\\}"; printf '%s' "${s//\"/\\\"}"; }

# ── docker, the container, and the tool this host reaches Calibre with ──────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Calibre container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Calibre's content server is not running; nothing was changed." 4
command -v curl >/dev/null 2>&1 || die "curl is not available on this host, so Calibre cannot be reached from it; nothing was changed." 4

# ── one HTTP call from this host, its config on stdin ──────────────────────────────
# Prints the HTTP status code only (that is what `-w '%{http_code}'` appends); nothing at
# all means the request did not happen. No `-L`: an answer has to show up as that answer.
http_code() { printf '%s' "$1" | curl -sS -K - -o /dev/null -w '%{http_code}' 2>/dev/null || true; }
cfg_get() { printf 'url = "%s"\nmax-time = 5\n' "$1"; }

# ── wait for the server (a first start creates the empty library folder) ───────────
# The compose healthcheck asks the same page: `/` serves the app shell without a login,
# while everything under /ajax needs one. Bounded twice: a $SECONDS budget well inside the
# manifest's 180 s, and max-time 5 in each probe's own config.
ready=""
wait_deadline=$((SECONDS + 45))
while [ "$SECONDS" -lt "$wait_deadline" ]; do
  ready="$(http_code "$(cfg_get "$BASE_URL/")")"
  if [ "$ready" = "200" ]; then break; fi
  sleep 1
done
[ "$ready" = "200" ] || die "Calibre did not answer on its web port; nothing was changed." 4

# ── what Calibre says about its own accounts ───────────────────────────────────────
# `--manage-users -- list` exits 0 and prints one username per line; EMPTY output with
# exit 0 is a fresh install with no accounts. A nonzero exit is an unreadable list — exit 4,
# never "no accounts": creating over a list nobody could read would claim an install whose
# accounts are someone else's.
users_raw() { timeout 20 docker exec "$CONTAINER" "$CALIBRE_BIN" --userdb "$USER_DB" --manage-users -- list 2>/dev/null; }
USERS_RAW=""
# Reads the list once into USERS_RAW; false when Calibre would not give one. No sentinel word
# is involved, so an account that happens to be named like a status cannot be mistaken for one.
read_users() {
  local raw
  if ! raw="$(users_raw)"; then return 1; fi
  USERS_RAW="$raw"
  return 0
}
has_account() { printf '%s\n' "$USERS_RAW" | grep -qxF -- "$ADMIN_USER"; }

read_users || die "Calibre's account list could not be read; nothing was changed." 4
if [ -n "$(printf '%s' "$USERS_RAW" | tr -d '[:space:]')" ]; then
  die "Calibre already has accounts; left alone, and nothing was changed." 3
fi

# ── create the account ─────────────────────────────────────────────────────────────
# The password travels on stdin with NO trailing newline: Calibre stores whatever bytes it is
# given, newline included, and a stored newline makes its own login fail.
confirmed=""
add_exit=0
printf '%s' "$PW" | timeout 30 docker exec -i "$CONTAINER" "$CALIBRE_BIN" --userdb "$USER_DB" --manage-users -- add "$ADMIN_USER" >/dev/null 2>&1 || add_exit=$?
if [ "$add_exit" -eq 0 ]; then confirmed=1; fi
if [ -z "$confirmed" ]; then
  # Calibre answered without saying it created the account (a name that already exists
  # answers "already exists" with a nonzero exit), or `timeout` killed the docker CLIENT
  # while the create went on inside the container. Its own account list decides, never the
  # exit code alone — and it is read again a few times first: a create that just timed out
  # can appear a second or two later, and dropping the password then would leave an account
  # nobody here knows the password to. Five reads over ~8 s, well inside this step's share
  # of the manifest's 180 s. The name appearing is not proof by itself: the login below is.
  found=""
  reread=0
  while [ "$reread" -lt 5 ]; do
    if [ "$reread" -gt 0 ]; then sleep 2; fi
    reread=$((reread + 1))
    # An unreadable list is never "no accounts": creating over one would claim an install
    # whose accounts are someone else's.
    read_users || die "Calibre did not report whether it created the account; check the app's own login before trying again." 1
    if [ -n "$(printf '%s' "$USERS_RAW" | tr -d '[:space:]')" ]; then
      has_account || die "Calibre has accounts, but none named '$ADMIN_USER', so Crow's password cannot open one; left alone, and nothing of Crow's was saved." 3
      found=1
      break
    fi
  done
  [ -n "$found" ] || die "Calibre did not create the account, so nothing was changed; check the app's own login." 1
fi

# ── prove the new login works ──────────────────────────────────────────────────────
# The running server reads the user database live, so no restart is needed. AT MOST TWO
# attempts: Calibre bans an address after five failed logins, so a third try here would eat
# into that allowance for no gain.
cfg_probe() {
  printf 'url = "%s/ajax/library-info"\nmax-time = 10\nuser = "%s"\n' "$BASE_URL" "$(esc "$ADMIN_USER:$PW")"
}
prove() {
  local code
  code="$(http_code "$(cfg_probe)")"
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
  # Calibre itself confirmed the create, so the new password IS its password: Crow keeps it
  # and says it could not log in with it (exit 5). Without that confirmation the account is
  # not Crow's — Crow's password does not open it — so nothing is saved (exit 3).
  if [ -n "$confirmed" ]; then
    die "Calibre accepted the new password, but logging in with it did not succeed; Crow kept the new password; use the login in Settings → Passwords." 5
  fi
  die "Calibre has an account that is not Crow's: logging in with Crow's password did not succeed; left alone, and nothing of Crow's was saved." 3
fi

say "Calibre's admin login for '$ADMIN_USER' now uses the password Crow generated."