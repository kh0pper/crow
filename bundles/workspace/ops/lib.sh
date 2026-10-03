#!/usr/bin/env bash
# Shared helpers for the Workspace ops scripts (bootstrap, add-user, reset-password, ...).
# Source it; do not execute it:   . "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# Honors CROW_HOME / CROW_BUNDLE_DIR from the environment (the postInstall hook sets both);
# falls back to this file's location / ~/.crow only when they are unset.
# Secrets never go in argv: callers write them with the `printf` builtin into the stdin of
# `dc exec -T ... sh -c '...read...'` (see occ_with_pass).

BUNDLE_DIR="${CROW_BUNDLE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export CROW_HOME="${CROW_HOME:-$HOME/.crow}"
DC="${WORKSPACE_DC:-docker compose}"
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# env_get KEY: the value compose would see, decoded by ops/envfile.py (no eval, no sed):
# the installer quotes values with spaces, quotes, $ or # (bundle-env-codec.js), so a
# raw `sed s/^KEY=//` would return the QUOTED text. ENV_FILE defaults to the bundle .env.
env_get() {
  local f="${ENV_FILE:-$BUNDLE_DIR/.env}"
  [ -f "$f" ] || return 0
  command -v python3 >/dev/null 2>&1 || die "python3 is required to read the bundle .env (ops/envfile.py); install it and re-run"
  python3 "$OPS_DIR/envfile.py" get "$f" "$1"
}

log() { printf '[workspace] %s\n' "$*"; }
die() { printf '[workspace] ERROR: %s\n' "$*" >&2; exit 1; }

# docker compose in the bundle dir ($DC is intentionally word-split: "docker compose").
dc() { (cd "$BUNDLE_DIR" && $DC "$@"); }
occ() { dc exec -T -u www-data nextcloud php occ "$@"; }
# occ with ONE secret: the caller pipes it on stdin; occ only ever sees it as env NC_PASS.
occ_with_pass() { dc exec -T -u www-data nextcloud sh -c 'IFS= read -r NC_PASS; export NC_PASS; exec php occ "$@"' sh "$@"; }

# occ config:import from JSON on stdin. NC 34's `config:import /dev/stdin` cannot open /dev/stdin
# under `exec -T`, so the JSON lands in a private temp file INSIDE the container (never argv),
# removed even when the import fails.
occ_import_stdin() {
  dc exec -T -u www-data nextcloud sh -c 'umask 077; d=$(mktemp -d /dev/shm/ws.XXXXXX 2>/dev/null || mktemp -d) || exit 1; [ -n "$d" ] || exit 1; trap '"'"'rm -rf "$d"'"'"' EXIT; trap '"'"'exit 1'"'"' HUP INT TERM; cat > "$d/c.json"; php occ config:import "$d/c.json"'
}

# Diagnosability: any failing top-level command under `set -e` names the current step
# (call `step "..."` before each stage). set -E lets it fire inside functions (set -e exits
# from inside them); only the top shell prints, so a failure in dc's subshell is one line.
set -E
STEP="starting"
step() { STEP="$*"; }
trap '_rc=$?; [ "$BASH_SUBSHELL" = 0 ] && printf "[workspace] ERROR: %s failed (rc %s)\n" "$STEP" "$_rc" >&2' ERR

# random_pw N: N alphanumerics. Reads a fixed byte count first and transforms with
# parameter expansion, so there is no pipeline for SIGPIPE to abort under pipefail.
random_pw() {
  local raw
  raw="$(head -c 512 /dev/urandom | base64 -w0)"
  raw="${raw//[^A-Za-z0-9]/}"
  [ "${#raw}" -ge "$1" ] || die "could not gather randomness"
  printf '%s' "${raw:0:$1}"
}
