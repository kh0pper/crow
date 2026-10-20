#!/bin/bash
# Fetch the Calls extension's two browser scripts from this Crow's gateway, so
# entrypoint.sh can layer the call enhancements on the companion frontend.
#
# This replaces the old read-only mount of EVERY installed extension's folder
# (~/.crow/bundles → /crow-bundles), which also exposed the other extensions'
# .env secrets to this container. The gateway serves these files at
# /calls/scripts/ only while the Calls extension is enabled (CROW_CALLS_ENABLED=1).
#
# Usage: fetch-calls-scripts.sh <out-dir>
#   Writes <out-dir>/scripts/crow-calls-webrtc.js and crow-calls-panel.js.
#   Exit 0: both fetched. Exit 1: Calls is off (HTTP error, e.g. 404), the answer
#   is not JavaScript (an HTML error page, or something else on that port), or the
#   gateway did not answer within CROW_CALLS_WAIT_SECONDS (default 60; it is
#   retried only while the connection is refused or times out, e.g. at boot).
#   The gateway serves its own copy (bundles/calls/scripts) when the Calls
#   extension is enabled but not installed, so "enabled" is what counts.
set -u

OUT="${1:?usage: fetch-calls-scripts.sh <out-dir>}"
BASE="${CROW_CALLS_SCRIPTS_URL:-http://localhost:${CROW_MCP_BRIDGE_PORT:-3001}/calls/scripts}"
WAIT="${CROW_CALLS_WAIT_SECONDS:-60}"
FILES="crow-calls-webrtc.js crow-calls-panel.js"

mkdir -p "$OUT/scripts"
deadline=$(( $(date +%s) + WAIT ))

for f in $FILES; do
  while :; do
    ctype=$(curl -fsS --max-time 5 -o "$OUT/scripts/$f.part" -w '%{content_type}' "$BASE/$f" 2>/dev/null)
    rc=$?
    if [ "$rc" -eq 0 ]; then
      case "$ctype" in
        application/javascript*|text/javascript*) break ;;
        *) rm -rf "$OUT/scripts"; exit 1 ;;
      esac
    fi
    rm -f "$OUT/scripts/$f.part"
    # 7 = could not connect, 28 = timed out, 52 = empty reply, 56 = reset: the gateway
    # may still be starting. Anything else (22 = HTTP >= 400) means Calls is off.
    case "$rc" in
      7|28|52|56) ;;
      *) rm -rf "$OUT/scripts"; exit 1 ;;
    esac
    if [ "$(date +%s)" -ge "$deadline" ]; then
      rm -rf "$OUT/scripts"
      exit 1
    fi
    sleep 2
  done
  if [ ! -s "$OUT/scripts/$f.part" ]; then
    rm -rf "$OUT/scripts"
    exit 1
  fi
  mv "$OUT/scripts/$f.part" "$OUT/scripts/$f"
done
exit 0
