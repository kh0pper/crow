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

log() { printf '[workspace] %s\n' "$*"; }
die() { printf '[workspace] ERROR: %s\n' "$*" >&2; exit 1; }

# docker compose in the bundle dir ($DC is intentionally word-split: "docker compose").
dc() { (cd "$BUNDLE_DIR" && $DC "$@"); }
occ() { dc exec -T -u www-data nextcloud php occ "$@"; }
# occ with ONE secret: the caller pipes it on stdin; occ only ever sees it as env NC_PASS.
occ_with_pass() { dc exec -T -u www-data nextcloud sh -c 'IFS= read -r NC_PASS; export NC_PASS; exec php occ "$@"' sh "$@"; }

# random_pw N: N alphanumerics. Reads a fixed byte count first and transforms with
# parameter expansion, so there is no pipeline for SIGPIPE to abort under pipefail.
random_pw() {
  local raw
  raw="$(head -c 512 /dev/urandom | base64 -w0)"
  raw="${raw//[^A-Za-z0-9]/}"
  [ "${#raw}" -ge "$1" ] || die "could not gather randomness"
  printf '%s' "${raw:0:$1}"
}
