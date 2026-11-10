#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# Stirling PDF 2.x has its login ON by default and ships the account `admin` / `stirling`,
# on a loopback port — anything else on the machine can sign in to a fresh install with it.
# This script replaces that password with the one Crow generated.
#
# Two constraints shape it. First, the account LOCK: a handful of failed logins locks it
# for hours, so this script makes at most ONE attempt with the shipped password per run and
# its proof loop stops at the first answer that says the account is locked. Second, a login
# that no longer works with `stirling` is one the operator made their own, so nothing is
# changed (exit 3) — the shipped default is checked before anything is touched.
#
# The bundle publishes the UI on 127.0.0.1:8092, so every request is made from THIS host
# with curl reading its config from stdin (`curl -K -`); the container is only checked with
# `docker inspect`. Nothing secret is ever an argument, an environment value or output.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin. Exit
# 0 = the admin now has exactly that password, 3 = the shipped login no longer works (left
# alone), 4 = not running / not answering / no curl on this host, 5 = Stirling took the new
# password but logging in with it did not succeed, anything else = failed.
#
# A run that ends at 3 has already spent the one sign-in attempt it may spend, and every
# retry spends another (5 of them inside the window lock the account for 2 h). So that run
# leaves `.crow-first-admin-kept` in this directory — the installed bundle's own — and a run
# that finds it exits 3 at once, without signing in at all.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-stirling-pdf}"
BASE_URL="http://127.0.0.1:8092"
# Stirling's shipped account and its shipped password.
DEFAULT_PW="stirling"
# An empty value is refused below rather than silently replaced, because an empty one
# means the declaration is broken — only an UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-admin}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._@-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; Stirling PDF was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# The file this script leaves after a run that ended at 3, next to it in the installed bundle
# directory: from then on a run refuses without spending another sign-in attempt.
KEPT_MARKER=".crow-first-admin-kept"

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; Stirling PDF was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; Stirling PDF was not touched."

# ── a run that already ended at 3 signs in no more ────────────────────────────────
# Nothing about the install changes between presses of "Set it up for me", so another run
# would only cost the account another failed sign-in — and five of those lock it for 2 h.
if [ -e "$KEPT_MARKER" ]; then
  die "Stirling PDF's shipped login did not work on an earlier run, so this install already has its own admin password; left alone, and no sign-in attempt was made this time (each attempt counts towards the account's lockout; remove $KEPT_MARKER to try again)." 3
fi

# Escaping for a curl config value (curl reads its config from stdin with `-K -`): a
# double-quoted value there understands exactly two escapes, `\\` and `\"`.
esc() { local s="${1//\\/\\\\}"; printf '%s' "${s//\"/\\\"}"; }

# ── docker, the container, and the tool this script talks to Stirling with ──────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Stirling PDF container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Stirling PDF is not running; nothing was changed." 4
command -v curl >/dev/null 2>&1 || die "curl is not available on this host, so Stirling PDF cannot be reached from it; nothing was changed." 4

# ── one HTTP call, its config on stdin ──────────────────────────────────────────────
# Prints the body and then one final line with the HTTP status code (that is what
# `-w '\n%{http_code}'` appends). Nothing at all means curl could not reach the app.
http() {
  printf '%s' "$1" | curl -sS -K - -w '\n%{http_code}' 2>/dev/null || true
}
code_of() { printf '%s' "${1##*$'\n'}"; }
body_of() { printf '%s' "${1%$'\n'*}"; }

# cfg_login PASSWORD: the config for Stirling's own login call (JSON body, never argv).
cfg_login() {
  printf 'url = "%s/api/v1/auth/login"\nmax-time = 10\nrequest = "POST"\nheader = "Content-Type: application/json"\ndata = "%s"\n' \
    "$BASE_URL" "$(esc "{\"username\":\"$ADMIN_USER\",\"password\":\"$(esc "$1")\"}")"
}

# alive: true while Stirling's web root answers at all.
alive() {
  local code
  code="$(printf 'url = "%s/"\nmax-time = 5\n' "$BASE_URL" | curl -sS -K - -o /dev/null -w '%{http_code}' 2>/dev/null || true)"
  [ -n "$code" ] && [ "$code" != "000" ]
}

# token_of BODY: the access token from Stirling's login answer, without printing it.
token_of() {
  local t
  t="$(printf '%s\n' "$1" | grep -o '"access_token"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/^[^:]*:[[:space:]]*"//; s/"$//')"
  [ -n "$t" ] || t="$(printf '%s\n' "$1" | grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/^[^:]*:[[:space:]]*"//; s/"$//')"
  printf '%s' "$t"
}

# locked BODY: whether this answer says the account is locked (the password did not decide).
# The WORD only: an answer that merely carries it inside another word decided nothing.
locked() { printf '%s' "$1" | grep -qiE '\blocked\b'; }

# ── wait for the app (a first start prepares its own configuration first) ──────────
# Bounded twice: a $SECONDS budget well inside the manifest's 240 s, and max-time 5 in the
# probe's own config, so a single stuck request cannot outlive the wait.
up=""
wait_deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$wait_deadline" ]; do
  if alive; then up=1; break; fi
  sleep 2
