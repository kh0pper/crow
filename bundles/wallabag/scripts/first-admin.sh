#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# Wallabag's default login is wallabag/wallabag, and its web UI has no first-run page
# that could take a password before somebody else on the machine logs in with it. This
# script replaces that password with the one Crow generated.
#
# It also finishes an install this compose file cannot finish itself: the image runs
# `wallabag:install` only when the wallabag service carries MYSQL_ROOT_PASSWORD, and this
# compose file sets that on the database service only — so a fresh install has no tables
# at all. The schema check below tells the two cases apart: the install runs ONLY when the
# database reports exactly zero tables. On a populated database `wallabag:install -n`
# rewrites the operator's settings and recreates a default super-admin, so a query Crow
# could not read is "did not answer" (exit 4), never "no schema".
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin and is
# passed on only through pipes — never in an argument or the environment, and this script
# prints no secret. Exit 0 = the admin now has that password, 3 = someone already changed
# the default login (left alone), 4 = not running / not answering / database did not
# answer, 5 = Wallabag took the new password but the login could not be proved,
# anything else = failed.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-wallabag}"
ADMIN_USER="wallabag"

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# The login check is a sibling of this script, in Crow's own copy of the bundle (the cwd
# is the INSTALLED bundle dir, so $0 — not `.` — is what locates it).
# Without a directory part there is no way to tell Crow's copy from the cwd: refuse.
case "${BASH_SOURCE[0]}" in
  */*) SCRIPT_DIR="${BASH_SOURCE[0]%/*}" ;;
  *) die "Run this script by its path (Crow does); nothing was changed." ;;
esac
LOGIN_CHECK_FILE="$SCRIPT_DIR/lib-login-check.sh"
[ -r "$LOGIN_CHECK_FILE" ] ||
  die "Crow's own login check is missing from the bundle; nothing was changed."

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; Wallabag was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; Wallabag was not touched."

# ── the account this extension's own connection uses, from ./.env ───────────────────
# The script runs in the installed bundle dir. When .env already names an account, the
# MCP server logs in with THAT one — replacing the shipped default would break the
# extension's connection, so this script leaves the whole install alone. Only the
# username is read here; a password in .env is never read, printed or used.
env_value() {
  [ -f ./.env ] || return 0
  local line
  line="$(grep -E "^[[:space:]]*$1=" ./.env 2>/dev/null | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  line="${line#*=}"
  case "$line" in
    \"*\") line="${line#\"}"; line="${line%\"}" ;;
    \'*\') line="${line#\'}"; line="${line%\'}" ;;
  esac
  line="${line%$'\r'}"
  printf '%s' "$line"
}
connection_user="$(env_value WALLABAG_USERNAME)"

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Wallabag container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Wallabag is not running; nothing was changed." 4

# Every console call runs as the app's own unprivileged user, in the app directory.
console() {
  docker exec -i "$CONTAINER" su -s /bin/sh nobody -c "cd /var/www/wallabag && php bin/console ${1:?a console command} --env=prod"
}

# The login check itself lives in lib-login-check.sh (it runs inside the container, and
# it is a file of its own so it can be exercised on its own).
login_check() {
  docker exec -i "$CONTAINER" sh -c "$(cat "$LOGIN_CHECK_FILE")" sh "$ADMIN_USER"
}

# ── wait for the app to answer (the database may still be starting) ─────────────────
up=""
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" curl -s -o /dev/null http://127.0.0.1:80/ < /dev/null >/dev/null 2>&1; then
    up=1
    break
  fi
  sleep 2
done
[ -n "$up" ] || die "Wallabag did not answer within two minutes; nothing was changed." 4

# ── is there a schema? ask the database, and install only on a definite "no tables" ──
tables="$(console 'doctrine:query:sql "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()"' < /dev/null 2>/dev/null)" ||
  die "Wallabag's database did not answer; nothing was changed." 4
# The answer is doctrine's table; the count is the one line that is only digits.
count="$(printf '%s\n' "$tables" | tr -d ' \r' | grep -E '^[0-9]+$' | tail -n 1 || true)"
[ -n "$count" ] || die "Wallabag's database did not answer; nothing was changed." 4
if [ "$count" = "0" ]; then
  say "Wallabag's database has no tables yet; installing it."
  console 'wallabag:install -n' < /dev/null >/dev/null 2>&1 || die "Wallabag's database could not be installed; nothing was changed."
else
  say "Wallabag's database already has its tables."
  # Only an install that already has accounts can have the connection pointed at one of
  # them; on a brand-new database the account Crow sets up becomes the connection's own.
  if [ -n "$connection_user" ] && [ "$connection_user" != "$ADMIN_USER" ]; then
    die "Wallabag's connection already uses its own account ($connection_user); Crow left it alone." 3
  fi
fi

# ── is the shipped default login still working? ────────────────────────────────────
# If it no longer answers, the operator (or an earlier run) set a password of their own,
# and Crow must not overwrite a login it does not know. The install's default password is
# the account name itself; the check takes that on stdin.
rc=0
printf '%s\n' "$ADMIN_USER" | login_check || rc=$?
case "$rc" in
  0) ;;
  1) die "Wallabag's default login no longer works, so this install already has its own admin password; left alone." 3 ;;
  *) die "Wallabag's login page could not be checked; nothing was changed." ;;
esac

# ── set the new password (on the prompt's stdin, never as an argument) ──────────────
answer=""
answer="$(printf '%s\n' "$PW" | console "fos:user:change-password $ADMIN_USER" 2>&1)" ||
  die "Wallabag refused the new password; the default login is unchanged."
printf '%s' "$answer" | grep -q "Changed password" ||
  die "Wallabag did not confirm the new password; check Wallabag itself."

# ── prove the new login works (three tries, a few seconds apart) ────────────────────
# Wallabag's own caches and session handling can lag a moment behind the console change.
attempt=1
while :; do
  rc=0
  printf '%s\n' "$PW" | login_check || rc=$?
  if [ "$rc" = "0" ]; then break; fi
  if [ "$attempt" -ge 3 ]; then break; fi
  attempt=$((attempt + 1))
  sleep 3
done
if [ "$rc" != "0" ]; then
  # The console already confirmed the change, so the new password IS the app's password:
  # Crow keeps it and says it could not prove it (exit 5).
  die "Wallabag accepted the new password, but logging in with it did not succeed; open Wallabag's own UI and set its admin password there." 5
fi

say "Wallabag's admin login for '$ADMIN_USER' now uses the password Crow generated."