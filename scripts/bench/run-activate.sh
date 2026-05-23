#!/usr/bin/env bash
# Activate crow-swap-highend: restart crow-gateway (reload models.json),
# then one verification swap-in (stop crow-chat -> start 122B -> test ->
# restore crow-chat). Trap-protected: crow-chat ALWAYS restored.
set -uo pipefail
CHAT=/home/kh0pp/crow/bundles/llamacpp-vulkan-qwen36-35b-a3b
HEND=/home/kh0pp/crow/bundles/llamacpp-rocm-qwen35-122b-mtp
RES=/home/kh0pp/crow/scripts/bench/results
ST=/home/kh0pp/crow/scripts/bench/.activate.status
LOG=$RES/activate-$(date -u +%Y%m%dT%H%M%SZ).log
mkdir -p "$RES"; echo RUNNING > "$ST"
say(){ echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }

restore_chat(){
  say "RESTORE crow-chat (:8003 35B)"
  ( cd "$HEND" && docker compose down ) >>"$LOG" 2>&1 || true
  if ! docker ps --format '{{.Names}}' | grep -q '^llamacpp-vulkan-qwen36-35b-a3b$'; then
    ( cd "$CHAT" && docker compose up -d ) >>"$LOG" 2>&1 || true
  fi
  for i in $(seq 1 60); do
    curl -sf http://100.118.41.122:8003/health >/dev/null 2>&1 && { say "crow-chat healthy"; return; }
    sleep 5
  done
  say "WARN crow-chat NOT healthy after 5min — investigate"
}
trap 'restore_chat; [ "$(cat "$ST")" = RUNNING ] && echo INTERRUPTED > "$ST"' EXIT

# safety: abort if a pipeline is mid-run (do not disrupt)
RUN=$(sqlite3 /home/kh0pp/.crow-mpa/data/crow.db "select count(*) from pipeline_runs where status in ('running','in_progress');" 2>/dev/null || echo 0)
if [ "${RUN:-0}" != "0" ]; then say "ABORT: $RUN pipeline(s) in-flight"; echo BUSY > "$ST"; exit 0; fi

say "=== restart crow-gateway (reload models.json) ==="
sudo systemctl restart crow-gateway.service >>"$LOG" 2>&1 || systemctl --user restart crow-gateway.service >>"$LOG" 2>&1 || true
sleep 8
systemctl is-active crow-gateway.service | tee -a "$LOG"
curl -sf http://localhost:3002/health >/dev/null 2>&1 && say "crow-gateway :3002 healthy" || say "crow-gateway health endpoint not confirmed (continuing)"

say "=== verification swap-in: stop crow-chat ==="
( cd "$CHAT" && docker compose stop ) >>"$LOG" 2>&1 || true
sleep 3
say "=== start crow-swap-highend (122B) on :8003 ==="
( cd "$HEND" && docker compose up -d ) >>"$LOG" 2>&1 || true
t0=$(date +%s)
READY=0
for i in $(seq 1 180); do
  if curl -sf http://100.118.41.122:8003/health >/dev/null 2>&1; then
    r=$(curl -s -m 60 http://100.118.41.122:8003/v1/chat/completions -H 'content-type: application/json' \
        -d '{"model":"qwen3.5-122b-a10b","messages":[{"role":"user","content":"hi"}],"max_tokens":4,"temperature":0}' 2>/dev/null)
    echo "$r" | grep -q '"content"' && { READY=1; say "122B READY after $(( $(date +%s)-t0 ))s"; break; }
  fi
  docker ps --format '{{.Names}}' | grep -q '^llamacpp-rocm-qwen35-122b-mtp$' || { say "122B container died"; docker logs llamacpp-rocm-qwen35-122b-mtp 2>&1 | tail -20 | tee -a "$LOG"; break; }
  sleep 5
done

if [ "$READY" = 1 ]; then
  say "/v1/models:"; curl -s http://100.118.41.122:8003/v1/models | python3 -c "import sys,json;print([m['id'] for m in json.load(sys.stdin).get('data',[])])" 2>&1 | tee -a "$LOG"
  say "gen + MTP draft test:"
  curl -s -m 180 http://100.118.41.122:8003/v1/chat/completions -H 'content-type: application/json' \
    -d '{"model":"qwen3.5-122b-a10b","messages":[{"role":"user","content":"Explain in 80 words why speculative decoding is lossless."}],"max_tokens":160,"temperature":0}' \
    | python3 -c "import sys,json;d=json.load(sys.stdin);t=d.get('timings',{});print('gen tok/s=',round(t.get('predicted_per_second',0),2),'draft_n=',t.get('draft_n'),'draft_acc=',t.get('draft_n_accepted'))" 2>&1 | tee -a "$LOG"
  say "tool-call test:"
  curl -s -m 120 http://100.118.41.122:8003/v1/chat/completions -H 'content-type: application/json' \
    -d '{"model":"qwen3.5-122b-a10b","temperature":0,"max_tokens":256,"chat_template_kwargs":{"enable_thinking":false},"messages":[{"role":"user","content":"Weather in Austin? Use the tool."}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"tool_choice":"auto"}' \
    | python3 -c "import sys,json;d=json.load(sys.stdin);m=d.get('choices',[{}])[0].get('message',{});tc=m.get('tool_calls');print('tool_calls:',bool(tc), (tc[0]['function'] if tc else (m.get('content') or '')[:120]))" 2>&1 | tee -a "$LOG"
  say "MTP accept (container log):"; docker logs llamacpp-rocm-qwen35-122b-mtp 2>&1 | grep -iE 'draft acceptance|statistics draft' | tail -3 | tee -a "$LOG"
  echo VERIFIED > "$ST"
else
  say "VERIFICATION FAILED — 122B did not become ready"
  echo VERIFY-FAIL > "$ST"
fi

say "=== teardown 122B + restore crow-chat ==="
restore_chat
# real crow-chat completion sanity
sleep 2
curl -s -m 60 http://100.118.41.122:8003/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"qwen3.6-35b-a3b","messages":[{"role":"user","content":"Reply exactly: CHAT-OK"}],"max_tokens":24,"temperature":0,"chat_template_kwargs":{"enable_thinking":false}}' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('crow-chat reply=',repr(d['choices'][0]['message'].get('content')),'finish=',d['choices'][0].get('finish_reason'))" 2>&1 | tee -a "$LOG"
[ "$(cat "$ST")" = RUNNING ] && echo DONE > "$ST"
[ "$(cat "$ST")" = VERIFIED ] && echo DONE > "$ST"
say "ACTIVATION COMPLETE status=$(cat "$ST") log=$LOG"
