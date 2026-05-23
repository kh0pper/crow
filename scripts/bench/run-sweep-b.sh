#!/usr/bin/env bash
# Phase-1 RESUME (after the -fit hang): missing pieces only — 122B quality + 35B speed + 35B quality.
# Hardened: -fit off everywhere (via updated harness/quality-eval), per-step `timeout` watchdogs,
# stray-container cleanup. DISRUPTIVE: stops 35B chat + embedders, restores on exit.
set -uo pipefail
H=/home/kh0pp/crow/scripts/bench/mtp-explore.sh
Q=/home/kh0pp/crow/scripts/bench/quality-eval.sh
RES=/home/kh0pp/crow/scripts/bench/results
STAGE=/home/kh0pp/llm/hf-cache/_stage
SUM="$RES/SWEEP-B-SUMMARY-$(date -u +%Y%m%dT%H%M%SZ).md"
GPU_CONTAINERS="llamacpp-vulkan-qwen36-35b-a3b llamacpp-vulkan-qwen3-embed sfrag-vulkan-qwen3-8b sfrag-embed"
export READY_TRIES=180   # 15 min readiness ceiling (-fit off → no auto-fit hang)
LT=1000   # launch timeout (s)
QT=1800   # quality-step timeout (s)
ST=2400   # staging-copy timeout (s)
say(){ echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$SUM"; }

cleanup_strays(){ # kill any kyuz0 container that isn't a production GPU container
  for c in $(docker ps --format '{{.Names}} {{.Image}}' | awk '/kyuz0/{print $1}'); do
    case " $GPU_CONTAINERS " in *" $c "*) : ;; *) docker rm -f "$c" >/dev/null 2>&1 || true ;; esac
  done
}
restore(){
  say "RESTORE: cleanup strays + docker start GPU containers"
  bash "$H" stop >/dev/null 2>&1 || true
  cleanup_strays
  rm -rf "$STAGE" 2>/dev/null || true
  docker start $GPU_CONTAINERS >/dev/null 2>&1 || true
  for i in $(seq 1 60); do curl -sf http://100.118.41.122:8003/health >/dev/null 2>&1 && { say "crow-chat :8003 healthy"; break; }; sleep 5; done
}
trap restore EXIT
mkdir -p "$STAGE"

M122_Q5=/models/qwen35-122b-a10b-mtp/Qwen3.5-122B-A10B-UD-Q5_K_M-00001-of-00003.gguf
M35_Q6=/models/qwen36-35b-a3b-mtp/Qwen3.6-35B-A3B-UD-Q6_K.gguf
MM35=/models/qwen36-35b-a3b-mtp/mmproj-F16.gguf
EXT122Q4=/mnt/external/llm-models/qwen35-122b-a10b-mtp/UD-Q4_K_XL
EXT35Q5=/mnt/external/llm-models/qwen36-35b-a3b-mtp/Qwen3.6-35B-A3B-UD-Q5_K_M.gguf
EXT35BF=/mnt/external/llm-models/qwen36-35b-a3b-mtp/BF16

run_cfg(){ # $1=desc $2=model $3=alias [flags...]
  local desc="$1" model="$2" alias="$3"; shift 3
  say ">>> $desc"
  if timeout "$LT" bash "$H" launch "$model" "$alias" "$@" >>"$SUM" 2>&1; then
    bash "$H" measure "$alias" "$alias" code greedy 2>&1 | grep -E '^runs=' | sed "s/^/    code  /" | tee -a "$SUM"
    bash "$H" logs 2>&1 | grep -i acceptance | tail -1 | sed 's/^/    /' >>"$SUM" 2>&1 || true
  else say "    !! LAUNCH FAILED/TIMEOUT"; cleanup_strays; fi
}
prose_too(){ bash "$H" measure "$1" "$1-prose" prose greedy 2>&1 | grep -E '^runs=' | sed "s/^/    prose /" | tee -a "$SUM"; }
qrun(){ CHUNKS="${QCHUNKS:-48}" CTX="${QCTX:-512}" timeout "$QT" bash "$Q" "$@" 2>&1; local rc=$?; [ $rc -eq 124 ] && { say "    !! QUALITY TIMED OUT: $*"; cleanup_strays; }; }

