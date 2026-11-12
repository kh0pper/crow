#!/usr/bin/env bash
# Crow's API-token setup for this bundle (manifest firstAdmin.setup.token).
#
# Paperless-ngx has no environment variable for its API token: an account signs in and the
# app mints a token it shows once. The admin login Crow just made can do that from inside
# the container, so the token comes back to Crow without the operator ever opening a
# settings page.
#
# Protocol (docs/developers/bundles.md): stdin is unused, and the token — and nothing else —
# leaves this script as ONE line on file descriptor 3. stdout and stderr are the run's log
# text and never carry it. Exit 0 = fd 3 holds the admin's own token, 4 = not running / not
# answering / not this install's container, 5 = a token was read but Paperless-ngx refused
# it, anything else = failed. Nothing is written on any failure: fd 3 stays empty, so an exit
# code can never be mistaken for a token.
#
# How: the app runs as the `paperless` user under s6 and its Django project lives in
# /usr/src/paperless/src, so everything goes through `docker exec` + `s6-setuidgid` and
# Django's own shell — the same route first-admin.sh takes, and the same ownership checks.
# The username reaches the snippet on stdin, so no value is ever interpolated into code. The
# snippet is passed inside a single-quoted argument to the container's own shell, so it uses
# double quotes only. The token is proved against the app's own API before it is handed
# back: a key Crow could not show to work is never saved.
#
# Every external command runs with fd 3 closed (`3>&-`): no child may hold the pipe, and the
# single write at the end is the only one it ever gets. The token never reaches an argument,
# an environment variable or a log line.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-paperless}"
# The account Crow made (manifest firstAdmin.user), unless the runner names another one. An
# empty value is refused below rather than silently replaced: only an UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-admin}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; Paperless-ngx was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Paperless-ngx container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null 3>&- || true)"
[ "$running" = "true" ] || die "Paperless-ngx is not running; nothing was changed." 4

# ── is this install's container? ────────────────────────────────────────────────────
# Another Crow install's `crow-paperless` answers to the same name, and its admin's token
# would be somebody else's secret: compose's own working_dir label has to be this run's
# folder (the installed bundle dir Crow starts the script in). Tests skip the check ONLY by
# naming a container as well — a made-up name is proof enough that this is not an install.
here="$(pwd -P)"
skip_owner=""
if [ "${CROW_FA_SKIP_OWNER_CHECK:-}" = "1" ] && [ -n "${CROW_FA_CONTAINER:-}" ]; then
  skip_owner=1
fi
if [ -z "$skip_owner" ]; then
  working_dir="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$CONTAINER" 2>/dev/null 3>&- || true)"
  [ "$working_dir" = "$here" ] || die "The running Paperless-ngx container does not belong to this install; nothing was changed." 4
fi

# ── wait for the app (a first start migrates the database, then serves) ─────────────
up=""
for _ in $(seq 1 60 3>&-); do
  if docker exec "$CONTAINER" curl -fsS -o /dev/null http://localhost:8000 </dev/null >/dev/null 2>&1 3>&-; then
    up=1
    break
  fi
  sleep 2 3>&-
done
[ -n "$up" ] || die "Paperless-ngx did not answer on its web port; nothing was changed." 4

# ── the admin's token, minted (or read back) by Paperless itself ────────────────────
# `get_or_create` keeps the token Paperless already issued for this account, so a second run
# answers with the same key instead of quietly changing what the extension is set to use.
MANAGE='cd /usr/src/paperless/src && s6-setuidgid paperless python3 manage.py'
MINT='import sys
from django.contrib.auth import get_user_model
from rest_framework.authtoken.models import Token
username = sys.stdin.readline().rstrip("\n")
try:
    user = get_user_model().objects.get(username=username)
except get_user_model().DoesNotExist:
    print("NOUSER")
else:
    tok, _ = Token.objects.get_or_create(user=user)
    print("TOKEN=" + tok.key)'
minted="$(printf '%s\n' "$ADMIN_USER" 3>&- | docker exec -i "$CONTAINER" sh -c "$MANAGE shell -c '$MINT'" 2>/dev/null 3>&-)" || true

# A Django warning or a progress line may sit above the answer, so only the exact
# NOUSER / TOKEN= lines are read — anything else is "no usable answer" below. The answer
# runs through a pipe like everything else: a here-string would put the token in a
# temporary file, and it must never touch the disk.
no_user="$(printf '%s\n' "$minted" 3>&- | sed -n 's/^NOUSER$/1/p' 3>&-)"
[ -z "$no_user" ] || die "Paperless-ngx has no account named $ADMIN_USER; nothing was changed."

KEY="$(printf '%s\n' "$minted" 3>&- | sed -n 's/^TOKEN=\([0-9a-f]\{40\}\)$/\1/p' 3>&- | tail -n 1 3>&-)"
[ -n "$KEY" ] || die "Paperless-ngx did not report an API token for $ADMIN_USER; nothing was changed."

# ── prove it against the app's own API ──────────────────────────────────────────────
# The header goes in on stdin (`-H @-`), never in an argument, so the key is not in any
# process list. A 200 from /api/ is the app itself saying the token works.
if ! printf 'Authorization: Token %s\n' "$KEY" 3>&- | docker exec -i "$CONTAINER" curl -fsS -o /dev/null -H @- http://localhost:8000/api/ >/dev/null 2>&1 3>&-; then
  die "Paperless-ngx did not accept the token Crow read; nothing was saved." 5
fi

# ── hand it back: the one and only write to fd 3 ───────────────────────────────────
printf '%s\n' "$KEY" >&3
say "Crow read Paperless-ngx's API token for $ADMIN_USER."