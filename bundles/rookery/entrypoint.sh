#!/bin/sh
# Generate openscience.json from env, start OpenScience (loopback-only inside
# the container, by its own hardcoded listener), front it with the header shim
# bound to 0.0.0.0:3061 so Docker port mapping works. Self-hosted only: the
# generated config contains exactly one OpenAI-compatible provider; no Atlas.
set -eu

: "${MODEL_BASE_URL:?MODEL_BASE_URL is required (OpenAI-compatible endpoint)}"
MODEL_ID="${MODEL_ID:-local-model}"

# First-boot resilience: the Docker engine creates missing bind-mount sources
# as root:root, so $HOME (/data) can arrive unwritable by uid 1000 on a fresh
# one-click install. Nothing HAS to persist — the config is regenerated from
# env every boot — so fall back to an ephemeral HOME instead of crash-looping.
if [ ! -w "$HOME" ]; then
  echo "WARN: $HOME not writable (root-owned bind mount) — using ephemeral HOME=/tmp/openscience-home; chown the host data dir to uid 1000 for persistent sessions" >&2
  HOME=/tmp/openscience-home
  export HOME
fi
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/openscience"
mkdir -p "$CONFIG_DIR"
mkdir -p /workspaces 2>/dev/null || true  # read path; content arrives via the mount

cat > "$CONFIG_DIR/openscience.json" <<EOF
{
  "model": "crow-local/${MODEL_ID}",
  "provider": {
    "crow-local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Crow Local",
      "options": { "baseURL": "${MODEL_BASE_URL}", "apiKey": "${MODEL_API_KEY:-local}" },
      "models": { "${MODEL_ID}": { "name": "${MODEL_ID}" } }
    }
  }
}
EOF

cd /workspaces
# Build the argv list so EACH space-separated origin gets its own --cors flag
# (${VAR:+--cors ${VAR}} would word-split into one --cors + stray positionals).
set -- --port 4096
for o in ${ROOKERY_CORS_ORIGINS:-}; do set -- "$@" --cors "$o"; done

# Defense-in-depth: drop credential-shaped vars before OpenScience (and any
# MCP child it spawns) can inherit them. The generated config already holds
# everything the app needs. The allowlist wrapper (/app/wrapper-exec.sh) is
# the primary mechanism for MCP children; this scrub is belt-and-suspenders.
. /app/scrub-env.sh
openscience "$@" &
SHIM_LISTEN_HOST=0.0.0.0 exec node /app/host-shim.mjs 3061 4096
