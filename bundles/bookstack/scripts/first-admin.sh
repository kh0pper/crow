#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# BookStack ships the login `admin@admin.com` / `password`, printed in its own docs, and
# its web UI answers on a loopback port — anything on the machine can sign in to a fresh
# install as its admin. This script replaces that password with the one Crow generated.
#
# Two facts shape it. First, the shipped default has to be checked BEFORE anything else:
# BookStack's `bookstack:create-admin --initial` keys on the email alone and would
# overwrite the password of an operator who already made the account their own. Second,
# the change itself is that command with no --password: it prompts and reads the new
# password from stdin, and it must run as the image's own user (uid 1000).
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin and is
# passed on only through a pipe — never in an argument or the environment, and this script
# prints no secret. Exit 0 = the admin now has exactly that password, 3 = this install
# already has its own admin (left alone), 4 = not running / not answering / the login form
# could not be read, 5 = BookStack took the new password but logging in with it did not
# succeed, anything else = failed.
#
# The admin account here is an EMAIL address (BookStack signs in by email), so
# CROW_FIRST_ADMIN_USER must look like one.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-bookstack}"
# The linuxserver image serves the app on port 80 inside its own container.
BASE_URL="http://localhost:80"
# BookStack's shipped account, and the name its admin is created with.
DEFAULT_EMAIL="admin@admin.com"
DEFAULT_PW="password"
ADMIN_NAME="Admin"
# An empty value is refused below rather than silently replaced, because an empty one
# means the declaration is broken — only an UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-admin@localhost.localdomain}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._@-]+$ ]] || { printf '%s\n' "The admin account is not a plain account name; BookStack was not touched." >&2; exit 1; }
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$ ]] || { printf '%s\n' "BookStack signs in by email, and the admin account is not one; BookStack was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; BookStack was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; BookStack was not touched."

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the BookStack container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "BookStack is not running; nothing was changed." 4

# ── wait for the app (a first start migrates the database first) ────────────────────
# Bounded twice: a $SECONDS budget well inside the manifest's 240 s, and --max-time 5 on the
# probe itself, so a single stuck curl cannot outlive the wait.
up=""
wait_deadline=$((SECONDS + 120))
while [ "$SECONDS" -lt "$wait_deadline" ]; do
  if docker exec "$CONTAINER" curl -fsS --max-time 5 -o /dev/null "$BASE_URL/login" </dev/null >/dev/null 2>&1; then
    up=1
    break
  fi
  sleep 2
done
[ -n "$up" ] || die "BookStack did not answer on its login page; nothing was changed." 4

# ── one form login, its config on stdin ────────────────────────────────────────────
# Everything secret (the CSRF token, the email when it is the operator's, the password)
# travels inside the curl config on stdin. The cookie jar is a throwaway file in the
# container: it is a file name, not a secret.
JAR="/tmp/crow-fa-cookies.txt"

# Escaping for a curl config value (curl reads its config from stdin with `-K -`): a
# double-quoted value there understands exactly two escapes, `\\` and `\"`. A value written
# through this function can hold anything, which is why a password never has to be an
# argument and never has to stay inside a safe character set.
esc() { local s="${1//\\/\\\\}"; printf '%s' "${s//\"/\\\"}"; }

# token_of PAGE: the CSRF token from BookStack's own login form, without printing it.
token_of() {
  printf '%s\n' "$1" | tr '>' '\n' \
    | sed -n -e 's/.*name="_token"[^>]*value="\([^"]*\)".*/\1/p' -e 's/.*value="\([^"]*\)"[^>]*name="_token".*/\1/p' \
    | head -n 1 | tr -d '[:space:]'
}

# login_with EMAIL PASSWORD: "<status> <redirect URL>", or UNAVAILABLE when the form or the
# app could not be read at all.
login_with() {
  local page token answer
  page="$(printf 'url = "%s/login"\ncookie-jar = "%s"\ncookie = "%s"\nmax-time = 10\n' "$BASE_URL" "$JAR" "$JAR" \
    | docker exec -i "$CONTAINER" curl -sS -K - -w '\n%{http_code}' 2>/dev/null || true)"
  [ "$(printf '%s' "${page##*$'\n'}")" = "200" ] || { printf '%s' "UNAVAILABLE"; return 0; }
  token="$(token_of "${page%$'\n'*}")"
  case "$token" in
    "" | *[!A-Za-z0-9+/=_.-]*) printf '%s' "UNAVAILABLE"; return 0 ;;
  esac
  answer="$(printf 'url = "%s/login"\ncookie-jar = "%s"\ncookie = "%s"\nmax-time = 10\nrequest = "POST"\ndata-urlencode = "_token=%s"\ndata-urlencode = "email=%s"\ndata-urlencode = "password=%s"\n' \
    "$BASE_URL" "$JAR" "$JAR" "$token" "$1" "$(esc "$2")" \
    | docker exec -i "$CONTAINER" curl -sS -K - -o /dev/null -w '%{http_code} %{redirect_url}' 2>/dev/null || true)"
  printf '%s' "${answer:-UNAVAILABLE}"
}

# redirect_path URL: the URL without its scheme or query, so the app's own APP_URL host
# does not have to be guessed — only whether the redirect ends at the form or at the app.
redirect_path() {
  local u="$1"
  case "$u" in
    *://*) u="${u#*://}" ;;
  esac
  printf '%s' "${u%%\?*}"
}

# login_word EMAIL PASSWORD: DEFAULT (the shipped login works), REFUSED (it does not),
# SIGNED-IN (this login works and lands on the app), or UNAVAILABLE (nothing readable).
login_word() {
  local answer code path
  answer="$(login_with "$1" "$2")"
  if [ "$answer" = "UNAVAILABLE" ]; then printf '%s' "UNAVAILABLE"; return 0; fi
  code="${answer%% *}"
  path="$(redirect_path "${answer#* }")"
  case "$code" in
    302 | 303)
      case "$path" in
        */login) printf '%s' "REFUSED" ;;
        */) printf '%s' "SIGNED-IN" ;;
        *) printf '%s' "UNAVAILABLE" ;;
      esac
      ;;
    *) printf '%s' "UNAVAILABLE" ;;
  esac
}

