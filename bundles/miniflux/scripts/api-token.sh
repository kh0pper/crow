#!/usr/bin/env bash
# Crow's API-token setup for this bundle (manifest firstAdmin.token — Miniflux's admin comes
# from the environment, so the token block is a sibling of firstAdmin.secretEnv).
#
# Miniflux has no environment variable for an API key: an account creates one under Settings →
# API Keys and copies it out. The admin login Crow generated (MINIFLUX_ADMIN_PASSWORD, kept in
# Crow's keychain) can do that through Miniflux's own REST API, so the key comes back to Crow
# without the operator opening a page.
#
# Protocol (docs/developers/bundles.md): the admin password arrives as ONE line on stdin and is
# passed on only through pipes — never in an argument or the environment, and this script
# prints no secret. The key — and nothing else — leaves this script as ONE line on file
# descriptor 3. Exit 0 = fd 3 holds the admin's key, 4 = not running / not answering / not this
# install's container / its port not published on this host, 5 = a key was read but Miniflux
# refused it, anything else = failed. Nothing is written on any failure: fd 3 stays empty, so an
# exit code can never be mistaken for a key.
#
# How: compose publishes the app's port on the host, so the Crow HOST's own `curl` talks to it at
# `http://127.0.0.1:<published port>` (or `[::1]` when Docker publishes on IPv6). Nothing runs
# inside the container for these calls — only the health wait does — so no credential can show up
# in a process list, on this host or in the container. The Basic-Auth header is built here
# (`user:password` piped into base64) and handed to curl on stdin (`-H @-`, one header per line),
# so it is never an argument. The one argument that carries text is the create's fixed JSON body
# `{"description":"Crow"}`, which holds no secret.
#
# Miniflux lists the account's keys WITH their tokens, so the "Crow" key is looked up first and
# reused; a second run therefore answers with the SAME key instead of creating another. Only
# when there is none is one created (description "Crow"). The key is proved against /v1/me
# before it is handed back: a key Crow could not show to work is never saved.
#
# The account name is the one compose created the admin with: CROW_FIRST_ADMIN_USER when Crow's
# manifest names it, else the installed bundle's own .env (MINIFLUX_ADMIN_USER), else "admin" —
# the same default the compose file uses.
#
# Every external command runs with fd 3 closed (`3>&-`): no child may hold the pipe, and the
# single write at the end is the only one it ever gets.
#
# A host without `curl`, or a container whose 8080 is not published on the host, cannot be asked:
# the first is a plain failure (exit 1), the second exits 4 — and neither writes fd 3.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-miniflux}"

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the admin password, from stdin only ────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No admin password arrived on stdin; Miniflux was not touched."

# ── the account the key belongs to ─────────────────────────────────────────────────
# Only the username is read from ./.env (the script runs in the installed bundle dir); a
# password in that file is never read, printed or used.
env_value() {
  [ -f ./.env ] || return 0
  local line
  line="$(grep -E "^[[:space:]]*$1=" ./.env 2>/dev/null 3>&- | tail -n 1 3>&- || true)"
  [ -n "$line" ] || return 0
  line="${line#*=}"
  case "$line" in
    \"*\") line="${line#\"}"; line="${line%\"}" ;;
    \'*\') line="${line#\'}"; line="${line%\'}" ;;
  esac
  line="${line%$'\r'}"
  printf '%s' "$line"
}
ADMIN_USER="${CROW_FIRST_ADMIN_USER:-}"
[ -n "$ADMIN_USER" ] || ADMIN_USER="$(env_value MINIFLUX_ADMIN_USER)"
[ -n "$ADMIN_USER" ] || ADMIN_USER="admin"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]] || die "The admin username is not a plain account name; Miniflux was not touched."

# ── docker, curl, and the container ─────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Miniflux container cannot be reached; nothing was changed." 4
# The API calls are made from this host, so this host's curl has to exist.
command -v curl >/dev/null 2>&1 || die "curl is not available here, so Miniflux's API cannot be reached; nothing was changed."
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null 3>&- || true)"
[ "$running" = "true" ] || die "Miniflux is not running; nothing was changed." 4

# ── is this install's container? ────────────────────────────────────────────────────
# Another Crow install's `crow-miniflux` answers to the same name, and its admin's key would
# be somebody else's secret: compose's own working_dir label has to be this run's folder (the
# installed bundle dir Crow starts the script in). Tests skip the check ONLY by naming a
# container as well — a made-up name is proof enough that this is not an install.
here="$(pwd -P)"
skip_owner=""
if [ "${CROW_FA_SKIP_OWNER_CHECK:-}" = "1" ] && [ -n "${CROW_FA_CONTAINER:-}" ]; then
  skip_owner=1
