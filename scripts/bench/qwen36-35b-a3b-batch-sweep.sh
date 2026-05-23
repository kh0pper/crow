#!/usr/bin/env bash
# Sweep -ub / -b on the Qwen3.6-35B-A3B model to see whether the gfx1151
# perf issue (#21284) recommendation of -ub 2048 -b 2048 actually helps
# our deployed config.  Runs llama-bench against the same model file the
# llamacpp-vulkan-qwen36-35b-a3b service uses; takes the service down
# briefly and restores it via trap.
set -euo pipefail

MODEL_FILE="/home/kh0pp/llm/hf-cache/qwen36-35b-a3b/Qwen3.6-35B-A3B-UD-Q6_K.gguf"
MODEL_DIR="/home/kh0pp/llm/hf-cache"
TOOLBOX_IMAGE="kyuz0/amd-strix-halo-toolboxes:rocm-7.2.1"
RESTORE_NAME="llamacpp-vulkan-qwen36-35b-a3b"
BENCH_NAME="qwen36-35b-a3b-batch-sweep"
RESULT_DIR="/home/kh0pp/crow/scripts/bench/results"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RESULT_DIR"
LOG="$RESULT_DIR/qwen36-35b-batch-sweep-${TS}.log"

# shellcheck disable=SC1091
source /home/kh0pp/.crow/env/rocm.env

cleanup() {
  echo "[cleanup] removing bench container, restoring 35B-A3B..." | tee -a "$LOG"
  docker rm -f "$BENCH_NAME" >/dev/null 2>&1 || true
  if ! docker ps --format '{{.Names}}' | grep -q "^${RESTORE_NAME}\$"; then
    docker start "$RESTORE_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "=== 35B-A3B batch sweep @ ${TS} ===" | tee -a "$LOG"
docker stop "$RESTORE_NAME" >>"$LOG" 2>&1 || true

# llama-bench accepts comma-separated lists for -b and -ub. -p sweeps the
# prompt-eval (pp) length; -n is the gen length. Sweep ub at 512 (default),
# 1024, and 2048 with b held at 2048.
echo "[step] llama-bench sweep: -b 2048 -ub 512,1024,2048 -p 512 -n 128 -r 3" | tee -a "$LOG"
docker run --rm \
  --device=/dev/kfd --device=/dev/dri \
  --group-add "${VIDEO_GID}" --group-add "${RENDER_GID}" \
  --env-file /home/kh0pp/.crow/env/rocm.env \
  -v "${MODEL_DIR}:/models" \
  --ipc=host --shm-size=16g \
  --name "$BENCH_NAME" \
  --entrypoint llama-bench \
  "$TOOLBOX_IMAGE" \
  -m /models/qwen36-35b-a3b/Qwen3.6-35B-A3B-UD-Q6_K.gguf \
  -ngl 999 -fa 1 -b 2048 -ub 512,1024,2048 \
  -p 512 -n 128 -r 3 -o md \
  2>&1 | tee -a "$LOG"

echo "=== sweep complete; cleanup will restart 35B-A3B ===" | tee -a "$LOG"
