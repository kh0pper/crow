#!/usr/bin/env bash
# Quality eval for quant comparison (§1.2).
#  - perplexity (PPL): per-quant; compare deltas (used for BOTH models).
#  - KL-divergence (KLD): quant-vs-BF16; meaningful ONLY against a high-precision base.
#       35B → yes (BF16 downloaded). 122B → skip (BF16 ~249 GB, out of scope) — use PPL-delta.
#  - side-by-side: handled by `mtp-explore.sh capture` into results/quality/ for human diff.
#
# Two-step KLD (standard llama.cpp): (1) `kld-base` writes a logits file from the BF16 model;
# (2) `kld` reads it and computes divergence for a quant. Same eval text + ctx + chunks for all.
#
# Model paths are INSIDE the container: /models (hf-cache, rw) or /models-ext (external, ro).
# The KLD base + logs are written to /work (results/quality on NVMe, rw).
set -uo pipefail
source /home/kh0pp/.crow/env/rocm.env
IMG="${ROCM_IMG:-kyuz0/amd-strix-halo-toolboxes:rocm-7.2.3}"
RES="/home/kh0pp/crow/scripts/bench/results/quality"; mkdir -p "$RES"
TEXT="${TEXT:-/work/wiki.test.raw}"   # in-container path; place wiki.test.raw in results/quality/
CHUNKS="${CHUNKS:-200}"; CTX="${CTX:-4096}"
DRARGS=( --device=/dev/kfd --device=/dev/dri --group-add "${VIDEO_GID}" --group-add "${RENDER_GID}"
  --env-file /home/kh0pp/.crow/env/rocm.env
  -v /home/kh0pp/llm/hf-cache:/models -v /mnt/external/llm-models:/models-ext:ro
  -v "$RES":/work --ipc=host --shm-size=16g )
ts(){ date -u +%Y%m%dT%H%M%SZ; }
run(){ local ep="$1"; shift; docker run --rm "${DRARGS[@]}" --entrypoint "$ep" "$IMG" "$@"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  ppl)        # $1=model-in-container [label]  → perplexity
    M="$1"; L="${2:-$(basename "$M")}"; OUT="$RES/ppl-${L}-$(ts).log"
    run llama-perplexity -m "$M" -f "$TEXT" -c "$CTX" --chunks "$CHUNKS" -ngl 999 -fa on -fit off --no-mmap 2>&1 | tee "$OUT"
    echo "--- PPL summary ($L) ---" | tee -a "$OUT"
    grep -iE 'Final estimate|perplexity|PPL =' "$OUT" | tail -3 | tee -a "$OUT"; echo "saved: $OUT" ;;
  kld-base)   # $1=bf16-model  $2=base-name (written to /work/<name>.dat)
    M="$1"; B="/work/${2}.dat"; OUT="$RES/kldbase-${2}-$(ts).log"
    run llama-perplexity -m "$M" -f "$TEXT" -c "$CTX" --chunks "$CHUNKS" -ngl 999 -fa on -fit off --no-mmap \
      --kl-divergence-base "$B" 2>&1 | tee "$OUT"; echo "base written to $B (host: $RES/${2}.dat)" ;;
  kld)        # $1=quant-model  $2=base-name [label]  → KLD vs /work/<name>.dat
    M="$1"; B="/work/${2}.dat"; L="${3:-$(basename "$M")}"; OUT="$RES/kld-${L}-$(ts).log"
    run llama-perplexity -m "$M" -f "$TEXT" -c "$CTX" --chunks "$CHUNKS" -ngl 999 -fa on -fit off --no-mmap \
      --kl-divergence --kl-divergence-base "$B" 2>&1 | tee "$OUT"
    echo "--- KLD summary ($L vs $2) ---" | tee -a "$OUT"
    grep -iE 'Kullback|KL diverg|Mean|Median|Maximum|RMS|q9|same top' "$OUT" | tail -20 | tee -a "$OUT"; echo "saved: $OUT" ;;
  *) echo "usage: quality-eval.sh ppl MODEL [label] | kld-base BF16 BASENAME | kld QUANT BASENAME [label]   (env: TEXT CHUNKS CTX)"; exit 2 ;;
esac
