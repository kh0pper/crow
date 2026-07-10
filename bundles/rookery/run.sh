#!/bin/bash
set -a
# Optional secret-override hook: NOTHING creates this file — a user may
# hand-provision it to override env without touching the gateway .env.
[ -f "$HOME/.crow/env/rookery.env" ] && source "$HOME/.crow/env/rookery.env"
set +a
cd "$(dirname "$0")"
exec "$HOME/.local/bin/uv" run --quiet rookery-mcp
