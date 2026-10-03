#!/usr/bin/env bash
# W2 spike S9: ONLYOFFICE live-plugin probe. Kevin runs this on crow over SSH (interactive; needs sudo for
# `tailscale serve`). Read ~/CROW-SCHEDULE.md first. Nothing here degrades prod:
#   - the probe plugin is docker-cp'd into the RUNNING onlyoffice container only (not persistent) and removed again;
#   - a temporary Serve path https://<host>:8457/crow-live/probe -> 127.0.0.1:3399 is added and removed again;
#   - a scratch folder "Shared with Crow/<first folder>/W2 probe <ts>" holds probe.{docx,xlsx,pptx} and is trashed.
# Cleanup ALWAYS runs: a bash trap (exit, Ctrl-C, TERM, HUP) plus a detached root watchdog that cleans up when this
# script dies or after a hard wall-clock cap (CAP_SECONDS, default 45 min), whichever comes first.
#
# Usage: scripts/workspace-w2-plugin-probe/run-probe.sh
# No secret ever goes into argv: listener.mjs reads ~/.crow/bundles/workspace/.env itself.
set -uo pipefail

GUID='{0C0FFEE0-5EED-4C8B-9B57-000000000001}'
CTR=crow-workspace-onlyoffice-1
PLUGIN_DIR="/var/www/onlyoffice/documentserver/sdkjs-plugins/$GUID"
SERVE_PORT=8457
SERVE_PATH=/crow-live/probe
LISTEN=http://127.0.0.1:3399
TS_HOST=${TS_HOST:-crow.dachshund-chromatic.ts.net}
CAP_SECONDS=${CAP_SECONDS:-2700}

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$KIT/../.." && pwd)"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33mWARN: %s\033[0m\n' "$*" >&2; }

# ---------------------------------------------------------------- cleanup (idempotent; runs as Kevin or as root)
# State lives in $STATE (mktemp -d, chmod 755, no secrets): owner, node/tailscale paths, scratch dir, listener pid, markers.
cleanup() {
  local STATE="$1" AS_ROOT="${2:-no}"
  [ -d "$STATE" ] || return 0
  [ -e "$STATE/cleaned" ] && return 0
  if ! mkdir "$STATE/cleaning.lock" 2>/dev/null; then return 0; fi # the other cleaner is already at it
  local OWNER NODE TSBIN DIR LPID KPID STAGE SUDO=sudo
  OWNER=$(cat "$STATE/owner"); NODE=$(cat "$STATE/node"); TSBIN=$(cat "$STATE/tailscale")
  DIR=$(cat "$STATE/dir" 2>/dev/null || true); LPID=$(cat "$STATE/listener.pid" 2>/dev/null || true)
  KPID=$(cat "$STATE/keepalive.pid" 2>/dev/null || true); STAGE=$(cat "$STATE/stage" 2>/dev/null || true)
  [ "$AS_ROOT" = yes ] && SUDO=""
  echo "[cleanup $(date +%T)] start (as $(id -un))"

  # 1. the probe plugin out of the container, then flush the editor cache
  docker exec "$CTR" rm -rf "$PLUGIN_DIR" && echo "[cleanup] plugin dir removed" || warn "could not remove $PLUGIN_DIR in $CTR"
  docker exec "$CTR" documentserver-flush-cache.sh >/dev/null && echo "[cleanup] editor cache flushed" || warn "flush-cache failed"

  # 2. the temporary Serve path
  if [ -e "$STATE/serve_added" ]; then
    if [ -n "$SUDO" ]; then sudo -n true 2>/dev/null || echo "[cleanup] sudo needed to remove the Serve path:"; fi
    $SUDO "$TSBIN" serve --https="$SERVE_PORT" --set-path="$SERVE_PATH" off && echo "[cleanup] Serve path $SERVE_PATH off" \
      || warn "could not remove Serve path; run: sudo tailscale serve --https=$SERVE_PORT --set-path=$SERVE_PATH off"
  fi

  # 3. the listener (only if that pid is still OUR listener)
  if [ -n "$LPID" ] && grep -qa "listener.mjs" "/proc/$LPID/cmdline" 2>/dev/null; then
    kill -TERM "$LPID" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$LPID" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$LPID" 2>/dev/null && kill -KILL "$LPID" 2>/dev/null
    echo "[cleanup] listener stopped"
  fi
  # the sudo keep-alive loop is a subshell of run-probe.sh (same cmdline)
  if [ -n "$KPID" ] && grep -qa "run-probe.sh" "/proc/$KPID/cmdline" 2>/dev/null; then kill "$KPID" 2>/dev/null; fi

  # 4. the scratch folder (as Kevin's user: the listener reads his .env)
  if [ -n "$DIR" ]; then
    if [ "$AS_ROOT" = yes ]; then sudo -u "$OWNER" -H "$NODE" "$KIT/listener.mjs" --cleanup "$DIR"
    else "$NODE" "$KIT/listener.mjs" --cleanup "$DIR"; fi || warn "scratch folder '$DIR' may remain (delete it in the Files UI)"
  fi
  [ -n "$STAGE" ] && rm -rf "$STAGE"

  # 5. verify
  docker exec "$CTR" test ! -e "$PLUGIN_DIR" && echo "[cleanup] verified: plugin dir gone" || warn "plugin dir still present"
  curl -s "http://127.0.0.1:3071/plugins.json" | grep -q "0C0FFEE0" && warn "plugins.json still lists the probe" || echo "[cleanup] verified: plugins.json does not list the probe"
  touch "$STATE/cleaned"
  echo "[cleanup $(date +%T)] done"
}

# ---------------------------------------------------------------- detached watchdog (root, out of process)
if [ "${1:-}" = "--watchdog" ]; then
  STATE="$2"
  exec >>/tmp/w2-probe-watchdog.log 2>&1
  CAP_SECONDS=$(cat "$STATE/cap") # sudo resets the environment: the cap comes from the state dir
  START=$(cat "$STATE/start"); MAIN=$(cat "$STATE/main.pid"); DEADLINE=$((START + CAP_SECONDS))
  echo "[watchdog $(date +%T)] armed: main pid $MAIN, deadline in ${CAP_SECONDS}s"
  reason=""
  while :; do
    [ -e "$STATE/cleaned" ] && { rm -rf "$STATE"; exit 0; }
    if ! kill -0 "$MAIN" 2>/dev/null; then sleep 5; [ -e "$STATE/cleaned" ] && { rm -rf "$STATE"; exit 0; }; reason="run-probe.sh exited without cleaning up"; break; fi
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then reason="hard cap ${CAP_SECONDS}s reached"; break; fi
    sleep 5
  done
  echo "[watchdog $(date +%T)] $reason"
  if kill -0 "$MAIN" 2>/dev/null; then
    kill -TERM "$MAIN" 2>/dev/null # its trap cleans up with Kevin's sudo; give it 30 s
    for _ in $(seq 1 30); do [ -e "$STATE/cleaned" ] && { rm -rf "$STATE"; exit 0; }; sleep 1; done
  fi
  rmdir "$STATE/cleaning.lock" 2>/dev/null # a cleaner that died half-way must not block the backstop
  cleanup "$STATE" yes
  rm -rf "$STATE"
  exit 0
fi

# ---------------------------------------------------------------- main
remaining() { local r=$(( $(cat "$STATE/start") + CAP_SECONDS - $(date +%s) )); [ "$r" -lt 1 ] && r=1; echo "$r"; }
ask() { # ask "<question>" -> answer in $A; at the hard cap the script exits (and the trap cleans up)
  A=""
  if ! read -r -t "$(remaining)" -p "$1 " A; then echo; warn "hard cap reached while waiting"; exit 3; fi
}
mark() { curl -s -o /dev/null -X POST -H 'Content-Type: application/json' --data "$(printf '{"kind":"mark","label":%s}' "$("$NODE" -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1")")" "$LISTEN/" || warn "mark failed: $1"; }
answer() { mark "kevin: $1 = $2"; }

NODE=$(command -v node) || { echo "node not found" >&2; exit 1; }
TSBIN=$(command -v tailscale) || { echo "tailscale not found" >&2; exit 1; }
for f in config.json index.html probe.js icon.png listener.mjs; do [ -f "$KIT/$f" ] || { echo "missing $KIT/$f" >&2; exit 1; }; done
for e in docx xlsx pptx; do [ -f "$REPO/tests/fixtures/workspace/rich.$e" ] || { echo "missing rich.$e (run make-fixtures.py)" >&2; exit 1; }; done
docker inspect -f '{{.State.Running}}' "$CTR" 2>/dev/null | grep -q true || { echo "$CTR is not running" >&2; exit 1; }
if (exec 3<>/dev/tcp/127.0.0.1/3399) 2>/dev/null; then echo "port 3399 is busy; stop whatever holds it first" >&2; exit 1; fi
if docker exec "$CTR" test -e "$PLUGIN_DIR"; then warn "a probe plugin dir is already in the container (an earlier run?); it will be replaced and removed"; fi

say "W2 S9 plugin probe — hard cap $((CAP_SECONDS / 60)) min. Have you read ~/CROW-SCHEDULE.md (no conflicting window)?"
read -r -p "Type yes to continue: " A; [ "$A" = yes ] || { echo "aborted"; exit 1; }

say "sudo (for tailscale serve and the cleanup watchdog)"
sudo -v || { echo "sudo failed" >&2; exit 1; }

STATE=$(mktemp -d /tmp/w2-probe.XXXXXX)
chmod 755 "$STATE" # the root watchdog reads it; it holds no secrets
id -un >"$STATE/owner"; echo "$NODE" >"$STATE/node"; echo "$TSBIN" >"$STATE/tailscale"
date +%s >"$STATE/start"; echo $$ >"$STATE/main.pid"; echo "$CAP_SECONDS" >"$STATE/cap"
OUT="$HOME/w2-plugin-probe-facts-$(date +%Y%m%d-%H%M%S).json"

trap 'cleanup "$STATE" no' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# keep sudo's ticket fresh for the trap's `tailscale serve ... off`
( while sleep 60; do sudo -n -v 2>/dev/null || exit 0; done ) &
echo $! >"$STATE/keepalive.pid"

sudo -b setsid "$KIT/run-probe.sh" --watchdog "$STATE" >/dev/null 2>&1 </dev/null \
  || { echo "could not start the cleanup watchdog; aborting before any change" >&2; exit 1; }
echo "watchdog started (cleans up if this script dies, or at the ${CAP_SECONDS}s cap)"

say "1/5 scratch folder"
PARENT=$("$NODE" "$KIT/listener.mjs" --parent) || exit 1
DIR="$PARENT/W2 probe $(date +%s)"
echo "$DIR" >"$STATE/dir"
"$NODE" "$KIT/listener.mjs" --setup "$DIR" || exit 1

say "2/5 listener on $LISTEN (facts -> $OUT)"
"$NODE" "$KIT/listener.mjs" --serve "$DIR" --out "$OUT" &
echo $! >"$STATE/listener.pid"
for _ in $(seq 1 20); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data '{"kind":"noop"}' "$LISTEN/")" = 204 ] && break
  sleep 0.5
done || true
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data '{"kind":"noop"}' "$LISTEN/")" = 204 ] || { echo "listener did not come up" >&2; exit 1; }