fi
if [ -z "$skip_owner" ]; then
  working_dir="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$CONTAINER" 2>/dev/null 3>&- || true)"
  [ "$working_dir" = "$here" ] || die "The running Miniflux container does not belong to this install; nothing was changed." 4
fi

# ── the port Docker published for the app's 8080 ────────────────────────────────
# `docker port` answers `<host address>:<port>` once per binding; the FIRST line is used. A
# loopback address is kept as it is and a wildcard one is narrowed to loopback, so the request
# never leaves this host. No port means the API cannot be reached at all: exit 4, nothing written.
published="$(docker port "$CONTAINER" 8080/tcp 2>/dev/null 3>&- || true)"
published="$(printf '%s\n' "$published" 3>&- | sed -n '1p' 3>&- || true)"
case "$published" in
  127.0.0.1:*) HOST_IP=127.0.0.1; PORT="${published#*:}" ;;
  0.0.0.0:*)   HOST_IP=127.0.0.1; PORT="${published#*:}" ;;
  '[::1]:'*)   HOST_IP='[::1]';   PORT="${published##*:}" ;;
  '[::]:'*)    HOST_IP='[::1]';   PORT="${published##*:}" ;;
  *) die "Miniflux's port is not published on this host, so its API cannot be reached; nothing was changed." 4 ;;
esac
[[ "$PORT" =~ ^[1-9][0-9]{0,4}$ ]] || die "Docker reported an unusable Miniflux port; nothing was changed." 4
BASE_URL="http://$HOST_IP:$PORT"

# ── wait for the app (a first start migrates the database, then serves) ─────────────
up=""
for _ in $(seq 1 60 3>&-); do
  if docker exec "$CONTAINER" wget -q -O /dev/null -T 5 http://127.0.0.1:8080/healthcheck </dev/null >/dev/null 2>&1 3>&-; then
    up=1
    break
  fi
  sleep 2 3>&-
done
[ -n "$up" ] || die "Miniflux did not answer on its health endpoint; nothing was changed." 4

# ── the admin's Basic-Auth header, built here and sent in on stdin ─────────────────
# `user:password` is piped straight into base64: the value exists only in this variable and on
# a pipe, never in an argument or an environment variable.
auth="$(printf '%s:%s' "$ADMIN_USER" "$PW" | base64 3>&- | tr -d '\n' 3>&-)"
[ -n "$auth" ] || die "Crow could not build the Miniflux login; nothing was changed."

# ── reuse the "Crow" key, or create one ────────────────────────────────────────────
# Every header goes in on stdin (`-H @-`, one per line), so no credential is ever an argument —
# not here, and not in any process in the container.
keys="$(printf 'Authorization: Basic %s\n' "$auth" 3>&- | curl -fsS --max-time 10 -H @- "$BASE_URL/v1/api-keys" 2>/dev/null 3>&-)" || true
# Miniflux answers with a JSON array of objects; only the object whose description is exactly
# "Crow" matters, and its token is read from that object's text (never from a command line).
crow_object="$(printf '%s\n' "$keys" 3>&- | tr '}' '\n' 3>&- | grep -F '"description":"Crow"' 3>&- || true)"
KEY="$(printf '%s\n' "$crow_object" 3>&- | sed -n 's/.*"token":"\([^"]\{20,256\}\)".*/\1/p' 3>&- | tail -n 1 3>&-)"

if [ -z "$KEY" ]; then
  # The body is a fixed literal — no secret — so it may travel as an argument.
  created="$(printf 'Authorization: Basic %s\nContent-Type: application/json\n' "$auth" 3>&- | curl -fsS --max-time 10 -H @- --data-raw '{"description":"Crow"}' "$BASE_URL/v1/api-keys" 2>/dev/null 3>&-)" || true
  KEY="$(printf '%s\n' "$created" 3>&- | sed -n 's/.*"token":"\([^"]\{20,256\}\)".*/\1/p' 3>&- | tail -n 1 3>&-)"
fi
[ -n "$KEY" ] || die "Miniflux did not report an API key for $ADMIN_USER; nothing was changed."

# ── prove it against the app's own API ────────────────────────────────────────────
# The key goes in as a header on stdin, so it is never an argument. A 200 from /v1/me is
# Miniflux itself saying the key works; a wrong key answers 401, which curl reports as a failure.
if ! printf 'X-Auth-Token: %s\n' "$KEY" 3>&- | curl -fsS --max-time 10 -o /dev/null -H @- "$BASE_URL/v1/me" >/dev/null 2>&1 3>&-; then
  die "Miniflux did not accept the API key Crow read; nothing was saved." 5
fi

# ── hand it back: the one and only write to fd 3 ───────────────────────────────────
printf '%s\n' "$KEY" >&3
say "Crow read Miniflux's API key for $ADMIN_USER."