#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# Shiori ships the login `shiori` / `gopher` and answers on a loopback port, so anything
# else on the machine can sign in to a fresh install with it. This script replaces that
# password with the one Crow generated — and only while the shipped default still works,
# because a login that no longer answers is one the operator set themselves.
#
# The pinned image is distroless (no shell, no curl inside), so every request is made from
# THIS host with curl reading its config from stdin (`curl -K -`); the container itself is
# only looked at with `docker inspect`. Nothing secret is ever an argument, an environment
# value or a line of this script's output.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin. Exit
# 0 = the admin now has exactly that password, 3 = the default login no longer works
# (this install already has its own admin password; left alone), 4 = not running / not
# answering / no curl on this host, 5 = Shiori took the new password but logging in with
# it did not succeed, anything else = failed.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-shiori}"
# The bundle publishes Shiori on the loopback only (127.0.0.1:8086); that is the address
# anything on this machine reaches the app at.
BASE_URL="http://127.0.0.1:8086"
# Shiori's shipped account and its shipped password.
DEFAULT_PW="gopher"
# An empty value is refused below rather than silently replaced, because an empty one
# means the declaration is broken — only an UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-shiori}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._@-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; Shiori was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; Shiori was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; Shiori was not touched."

# Escaping for a curl config value (curl reads its config from stdin with `-K -`): a
# double-quoted value there understands exactly two escapes, `\\` and `\"`. A value written
# through this function can hold anything, which is why the password and the JSON bodies
# never have to become command arguments.
esc() { local s="${1//\\/\\\\}"; printf '%s' "${s//\"/\\\"}"; }

# ── docker, the container, and the tool this script talks to Shiori with ────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Shiori container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Shiori is not running; nothing was changed." 4
command -v curl >/dev/null 2>&1 || die "curl is not available on this host, so Shiori cannot be reached from it; nothing was changed." 4

# ── one HTTP call, its config on stdin ──────────────────────────────────────────────
# Prints the body and then one final line with the HTTP status code (that is what
# `-w '\n%{http_code}'` appends). Nothing at all means curl could not reach Shiori.
http() {
  printf '%s' "$1" | curl -sS -K - -w '\n%{http_code}' 2>/dev/null || true
}
code_of() { printf '%s' "${1##*$'\n'}"; }
body_of() { printf '%s' "${1%$'\n'*}"; }

# cfg_login PASSWORD: the config for Shiori's own login call (JSON body, never argv).
cfg_login() {
  printf 'url = "%s/api/v1/auth/login"\nmax-time = 10\nrequest = "POST"\nheader = "Content-Type: application/json"\ndata = "%s"\n' \
    "$BASE_URL" "$(esc "{\"username\":\"$ADMIN_USER\",\"password\":\"$(esc "$1")\"}")"
}

# alive: true while Shiori's web root answers at all.
alive() {
  local code
  code="$(printf 'url = "%s/"\nmax-time = 5\n' "$BASE_URL" | curl -sS -K - -o /dev/null -w '%{http_code}' 2>/dev/null || true)"
  [ -n "$code" ] && [ "$code" != "000" ]
}

# token_of BODY: the login token from Shiori's answer, without ever printing it.
token_of() {
  local t
  t="$(printf '%s\n' "$1" | grep -o '"access_token"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/^[^:]*:[[:space:]]*"//; s/"$//')"
  [ -n "$t" ] || t="$(printf '%s\n' "$1" | grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/^[^:]*:[[:space:]]*"//; s/"$//')"
  printf '%s' "$t"
}

# ── wait for Shiori (a first start prepares its database first) ─────────────────────
# Bounded twice: a $SECONDS budget well inside the manifest's 120 s, and max-time 5 in the
# probe's own config, so a single stuck request cannot outlive the wait.
up=""
wait_deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$wait_deadline" ]; do
  if alive; then up=1; break; fi
  sleep 2
done
[ -n "$up" ] || die "Shiori did not answer on its web port; nothing was changed." 4

# ── is the shipped default login still working? ────────────────────────────────────
# This is the real guard: Shiori's account PATCH does not check the old password, so the
# account is only touched while `shiori` / `gopher` still signs in. 200 = the default
# works, 400 = it does not (the operator changed it) — anything else is unreadable.
resp="$(http "$(cfg_login "$DEFAULT_PW")")"
code="$(code_of "$resp")"
case "$code" in
  200) ;;
  400) die "Shiori's default login no longer works, so this install already has its own admin password; left alone." 3 ;;
  *) die "Shiori did not answer on its login API; nothing was changed." 4 ;;
esac

token="$(token_of "$(body_of "$resp")")"
resp=""
case "$token" in
  "" | *[!A-Za-z0-9._~+/-]*) die "Shiori accepted the default login but handed back no usable token; nothing was changed." 4 ;;
esac

# ── set the new password ───────────────────────────────────────────────────────────
# The token and the password stay inside the curl config on stdin; the account is the
# shipped one (id 1).
patch_json="{\"old_password\":\"$(esc "$DEFAULT_PW")\",\"new_password\":\"$(esc "$PW")\"}"
resp="$(http "$(printf 'url = "%s/api/v1/accounts/1"\nmax-time = 10\nrequest = "PATCH"\nheader = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\ndata = "%s"\n' \
  "$BASE_URL" "$token" "$(esc "$patch_json")")")"
set_code="$(code_of "$resp")"
resp=""
token=""
confirmed=""
if [ "$set_code" = "200" ]; then
  confirmed=1
else
  # A PATCH that did not answer 200 may still have written the password: one login with the
  # real password decides, and only that decides.
  if [ "$(code_of "$(http "$(cfg_login "$PW")")")" = "200" ]; then confirmed=1; fi
fi
[ -n "$confirmed" ] || die "Shiori did not confirm the new password; the default login is unchanged." 1
say "Shiori confirmed the new password for the account '$ADMIN_USER'."

# ── prove the new login works, and the default does not ────────────────────────────
# Three tries, and never more than 40 s of them: each request is bounded by max-time in its
# config, this budget bounds the whole loop.
prove() {
  local answer
  answer="$(http "$(cfg_login "$PW")")"
  if [ "$(code_of "$answer")" != "200" ]; then printf '%s' "LOGIN-FAIL"; return 0; fi
  answer="$(http "$(cfg_login "$DEFAULT_PW")")"
  if [ "$(code_of "$answer")" = "200" ]; then printf '%s' "LOGIN-FAIL"; else printf '%s' "LOGIN-OK"; fi
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
  # Shiori confirmed the change, so the new password IS its password: Crow keeps it and says
  # it could not log in with it (exit 5).
  die "Shiori accepted the new password, but logging in with it did not succeed; open Shiori's own login page and set its admin password there." 5
fi

say "Shiori's admin login for '$ADMIN_USER' now uses the password Crow generated."