done
[ -n "$up" ] || die "Stirling PDF did not answer on its web port; nothing was changed." 4

# ── is the shipped default login still working? ONE attempt, never more ────────────
# Every failed sign-in counts towards the account's lockout, so this run makes exactly one:
# 200 = the shipped login works, an answer that refuses those credentials = the operator
# changed it, anything unreadable = not answering. A locked account is left alone too, with
# an honest reason (nothing was changed either way). Both of those end at 3, so both leave
# the marker that keeps the next run out of the app's lockout counter.
resp="$(http "$(cfg_login "$DEFAULT_PW")")"
code="$(code_of "$resp")"
body="$(body_of "$resp")"
case "$code" in
  200) ;;
  400 | 401 | 403)
    if locked "$body"; then
      : > "$KEPT_MARKER" 2>/dev/null || true
      die "Stirling PDF's admin account is locked after too many failed sign-ins; nothing was changed, and no further run signs in until $KEPT_MARKER is removed. Wait for the lock to expire (or unlock it in Stirling), then use 'Set it up for me' again — each retry costs another sign-in attempt." 3
    fi
    : > "$KEPT_MARKER" 2>/dev/null || true
    die "Stirling PDF's shipped login no longer works, so this install already has its own admin password; left alone, and no further run signs in until $KEPT_MARKER is removed. Each retry costs another sign-in attempt, and 5 of them lock the account for 2 hours." 3
    ;;
  *) die "Stirling PDF did not answer on its login API; nothing was changed." 4 ;;
esac

token="$(token_of "$body")"
resp=""
body=""
case "$token" in
  "" | *[!A-Za-z0-9._~+/-]*) die "Stirling PDF accepted the shipped login but handed back no usable token; nothing was changed." 4 ;;
esac

# ── set the new password ───────────────────────────────────────────────────────────
# The bearer token and both password fields stay inside the curl config on stdin, as form
# fields the app's own endpoint expects.
resp="$(http "$(printf 'url = "%s/api/v1/user/change-password-on-login"\nmax-time = 10\nrequest = "POST"\nheader = "Authorization: Bearer %s"\ndata-urlencode = "currentPassword=%s"\ndata-urlencode = "newPassword=%s"\ndata-urlencode = "confirmPassword=%s"\n' \
  "$BASE_URL" "$token" "$(esc "$DEFAULT_PW")" "$(esc "$PW")" "$(esc "$PW")")")"
set_code="$(code_of "$resp")"
resp=""
token=""
confirmed=""
if [ "$set_code" = "200" ]; then
  confirmed=1
else
  # A request that did not answer 200 may still have written the password: logins with the real
  # password decide, and at most TWO of them — every one of them counts towards the lockout.
  attempt=1
  while :; do
    if [ "$(code_of "$(http "$(cfg_login "$PW")")")" = "200" ]; then confirmed=1; break; fi
    if [ "$attempt" -ge 2 ]; then break; fi
    attempt=$((attempt + 1))
    sleep 2
  done
fi
[ -n "$confirmed" ] || die "Stirling PDF did not confirm the new password; the password may have changed; check the app's own login." 1
say "Stirling PDF confirmed the new password for the account '$ADMIN_USER'."

# ── prove the new login works ─────────────────────────────────────────────────────
# Three tries at most, 40 s at most, and the loop stops at the FIRST answer that says the
# account is locked: another attempt would only deepen the lock.
prove() {
  local answer answer_code answer_body
  answer="$(http "$(cfg_login "$PW")")"
  answer_code="$(code_of "$answer")"
  answer_body="$(body_of "$answer")"
  if [ "$answer_code" = "200" ]; then printf '%s' "LOGIN-OK"; return 0; fi
  if locked "$answer_body"; then printf '%s' "LOCKED"; return 0; fi
  printf '%s' "LOGIN-FAIL"
}
attempt=1
proof=""
proof_deadline=$((SECONDS + 40))
while :; do
  proof="$(prove)"
  if [ "$proof" = "LOGIN-OK" ]; then break; fi
  if [ "$proof" = "LOCKED" ]; then break; fi
  if [ "$attempt" -ge 3 ]; then break; fi
  if [ "$SECONDS" -ge "$proof_deadline" ]; then break; fi
  attempt=$((attempt + 1))
  sleep 3
done
if [ "$proof" = "LOCKED" ]; then
  # The app confirmed the change, so the account holds this password; only the sign-in is
  # blocked, and more attempts would make that worse.
  die "Stirling PDF accepted the new password, but its admin account is now locked after too many sign-ins; wait for the lock to expire before signing in. Crow kept the new password; use the login in Settings → Passwords." 5
fi
if [ "$proof" != "LOGIN-OK" ]; then
  # The app confirmed the change, so the new password IS its password: Crow keeps it and says
  # it could not log in with it (exit 5).
  die "Stirling PDF accepted the new password, but logging in with it did not succeed; Crow kept the new password; use the login in Settings → Passwords." 5
fi

say "Stirling PDF's admin login for '$ADMIN_USER' now uses the password Crow generated."