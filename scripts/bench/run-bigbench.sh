#!/usr/bin/env bash
# Single-window benchmark: Qwen3.5-122B-A10B (MTP), gpt-oss-120B, GLM-4.5-Air.
# Trap-protected: :8003 is ALWAYS restored on exit (even error/kill).
set -uo pipefail
H=/home/kh0pp/crow/scripts/bench/mtp-explore.sh
MT=/models/mtp-test
BUNDLE=/home/kh0pp/crow/bundles/llamacpp-vulkan-qwen36-35b-a3b
RES=/home/kh0pp/crow/scripts/bench/results
ST=/home/kh0pp/crow/scripts/bench/.bigbench.status
LOG=$RES/bigbench-$(date -u +%Y%m%dT%H%M%SZ).log
mkdir -p "$RES"; echo RUNNING > "$ST"
say(){ echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }

restore() {
  say "RESTORE: ensuring :8003 back up"
  bash "$H" stop >>"$LOG" 2>&1 || true
  if ! docker ps --format '{{.Names}}' | grep -q '^llamacpp-vulkan-qwen36-35b-a3b$'; then
    ( cd "$BUNDLE" && docker compose up -d ) >>"$LOG" 2>&1 || true
  fi
  for i in $(seq 1 60); do
    curl -sf http://100.118.41.122:8003/health >/dev/null 2>&1 && { say "RESTORE: :8003 healthy"; break; }
    sleep 5
  done
}
trap 'restore; [ "$(cat "$ST")" = RUNNING ] && echo INTERRUPTED > "$ST"; say "trap exit"' EXIT

say "=== stopping production :8003 ==="
( cd "$BUNDLE" && docker compose stop ) >>"$LOG" 2>&1 || true
sleep 3

bench_model(){ # $1=label $2=container-model-path $3=alias  $4..=launch flags
  local label="$1" model="$2" alias="$3"; shift 3
  say ">>> LAUNCH $label  flags: $*"
  if ! bash "$H" launch "$model" "$alias" "$@" >>"$LOG" 2>&1; then
    say "!!! $label FAILED TO LAUNCH (see log) — skipping"
    return 1
  fi
  say "$label READY"
  return 0
}
m(){ say "--- measure $*"; bash "$H" measure "$@" 2>&1 | grep -E 'runs=|gen_tok' | tee -a "$LOG"; }
tc(){ say "--- toolcall $1"; bash "$H" toolcall "$1" 2>&1 | tee -a "$LOG"; }

############ 1) Qwen3.5-122B-A10B Q5_K_M (MTP) ############
Q=$MT/Qwen3.5-122B-A10B-UD-Q5_K_M-00001-of-00003.gguf
if bench_model "Qwen3.5-122B OFF" "$Q" q122 ; then
  m q122 q122-off code greedy ; m q122 q122-off prose greedy
fi
if bench_model "Qwen3.5-122B MTP n3" "$Q" q122 --spec-type draft-mtp --spec-draft-n-max 3 ; then
  m q122 q122-mtp3 code greedy ; m q122 q122-mtp3 prose greedy
  m q122 q122-mtp3 code scode  ; m q122 q122-mtp3 code sgen
  tc q122
fi

############ 2) gpt-oss-120B MXFP4 (no MTP) ############
G=$MT/gpt-oss-120b-mxfp4-00001-of-00003.gguf
if bench_model "gpt-oss-120B" "$G" gptoss ; then
  m gptoss gptoss code greedy ; m gptoss gptoss prose greedy
  m gptoss gptoss code scode ; tc gptoss
fi

############ 3) GLM-4.5-Air Q5_K_M ############
GL=/models/glm-45-air/GLM-4.5-Air-Q5_K_M-00001-of-00002.gguf
say ">>> GLM MTP-probe (does llama.cpp draft-mtp accept GLM arch?)"
if bench_model "GLM-4.5-Air MTP-probe" "$GL" glm --spec-type draft-mtp --spec-draft-n-max 3 ; then
  say "GLM MTP-probe: LAUNCHED (draft-mtp accepted)"; m glm glm-mtp3 code greedy
else
  say "GLM MTP-probe: REJECTED (expected if GLM MTP unsupported in llama.cpp)"
fi
if bench_model "GLM-4.5-Air baseline" "$GL" glm ; then
  m glm glm-off code greedy ; m glm glm-off prose greedy ; tc glm
fi

bash "$H" stop >>"$LOG" 2>&1 || true
say "=== benchmarks complete ==="
restore
echo DONE > "$ST"
say "ALL DONE — results: $LOG"
