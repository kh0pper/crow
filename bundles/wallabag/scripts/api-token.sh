#!/usr/bin/env bash
# Crow's API-token (OAuth client) setup for this bundle (manifest firstAdmin.setup.token).
#
# Wallabag's API needs an OAuth2 client: an account creates one under Developer → Create a
# new client and copies its id and secret into the extension. Wallabag has no environment
# variable for either, and its own `fos:oauth-server:create-client` console command is broken
# in this image (the Client it builds has no user), so Crow creates the client itself: the
# admin login Crow just made is the client's owner, and the client id and secret come back to
# Crow without the operator opening a page.
#
# Protocol (docs/developers/bundles.md): the admin password arrives as ONE line on stdin and
# is passed on only through pipes — never in an argument or the environment, and this script
# prints no secret. TWO values leave this script, because this extension needs two: fd 3
# carries exactly one `NAME=value` line per declared env var, every declared name exactly
# once and nothing else.
#
#   WALLABAG_CLIENT_ID=<public id>
#   WALLABAG_CLIENT_SECRET=<secret>
#
# Exit 0 = fd 3 holds both, 4 = not running / not answering / not this install's container,
# 5 = the client was created but Wallabag refused to issue a token with it, anything else =
# failed. Nothing is written on any failure: fd 3 stays empty, so an exit code can never be
# mistaken for a value.
#
# How: the app runs as `nobody` in this image, so everything goes through `docker exec` +
# `su -s /bin/sh nobody`, exactly like scripts/first-admin.sh. scripts/api-client.php is Crow's
# own small program (a file in Crow's copy of the bundle, never in the installed one): it
# boots the app's kernel, finds the account on stdin, and reuses (or creates) that account's
# "Crow" client — one per account, so a second run answers with the SAME id and secret. The
# program is piped into the container on stdin (`php --` reads it from there: `docker cp` is
# not something Crow does), and the account name reaches it as its one argument.
#
# Wallabag's public client id is `<numeric id>_<random>` (the underscore is part of it, and the
# numeric part can be missing on older rows) and its secret is a lowercase base36 string; the
# admin password Crow generates is base64url, so all three are safe inside a form body without
# escaping.
# The values never reach a host argument or an environment variable: they travel in the
# script's own variables and on pipes. Each docker call runs with fd 3 closed (`3>&-`), and
# the single write at the end is the only thing fd 3 ever gets.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-wallabag}"
# The account Crow's first-admin script set up (manifest firstAdmin.user), unless the runner
# names another one. An empty value is refused below rather than silently replaced: only an
# UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-wallabag}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; Wallabag was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# The PHP program Crow runs inside the container. It is a sibling of this script, in Crow's
# own copy of the bundle (the cwd is the INSTALLED bundle dir, so $0 — not `.` — locates it).
case "${BASH_SOURCE[0]}" in
  */*) SCRIPT_DIR="${BASH_SOURCE[0]%/*}" ;;
  *) die "Run this script by its path (Crow does); nothing was changed." ;;
esac
CLIENT_PHP_FILE="$SCRIPT_DIR/api-client.php"
[ -r "$CLIENT_PHP_FILE" ] ||
  die "Crow's own OAuth-client program is missing from the bundle; nothing was changed."

# ── the admin password, from stdin only ────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No admin password arrived on stdin; Wallabag was not touched."

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Wallabag container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null 3>&- || true)"
[ "$running" = "true" ] || die "Wallabag is not running; nothing was changed." 4

# ── is this install's container? ────────────────────────────────────────────────────
# Another Crow install's `crow-wallabag` answers to the same name, and a client made in it
# would belong to somebody else's app: compose's own working_dir label has to be this run's
# folder (the installed bundle dir Crow starts the script in). Tests skip the check ONLY by
# naming a container as well.
here="$(pwd -P)"
skip_owner=""
if [ "${CROW_FA_SKIP_OWNER_CHECK:-}" = "1" ] && [ -n "${CROW_FA_CONTAINER:-}" ]; then
  skip_owner=1
fi
if [ -z "$skip_owner" ]; then
  working_dir="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$CONTAINER" 2>/dev/null 3>&- || true)"
  [ "$working_dir" = "$here" ] || die "The running Wallabag container does not belong to this install; nothing was changed." 4
fi

# ── wait for the app (the database may still be starting) ───────────────────────────
up=""
for _ in $(seq 1 60 3>&-); do
  if docker exec "$CONTAINER" curl -s -o /dev/null http://127.0.0.1:80/ </dev/null >/dev/null 2>&1 3>&-; then
    up=1
    break
  fi
  sleep 2 3>&-
done
[ -n "$up" ] || die "Wallabag did not answer within two minutes; nothing was changed." 4

# ── the client: boot the app's kernel, reuse (or create) this account's "Crow" client ──
# The program comes in on stdin; the account name is its one argument.
client_out="$(docker exec -i "$CONTAINER" su -s /bin/sh nobody -c "cd /var/www/wallabag && php -- $ADMIN_USER" < "$CLIENT_PHP_FILE" 2>/dev/null 3>&-)" || true

no_user="$(printf '%s\n' "$client_out" 3>&- | sed -n 's/^NOUSER$/1/p' 3>&-)"
[ -z "$no_user" ] || die "Wallabag has no account named $ADMIN_USER; nothing was changed."

# One CLIENT= line, "<public id>:<secret>". Anything else is "no usable answer" below.
# The public id may carry an underscore (`1_dgqk33xx…`, the shape Wallabag really mints) and
# both halves have to be non-empty, so each class is matched `\{1,\}` rather than `*`.
ID="$(printf '%s\n' "$client_out" 3>&- | sed -n 's/^CLIENT=\([A-Za-z0-9_]\{1,\}\):.*$/\1/p' 3>&- | tail -n 1 3>&-)"
SECRET="$(printf '%s\n' "$client_out" 3>&- | sed -n 's/^CLIENT=[A-Za-z0-9_]\{1,\}:\([A-Za-z0-9]\{1,\}\)$/\1/p' 3>&- | tail -n 1 3>&-)"
[ -n "$ID" ] && [ -n "$SECRET" ] || die "Wallabag did not report an OAuth client for $ADMIN_USER; nothing was changed."

# ── prove it against the app's own token endpoint ──────────────────────────────────
# The form body (client id, secret, account, password) goes in on stdin (`--data @-`), never
# in an argument. A 200 with an access token is Wallabag saying the client works; a wrong
# secret answers 400, which curl reports as a failure.
if ! printf 'grant_type=password&client_id=%s&client_secret=%s&username=%s&password=%s' "$ID" "$SECRET" "$ADMIN_USER" "$PW" 3>&- |
  docker exec -i "$CONTAINER" curl -fsS -o /dev/null --data @- http://127.0.0.1:80/oauth/v2/token >/dev/null 2>&1 3>&-; then
  die "Wallabag did not accept the OAuth client Crow created; nothing was saved." 5
fi

# ── hand them back: the one and only write to fd 3 ─────────────────────────────────
printf 'WALLABAG_CLIENT_ID=%s\nWALLABAG_CLIENT_SECRET=%s\n' "$ID" "$SECRET" >&3
say "Crow created Wallabag's OAuth client for $ADMIN_USER."