say "=== SWEEP-B START (resume; -fit off; per-step timeouts) ==="
docker stop $GPU_CONTAINERS >/dev/null 2>&1 || true; sleep 3
free -g | awk 'NR==2{print "[mem] free="$4" avail="$7" GB"}' | tee -a "$SUM"

############ 122B quality (speed already collected) ############
say "## 122B quality (PPL-delta; eval=Gutenberg prose)"
qrun ppl "$M122_Q5" 122b-q5 | grep -iE 'Final|PPL|saved' | sed 's/^/    /' | tee -a "$SUM"
say "staging 122B Q4_K_XL -> NVMe"; mkdir -p "$STAGE/q122q4"; timeout "$ST" cp "$EXT122Q4"/*.gguf "$STAGE/q122q4/" && say "staged Q4 ($(du -sh "$STAGE/q122q4"|cut -f1))"
S122Q4=/models/_stage/q122q4/$(basename "$EXT122Q4"/*-00001-of-00003.gguf)
qrun ppl "$S122Q4" 122b-q4 | grep -iE 'Final|PPL|saved' | sed 's/^/    /' | tee -a "$SUM"
rm -rf "$STAGE/q122q4"

############ 35B speed (MTP+vision) ############
say "## 35B speed (Qwen3.6-35B-A3B MTP+vision)"
BACKEND=rocm   NP=1 MMPROJ=$MM35 run_cfg "35B Q6 ROCm  MTP-n2 +vis"   "$M35_Q6" q36-q6-mtp2 --spec-type draft-mtp --spec-draft-n-max 2; prose_too q36-q6-mtp2
BACKEND=rocm   NP=1 MMPROJ=$MM35 run_cfg "35B Q6 ROCm  MTP-n2 KV-q8"  "$M35_Q6" q36-q6-mtp2kv8 --spec-type draft-mtp --spec-draft-n-max 2 --cache-type-k q8_0 --cache-type-v q8_0
BACKEND=vulkan NP=1 MMPROJ=$MM35 run_cfg "35B Q6 Vulkan MTP-n2 +vis"  "$M35_Q6" q36-q6-vk-mtp2 --spec-type draft-mtp --spec-draft-n-max 2
BACKEND=rocm   NP=4 MMPROJ=$MM35 run_cfg "35B Q6 ROCm  non-MTP parallel4 (prod ref)" "$M35_Q6" q36-q6-p4
say "staging 35B Q5_K_M -> NVMe"; mkdir -p "$STAGE/q36q5"; timeout "$ST" cp "$EXT35Q5" "$STAGE/q36q5/" && say "staged Q5"
S35Q5=/models/_stage/q36q5/$(basename "$EXT35Q5")
BACKEND=rocm   NP=1 MMPROJ=$MM35 run_cfg "35B Q5 ROCm  MTP-n2 +vis"   "$S35Q5" q36-q5-mtp2 --spec-type draft-mtp --spec-draft-n-max 2; prose_too q36-q5-mtp2
BACKEND=vulkan NP=1 MMPROJ=$MM35 run_cfg "35B Q5 Vulkan MTP-n2 +vis"  "$S35Q5" q36-q5-vk-mtp2 --spec-type draft-mtp --spec-draft-n-max 2
bash "$H" stop >/dev/null 2>&1 || true

############ 35B quality (KLD vs BF16 + PPL) ############
say "## 35B quality (KLD vs BF16 + PPL)"
say "staging 35B BF16 -> NVMe"; mkdir -p "$STAGE/q36bf16"; timeout "$ST" cp "$EXT35BF"/*.gguf "$STAGE/q36bf16/" && say "staged BF16 ($(du -sh "$STAGE/q36bf16"|cut -f1))"
S35BF=/models/_stage/q36bf16/$(basename "$EXT35BF"/*-00001-of-00002.gguf)
qrun kld-base "$S35BF" 35b-bf16 | tail -2 | sed 's/^/    /' | tee -a "$SUM"
qrun kld "$M35_Q6" 35b-bf16 35b-q6 | grep -iE 'Mean|Median|Maximum|RMS|PPL|same top|saved' | sed 's/^/    /' | tee -a "$SUM"
qrun kld "$S35Q5" 35b-bf16 35b-q5 | grep -iE 'Mean|Median|Maximum|RMS|PPL|same top|saved' | sed 's/^/    /' | tee -a "$SUM"
rm -rf "$STAGE/q36q5" "$STAGE/q36bf16"

say "=== SWEEP-B DONE — summary: $SUM ==="
