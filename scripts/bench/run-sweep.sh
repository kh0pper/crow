#!/usr/bin/env bash
# Phase-1 full sweep (§1.1 speed + §1.2 quality). DISRUPTIVE: stops the 35B chat + embedders,
# restores them on exit (trap). Stages external (NTFS) models to NVMe before testing.
# Run in background; watch the SUMMARY md. Builds: ROCm 9189, Vulkan(radv-mtp) 9172.
set -uo pipefail
H=/home/kh0pp/crow/scripts/bench/mtp-explore.sh
Q=/home/kh0pp/crow/scripts/bench/quality-eval.sh
RES=/home/kh0pp/crow/scripts/bench/results
STAGE=/home/kh0pp/llm/hf-cache/_stage
SUM="$RES/SWEEP-SUMMARY-$(date -u +%Y%m%dT%H%M%SZ).md"
GPU_CONTAINERS="llamacpp-vulkan-qwen36-35b-a3b llamacpp-vulkan-qwen3-embed sfrag-vulkan-qwen3-8b sfrag-embed"
export READY_TRIES=300   # 25 min readiness ceiling for big cold loads
say(){ echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$SUM"; }

restore(){
  say "RESTORE: stop test container + docker start GPU containers"
  bash "$H" stop >/dev/null 2>&1 || true
  rm -rf "$STAGE" 2>/dev/null || true
  docker start $GPU_CONTAINERS >/dev/null 2>&1 || true
  for i in $(seq 1 60); do curl -sf http://100.118.41.122:8003/health >/dev/null 2>&1 && { say "crow-chat :8003 healthy"; break; }; sleep 5; done
}
trap restore EXIT
mkdir -p "$STAGE"

# ---- in-container model paths ----
M122_Q5=/models/qwen35-122b-a10b-mtp/Qwen3.5-122B-A10B-UD-Q5_K_M-00001-of-00003.gguf
M35_Q6=/models/qwen36-35b-a3b-mtp/Qwen3.6-35B-A3B-UD-Q6_K.gguf
MM35=/models/qwen36-35b-a3b-mtp/mmproj-F16.gguf
# host (external) sources to stage:
EXT122Q4=/mnt/external/llm-models/qwen35-122b-a10b-mtp/UD-Q4_K_XL
EXT35Q5=/mnt/external/llm-models/qwen36-35b-a3b-mtp/Qwen3.6-35B-A3B-UD-Q5_K_M.gguf
EXT35BF=/mnt/external/llm-models/qwen36-35b-a3b-mtp/BF16

# code-greedy measure (+ optional prose) and acceptance line
run_cfg(){ # $1=desc $2=model $3=alias [extra launch flags...]
  local desc="$1" model="$2" alias="$3"; shift 3
  say ">>> $desc"
  if bash "$H" launch "$model" "$alias" "$@" >>"$SUM" 2>&1; then
    bash "$H" measure "$alias" "$alias" code greedy 2>&1 | grep -E '^runs=' | sed "s/^/    code  /" | tee -a "$SUM"
    bash "$H" logs 2>&1 | grep -i acceptance | tail -1 | sed 's/^/    /' >>"$SUM" 2>&1 || true
  else say "    !! LAUNCH FAILED"; fi
}
prose_too(){ bash "$H" measure "$1" "$1-prose" prose greedy 2>&1 | grep -E '^runs=' | sed "s/^/    prose /" | tee -a "$SUM"; }

say "=== SWEEP START (eval corpus: Gutenberg prose; relative quant metric) ==="
say "stopping GPU containers: $GPU_CONTAINERS"
docker stop $GPU_CONTAINERS >/dev/null 2>&1 || true; sleep 3
free -g | awk 'NR==2{print "[mem] free="$4" avail="$7" GB"}' | tee -a "$SUM"

############ 122B (Qwen3.5-122B-A10B) ############
say "## 122B  (current quant Q5_K_M on NVMe)"
BACKEND=rocm   NP=1 run_cfg "122B Q5 ROCm  MTP-off"        "$M122_Q5" q122-q5-off
BACKEND=rocm   NP=1 run_cfg "122B Q5 ROCm  MTP-n3"         "$M122_Q5" q122-q5-mtp3 --spec-type draft-mtp --spec-draft-n-max 3; prose_too q122-q5-mtp3
BACKEND=rocm   NP=1 run_cfg "122B Q5 ROCm  MTP-n3 KV-q8"   "$M122_Q5" q122-q5-mtp3kv8 --spec-type draft-mtp --spec-draft-n-max 3 --cache-type-k q8_0 --cache-type-v q8_0
BACKEND=vulkan NP=1 run_cfg "122B Q5 Vulkan MTP-n3"        "$M122_Q5" q122-q5-vk-mtp3 --spec-type draft-mtp --spec-draft-n-max 3
# stage Q4 (one-step-down) from external NTFS -> NVMe
say "staging 122B Q4_K_XL to NVMe..."; mkdir -p "$STAGE/q122q4"; cp "$EXT122Q4"/*.gguf "$STAGE/q122q4/" && say "staged Q4 ($(du -sh "$STAGE/q122q4"|cut -f1))"
S122Q4=/models/_stage/q122q4/$(basename "$EXT122Q4"/*-00001-of-00003.gguf)
BACKEND=rocm   NP=1 run_cfg "122B Q4 ROCm  MTP-n3"         "$S122Q4" q122-q4-mtp3 --spec-type draft-mtp --spec-draft-n-max 3; prose_too q122-q4-mtp3
BACKEND=vulkan NP=1 run_cfg "122B Q4 Vulkan MTP-n3"        "$S122Q4" q122-q4-vk-mtp3 --spec-type draft-mtp --spec-draft-n-max 3
bash "$H" stop >/dev/null 2>&1 || true
say "## 122B quality (PPL-delta; no BF16)"
CHUNKS=48 CTX=512 bash "$Q" ppl "$M122_Q5" 122b-q5 2>&1 | grep -iE 'Final|PPL|saved' | sed 's/^/    /' | tee -a "$SUM"
CHUNKS=48 CTX=512 bash "$Q" ppl "$S122Q4" 122b-q4 2>&1 | grep -iE 'Final|PPL|saved' | sed 's/^/    /' | tee -a "$SUM"
rm -rf "$STAGE/q122q4"

############ 35B (Qwen3.6-35B-A3B, MTP + vision) ############
say "## 35B  (current quant Q6_K MTP on NVMe, +vision)"
BACKEND=rocm   NP=1 MMPROJ=$MM35 run_cfg "35B Q6 ROCm  MTP-n2 +vis"      "$M35_Q6" q36-q6-mtp2 --spec-type draft-mtp --spec-draft-n-max 2; prose_too q36-q6-mtp2
BACKEND=rocm   NP=1 MMPROJ=$MM35 run_cfg "35B Q6 ROCm  MTP-n2 KV-q8"     "$M35_Q6" q36-q6-mtp2kv8 --spec-type draft-mtp --spec-draft-n-max 2 --cache-type-k q8_0 --cache-type-v q8_0
BACKEND=vulkan NP=1 MMPROJ=$MM35 run_cfg "35B Q6 Vulkan MTP-n2 +vis"     "$M35_Q6" q36-q6-vk-mtp2 --spec-type draft-mtp --spec-draft-n-max 2
BACKEND=rocm   NP=4 MMPROJ=$MM35 run_cfg "35B Q6 ROCm  non-MTP parallel4 (prod ref)" "$M35_Q6" q36-q6-p4
# stage Q5 (one-step-down)
say "staging 35B Q5_K_M to NVMe..."; mkdir -p "$STAGE/q36q5"; cp "$EXT35Q5" "$STAGE/q36q5/" && say "staged Q5"
S35Q5=/models/_stage/q36q5/$(basename "$EXT35Q5")
BACKEND=rocm   NP=1 MMPROJ=$MM35 run_cfg "35B Q5 ROCm  MTP-n2 +vis"      "$S35Q5" q36-q5-mtp2 --spec-type draft-mtp --spec-draft-n-max 2; prose_too q36-q5-mtp2
BACKEND=vulkan NP=1 MMPROJ=$MM35 run_cfg "35B Q5 Vulkan MTP-n2 +vis"     "$S35Q5" q36-q5-vk-mtp2 --spec-type draft-mtp --spec-draft-n-max 2
bash "$H" stop >/dev/null 2>&1 || true
say "## 35B quality (KLD vs BF16 + PPL)"
say "staging 35B BF16 to NVMe..."; mkdir -p "$STAGE/q36bf16"; cp "$EXT35BF"/*.gguf "$STAGE/q36bf16/" && say "staged BF16 ($(du -sh "$STAGE/q36bf16"|cut -f1))"
S35BF=/models/_stage/q36bf16/$(basename "$EXT35BF"/*-00001-of-00002.gguf)
CHUNKS=48 CTX=512 bash "$Q" kld-base "$S35BF" 35b-bf16 2>&1 | tail -2 | sed 's/^/    /' | tee -a "$SUM"
CHUNKS=48 CTX=512 bash "$Q" kld "$M35_Q6" 35b-bf16 35b-q6 2>&1 | grep -iE 'Mean|Median|Maximum|RMS|PPL|same top|saved' | sed 's/^/    /' | tee -a "$SUM"
CHUNKS=48 CTX=512 bash "$Q" kld "$S35Q5" 35b-bf16 35b-q5 2>&1 | grep -iE 'Mean|Median|Maximum|RMS|PPL|same top|saved' | sed 's/^/    /' | tee -a "$SUM"
rm -rf "$STAGE/q36q5" "$STAGE/q36bf16"

say "=== SWEEP DONE — summary: $SUM ==="
