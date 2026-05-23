#!/usr/bin/env bash
# Wait for verified shard3, then benchmark Qwen3.5-122B-A10B only.
# Trap-protected: :8003 always restored. gpt-oss & GLM already done.
set -uo pipefail
H=/home/kh0pp/crow/scripts/bench/mtp-explore.sh
MT=/home/kh0pp/llm/hf-cache/mtp-test
CMT=/models/mtp-test
BUNDLE=/home/kh0pp/crow/bundles/llamacpp-vulkan-qwen36-35b-a3b
RES=/home/kh0pp/crow/scripts/bench/results
ST=/home/kh0pp/crow/scripts/bench/.qwen122.status
LOG=$RES/qwen122-$(date -u +%Y%m%dT%H%M%SZ).log
mkdir -p "$RES"; echo WAITING > "$ST"
say(){ echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }

# 1) wait for clean shard3
for w in $(seq 1 240); do
  s=$(cat "$MT/.dl-s3v2.status" 2>/dev/null || echo "")
  echo "$s" | grep -q S3OK && { say "shard3 verified: $s"; break; }
  echo "$s" | grep -q S3BAD && { say "shard3 FAILED: $s"; echo S3BAD > "$ST"; exit 1; }
  sleep 30
done

# 2) defensive integrity: all 3 shards exact size + GGUF magic
declare -A EXP=( [1]=10943808 [2]=49752870880 [3]=43875204864 )
for i in 1 2 3; do
  f="$MT/Qwen3.5-122B-A10B-UD-Q5_K_M-0000${i}-of-00003.gguf"
  sz=$(stat -c %s "$f" 2>/dev/null || echo 0); mg=$(head -c4 "$f" 2>/dev/null || echo "")
  if [ "$sz" != "${EXP[$i]}" ] || [ "$mg" != "GGUF" ]; then
    say "INTEGRITY FAIL shard$i sz=$sz exp=${EXP[$i]} magic=$mg"; echo INTEGRITY-FAIL > "$ST"; exit 1
  fi
  say "shard$i OK sz=$sz magic=$mg"
done

echo RUNNING > "$ST"
restore(){
  say "RESTORE :8003"
  bash "$H" stop >>"$LOG" 2>&1 || true
  docker ps --format '{{.Names}}' | grep -q '^llamacpp-vulkan-qwen36-35b-a3b$' || ( cd "$BUNDLE" && docker compose up -d ) >>"$LOG" 2>&1 || true
  for i in $(seq 1 60); do curl -sf http://100.118.41.122:8003/health >/dev/null 2>&1 && { say "RESTORE: :8003 healthy"; return; }; sleep 5; done
  say "RESTORE: :8003 NOT healthy after 5min (investigate)"
}
trap 'restore; [ "$(cat "$ST")" = RUNNING ] && echo INTERRUPTED > "$ST"' EXIT

say "=== stopping :8003 ==="
( cd "$BUNDLE" && docker compose stop ) >>"$LOG" 2>&1 || true
sleep 3
Q=$CMT/Qwen3.5-122B-A10B-UD-Q5_K_M-00001-of-00003.gguf
m(){ say "measure $*"; bash "$H" measure "$@" 2>&1 | grep -E 'runs=|gen_tok' | tee -a "$LOG"; }

if bash "$H" launch "$Q" q122 >>"$LOG" 2>&1; then
  say "Qwen122 OFF READY"; m q122 q122-off code greedy; m q122 q122-off prose greedy
else say "Qwen122 OFF FAILED"; docker logs mtp-test-8013 2>&1 | tail -15 | tee -a "$LOG"; fi

if bash "$H" launch "$Q" q122 --spec-type draft-mtp --spec-draft-n-max 3 >>"$LOG" 2>&1; then
  say "Qwen122 MTP-n3 READY"
  m q122 q122-mtp3 code greedy; m q122 q122-mtp3 prose greedy
  m q122 q122-mtp3 code scode;  m q122 q122-mtp3 code sgen
  say "toolcall:"; bash "$H" toolcall q122 2>&1 | tee -a "$LOG"
  say "mtp-accept:"; bash "$H" logs 2>&1 | tee -a "$LOG"
else say "Qwen122 MTP-n3 FAILED"; docker logs mtp-test-8013 2>&1 | tail -15 | tee -a "$LOG"; fi

bash "$H" stop >>"$LOG" 2>&1 || true
say "=== Qwen122 bench complete ==="
restore
echo DONE > "$ST"
say "RESULTS: $LOG"