# ── is the shipped default login still working? ────────────────────────────────────
case "$(login_word "$DEFAULT_EMAIL" "$DEFAULT_PW")" in
  SIGNED-IN) ;;
  REFUSED) die "BookStack's default login no longer works, so this install already has its own admin; left alone." 3 ;;
  *) die "BookStack's login form could not be read; nothing was changed." 4 ;;
esac

# ── set the new password (BookStack's own admin command, the password on its stdin) ─
# No --password: the command prompts and reads stdin, so the value never becomes an
# argument. It runs as uid 1000 (the image's own user) in the app directory.
rc=0
printf '%s\n' "$PW" \
  | docker exec -i -u 1000 -w /app/www "$CONTAINER" php artisan bookstack:create-admin --initial \
      --email="$ADMIN_USER" --name="$ADMIN_NAME" >/dev/null 2>&1 || rc=$?
case "$rc" in
  0) ;;
  2) die "BookStack already has a non-default admin account; left alone." 3 ;;
  *) die "BookStack's admin command did not accept the new password; the default login is unchanged." 1 ;;
esac
say "BookStack confirmed the new password for the account '$ADMIN_USER'."

# ── prove the new login works ─────────────────────────────────────────────────────
# Three tries, and never more than 60 s of them: each login is bounded by max-time in its
# config, this budget bounds the whole loop.
attempt=1
proof=""
proof_deadline=$((SECONDS + 60))
while :; do
  proof="$(login_word "$ADMIN_USER" "$PW")"
  if [ "$proof" = "SIGNED-IN" ]; then break; fi
  if [ "$attempt" -ge 3 ]; then break; fi
  if [ "$SECONDS" -ge "$proof_deadline" ]; then break; fi
  attempt=$((attempt + 1))
  sleep 3
done
if [ "$proof" != "SIGNED-IN" ]; then
  # BookStack itself confirmed the change (its own command exited 0), so the new password IS
  # the account's password: Crow keeps it and says it could not log in with it (exit 5).
  die "BookStack accepted the new password, but logging in with it did not succeed; open BookStack's own login page and set its admin password there." 5
fi

say "BookStack's admin login for '$ADMIN_USER' now uses the password Crow generated."