say "3/5 Serve path https://$TS_HOST:$SERVE_PORT$SERVE_PATH -> $LISTEN"
touch "$STATE/serve_added" # set first: cleanup then always tries to turn it off
sudo "$TSBIN" serve --bg --https="$SERVE_PORT" --set-path="$SERVE_PATH" "$LISTEN" || exit 1
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data '{"kind":"noop"}' "https://$TS_HOST:$SERVE_PORT$SERVE_PATH")
echo "tailnet check: POST https://$TS_HOST:$SERVE_PORT$SERVE_PATH -> $code (want 204)"
[ "$code" = 204 ] || { echo "the Serve path does not reach the listener; stopping" >&2; exit 1; }

say "4/5 probe plugin into $CTR (running container only)"
STAGE=$(mktemp -d /tmp/w2-probe-plugin.XXXXXX); echo "$STAGE" >"$STATE/stage"
cp "$KIT/config.json" "$KIT/index.html" "$KIT/probe.js" "$KIT/icon.png" "$STAGE/"
chmod 755 "$STAGE"; chmod 644 "$STAGE"/*
docker exec "$CTR" rm -rf "$PLUGIN_DIR"
docker cp "$STAGE" "$CTR:$PLUGIN_DIR" || exit 1
docker exec "$CTR" documentserver-flush-cache.sh >/dev/null || exit 1
pj=$(curl -s "http://127.0.0.1:3071/sdkjs-plugins/%7B0C0FFEE0-5EED-4C8B-9B57-000000000001%7D/config.json" -o /dev/null -w '%{http_code}')
echo "plugin config.json served: HTTP $pj"
if curl -s http://127.0.0.1:3071/plugins.json | grep -q 0C0FFEE0; then echo "plugins.json lists the probe"
else
  warn "plugins.json does NOT list the probe. The document server may build its plugin list only at start;"
  warn "restarting the editor container would cut open sessions, so this script stops here. Tell Claude: S9 needs a restart decision."
  answer "plugins_json_lists_probe" "no"
  exit 4
fi

say "5/5 checks — laptop first (edit), then phone (view). Answer y/n; anything else is recorded verbatim."
echo "Files (crow-bot path): $DIR/probe.docx, probe.xlsx, probe.pptx  (in your Files they sit under the shared folder '${PARENT#Shared with Crow/}')"
echo "Watch this terminal: the listener logs 'init', 'presence' and an 'API present:' line per editor."

ask "[LAPTOP] Open probe.docx in Workspace (ONLYOFFICE). Wait until the listener logs 'presence word'. Press Enter."
ask "Did a 'Crow probe…' indicator appear (about 6 s)? y/n:"; answer "laptop_docx_crow_probe_indicator_visible" "$A"
ask "Is there a new last paragraph 'CROW-PROBE'? y/n:"; answer "laptop_docx_CROW-PROBE_paragraph_visible" "$A"
ask "Close the probe.docx tab now, wait ~20 s for the save, then press Enter."
saved=$("$NODE" "$KIT/listener.mjs" --check-saved "$DIR"); echo "$saved"; answer "server_check" "$saved"

ask "[LAPTOP] Open probe.xlsx. Wait until the listener logs 'presence cell' and 'tick' lines. Press Enter."
ask "Did 'Crow probe…' appear? y/n:"; answer "laptop_xlsx_crow_probe_indicator_visible" "$A"
ask "Now DOUBLE-CLICK any cell (e.g. B10) so the cursor blinks inside it, and keep it there. Then press Enter."
mark "cell_edit_start"
ask "Stay in the cell for at least 45 s (3 ticks). Then press Enter (still in the cell)."
mark "cell_edit_end"
ask "Press Esc. Does cell Z99 show 'CROW-PROBE <n>'? y/n:"; answer "z99_shows_ticks" "$A"
ask "Close the probe.xlsx tab. Press Enter."

ask "[LAPTOP] Open probe.pptx. Wait until the listener logs 'presence slide'. Close the tab. Press Enter."

ask "Make sure NO tab has probe.docx open anywhere. Wait 20 s, then press Enter."
mark "baseline_no_editor_open"

ask "[PHONE] Open probe.docx (view mode). Wait until the listener logs 'init word view=true'. Keep it OPEN and press Enter."
mark "phone_viewing"
ask "Did anything from the probe show on the phone? y/n:"; answer "phone_crow_probe_indicator_visible" "$A"
ask "Close the phone tab. Press Enter."

say "done — cleaning up"
exit 0
