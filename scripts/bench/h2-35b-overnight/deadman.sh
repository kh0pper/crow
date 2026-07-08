#!/usr/bin/env bash
# H.2/H.3 35b-window deadman: hard wall-clock cap, out-of-process backstop.
# MUST be launched as its own transient systemd unit (run.sh does
# `systemd-run --user --unit=h2-deadman ...`) — a setsid/nohup child dies
# with the runner service's cgroup, which is exactly how the 2026-07-08
# run lost its backstop. After CAP seconds: prod healthy -> no-op; else
# force-restore BOTH prod containers from their own addon compose dirs
# (compose up recreates removed containers; `docker start` cannot).
CAP="${1:-14400}"
IP=100.118.41.122
KIT=/home/kh0pp/crow/scripts/bench/h2-35b-overnight
D35=/home/kh0pp/crow-addons/llamacpp-vulkan-qwen36-35b-a3b
DCOP=/home/kh0pp/crow-addons/llamacpp-vulkan-qwen36-27b-copilot
LOG="$KIT/deadman.log"
sleep "$CAP"
ok() { curl -s -m 5 "http://$IP:$1/health" | grep -q '"ok"'; }
if ok 8003 && ok 8010; then
  echo "$(date -Is) deadman expired — prod healthy, no action" >> "$LOG"
  exit 0
fi
echo "$(date -Is) deadman FIRED — restoring prod" >> "$LOG"
(cd "$D35" && /usr/bin/docker compose down) >> "$LOG" 2>&1
SNAP="$KIT/compose-prod-snapshot.yml"
[ -f "$SNAP" ] || SNAP="$KIT/compose-f16-mtp2.yml"
cp "$SNAP" "$D35/docker-compose.yml"
(cd "$D35" && /usr/bin/docker compose up -d) >> "$LOG" 2>&1
(cd "$DCOP" && /usr/bin/docker compose up -d) >> "$LOG" 2>&1
for i in $(seq 1 90); do ok 8003 && ok 8010 && break; sleep 5; done
STATE="8003=$(ok 8003 && echo ok || echo DOWN) 8010=$(ok 8010 && echo ok || echo DOWN)"
echo "$(date -Is) deadman restore done: $STATE" >> "$LOG"
# ntfy creds read at runtime from pi settings — NEVER hardcode (repo is public)
NCFG=$(python3 -c "import json;n=json.load(open('/home/kh0pp/.pi/agent/settings.json')).get('notify',{});print(n.get('token',''),n.get('url',''),n.get('topic',''))" 2>/dev/null) || NCFG=""
read -r NTOKEN NURL NTOPIC <<< "$NCFG"
[ -n "$NTOKEN" ] && curl -s -m 10 -H "Authorization: Bearer $NTOKEN" \
  -H "Title: H.2 35b overnight DEADMAN FIRED" \
  -d "Forced prod restore: $STATE" \
  "$NURL/$NTOPIC" >/dev/null 2>&1 || true
