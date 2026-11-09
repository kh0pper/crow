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
# at all. The schema check below tells the two cases apart, and an existing schema is
# never re-installed.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin and is
# passed on only through pipes — never in an argument or the environment, and this script
# prints no secret. Exit 0 = the admin now has that password, 3 = someone already changed
# the default login (left alone), 4 = not running / not answering, anything else = failed.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-wallabag}"
ADMIN_USER="wallabag"

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; Wallabag was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; Wallabag was not touched."

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Wallabag container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Wallabag is not running; nothing was changed." 4

# Every console call runs as the app's own unprivileged user, in the app directory.
console() {
  docker exec -i "$CONTAINER" su -s /bin/sh nobody -c "cd /var/www/wallabag && php bin/console ${1:?a console command} --env=prod"
}

# The login check: it takes a candidate password on stdin, asks for the login page's
# CSRF token, posts the login and reads where it was redirected. Exit 0 = logged in,
# 1 = refused. The candidate is written to a file inside the container so it never sits
# in curl's argument list, and the temporary files are removed afterwards.
LOGIN_CHECK='
IFS= read -r P
F=$(mktemp /tmp/pw.XXXXXX); J=$(mktemp /tmp/cj.XXXXXX)
printf "%s" "$P" > "$F"
T=$(curl -s -c "$J" http://localhost/login | grep -o "name=\"_csrf_token\"[^>]*value=\"[^\"]*\"" | sed "s/.*value=\"//;s/\"//")
LOC=$(curl -s -b "$J" -c "$J" -o /dev/null -w "%{redirect_url}" --data-urlencode "_username=$1" --data-urlencode "_csrf_token=$T" --data-urlencode "_password@$F" http://localhost/login_check)
rm -f "$F" "$J"
case "$LOC" in */login) exit 1;; *) exit 0;; esac
'

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

# ── does the schema exist? install it only when it does not ─────────────────────────
if console 'doctrine:query:sql "SELECT COUNT(*) FROM wallabag_user"' < /dev/null >/dev/null 2>&1; then
  say "Wallabag's database already has its tables."
else
  say "Wallabag's database has no tables yet; installing it."
  console 'wallabag:install -n' < /dev/null >/dev/null 2>&1 || die "Wallabag's database could not be installed; nothing was changed."
fi

# ── is the shipped default login still working? ────────────────────────────────────
# If it no longer answers, the operator (or an earlier run) set a password of their own,
# and Crow must not overwrite a login it does not know. The install's default password is
# the account name itself; the snippet takes that on stdin and the account name as $1.
shipped_pw="$ADMIN_USER"
rc=0
printf '%s\n' "$shipped_pw" | docker exec -i "$CONTAINER" sh -c "$LOGIN_CHECK" sh "$ADMIN_USER" || rc=$?
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

# ── prove the new login works ───────────────────────────────────────────────────────
rc=0
printf '%s\n' "$PW" | docker exec -i "$CONTAINER" sh -c "$LOGIN_CHECK" sh "$ADMIN_USER" || rc=$?
[ "$rc" = "0" ] || die "Wallabag did not accept the new login; open Wallabag's own UI and set its admin password there."

say "Wallabag's admin login for '$ADMIN_USER' now uses the password Crow generated."