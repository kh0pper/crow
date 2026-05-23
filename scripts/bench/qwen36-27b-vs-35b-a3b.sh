#!/usr/bin/env bash
# Benchmark Qwen3.6-27B (dense) on Strix Halo and compare to the running
# Qwen3.6-35B-A3B baseline. Designed to be re-runnable.
#
# Stops the 35B-A3B container, runs llama-bench against the 27B, then runs
# a real llama-server with the 27B and exercises it with a coding prompt.
# Restores the 35B-A3B container at the end (or on Ctrl-C / failure).
#
# FIXES 2026-05-16 (mtp-exploration session):
#   1. jq -> python3 : the crow host has NO jq. The original step-4
#      `jq -nc` produced an empty request body -> HTTP 500 "empty input"
#      -> completion_tokens=0 (the 2026-05-09 run's step-4 failure).
#   2. `docker start RESTORE` -> `docker compose up -d` from the bundle dir.
#      Plain `docker start` re-attaches a stopped container WITHOUT its
#      compose network (crow-chat-llm-container-persistence scar) -> the
#      restored :8003 loses name resolution. compose up -d restores it
#      correctly with the network.
#   3. /health-only readiness was a false ready signal -> added a
#      warmup-until-real-completion gate before the timed test.
#   4. step-4 now uses a non-streaming request and reads llama.cpp's
#      server-measured `timings` (accurate) instead of SSE-parse + wall
#      clock (which double-counted connect/TLS time).

set -euo pipefail

MODEL_FILE="/home/kh0pp/llm/hf-cache/qwen36-27b/Qwen3.6-27B-UD-Q6_K_XL.gguf"
MODEL_DIR="/home/kh0pp/llm/hf-cache"
TOOLBOX_IMAGE="kyuz0/amd-strix-halo-toolboxes:rocm-7.2.1"
PORT=8003
HOST_IP="${CROW_TAILSCALE_IP:-100.118.41.122}"
BIND="${HOST_IP}:${PORT}"
BENCH_CONTAINER="qwen36-27b-bench"
SERVER_CONTAINER="qwen36-27b-bench-server"
RESTORE_NAME="llamacpp-vulkan-qwen36-35b-a3b"
RESTORE_BUNDLE="/home/kh0pp/crow/bundles/llamacpp-vulkan-qwen36-35b-a3b"
RESULT_DIR="/home/kh0pp/crow/scripts/bench/results"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RESULT_DIR"
LOG="$RESULT_DIR/qwen36-27b-${TS}.log"

# rocm.env values needed for VIDEO_GID / RENDER_GID
# shellcheck disable=SC1091
source /home/kh0pp/.crow/env/rocm.env

cleanup() {
  echo "[cleanup] tearing down bench containers..." | tee -a "$LOG"
  docker rm -f "$BENCH_CONTAINER" "${BENCH_CONTAINER}-35b" "$SERVER_CONTAINER" >/dev/null 2>&1 || true
  if ! docker ps --format '{{.Names}}' | grep -q "^${RESTORE_NAME}\$"; then
    echo "[cleanup] restoring ${RESTORE_NAME} via docker compose up -d ..." | tee -a "$LOG"
    ( cd "$RESTORE_BUNDLE" && docker compose up -d ) >>"$LOG" 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ ! -f "$MODEL_FILE" ]]; then
  echo "model not found: $MODEL_FILE" >&2
  exit 1
fi

echo "=== Qwen3.6-27B benchmark @ ${TS} ===" | tee -a "$LOG"
echo "Model: $MODEL_FILE ($(du -h "$MODEL_FILE" | cut -f1))" | tee -a "$LOG"

echo "[step 1] stopping ${RESTORE_NAME} via docker compose stop ..." | tee -a "$LOG"
( cd "$RESTORE_BUNDLE" && docker compose stop ) >>"$LOG" 2>&1 || docker stop "$RESTORE_NAME" >>"$LOG" 2>&1 || true

# Helper to run docker w/ standard GPU + cache mounts.
docker_run_args=(
  --rm
  --device=/dev/kfd --device=/dev/dri
  --group-add "${VIDEO_GID}" --group-add "${RENDER_GID}"
  --env-file /home/kh0pp/.crow/env/rocm.env
  -v "${MODEL_DIR}:/models"
  --ipc=host --shm-size=16g
)

echo "[step 2a] llama-bench Qwen3.6-27B (dense): pp512 / tg128 / tg256 (3 reps)..." | tee -a "$LOG"
docker run "${docker_run_args[@]}" --name "$BENCH_CONTAINER" \
  --entrypoint llama-bench \
  "$TOOLBOX_IMAGE" \
  -m /models/qwen36-27b/Qwen3.6-27B-UD-Q6_K_XL.gguf \
  -ngl 999 -fa 1 -p 512 -n 128,256 -r 3 -o md \
  2>&1 | tee -a "$LOG"

echo "[step 2b] llama-bench Qwen3.6-35B-A3B (MoE) for comparison..." | tee -a "$LOG"
docker run "${docker_run_args[@]}" --name "${BENCH_CONTAINER}-35b" \
  --entrypoint llama-bench \
  "$TOOLBOX_IMAGE" \
  -m /models/qwen36-35b-a3b/Qwen3.6-35B-A3B-UD-Q6_K.gguf \
  -ngl 999 -fa 1 -p 512 -n 128,256 -r 3 -o md \
  2>&1 | tee -a "$LOG"

echo "[step 3] starting llama-server (27B, 1 slot, 64K ctx)..." | tee -a "$LOG"
docker run -d "${docker_run_args[@]}" --name "$SERVER_CONTAINER" \
  -p "${BIND}:8000" \
  --entrypoint llama-server \
  "$TOOLBOX_IMAGE" \
  -m /models/qwen36-27b/Qwen3.6-27B-UD-Q6_K_XL.gguf \
  --mmproj /models/qwen36-27b/mmproj-F16.gguf \
  --alias qwen3.6-27b \
  --host 0.0.0.0 --port 8000 \
  -ngl 999 -fa on --no-mmap \
  -c 65536 --parallel 1 \
  --jinja \
  >>"$LOG" 2>&1

echo "[step 3.1] waiting for server /health ..." | tee -a "$LOG"
ATTEMPTS=0
until curl -sf "http://${BIND}/health" >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS+1))
  if [[ $ATTEMPTS -gt 60 ]]; then
    echo "server failed /health after 5 min" | tee -a "$LOG" >&2
    docker logs "$SERVER_CONTAINER" 2>&1 | tail -50 | tee -a "$LOG"
    exit 1
  fi
  sleep 5
done
echo "[step 3.1] /health ok after $((ATTEMPTS*5))s" | tee -a "$LOG"

echo "[step 3.2] warmup until a real completion returns ..." | tee -a "$LOG"
WARM=0
while :; do
  WRESP="$(curl -s -m 60 "http://${BIND}/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d '{"model":"qwen3.6-27b","messages":[{"role":"user","content":"hi"}],"max_tokens":4,"temperature":0}' 2>/dev/null || true)"
  if printf '%s' "$WRESP" | python3 -c 'import sys,json;d=json.load(sys.stdin);sys.exit(0 if d.get("choices") else 1)' 2>/dev/null; then
    echo "[step 3.2] server warm after $((WARM*5))s" | tee -a "$LOG"
    break
  fi
  WARM=$((WARM+1))
  if [[ $WARM -gt 30 ]]; then
    echo "server never returned a valid completion (2.5 min)" | tee -a "$LOG" >&2
    docker logs "$SERVER_CONTAINER" 2>&1 | tail -50 | tee -a "$LOG"
    exit 1
  fi
  sleep 5
done

echo "[step 4] coding-prompt test (non-stream, server-measured timings)..." | tee -a "$LOG"
export BENCH_PROMPT='You are an AI coding assistant. Write a Python function `fibonacci_iter(n)` that returns the n-th Fibonacci number using an iterative approach. Include a brief docstring, handle n < 0 by raising ValueError, and add three example calls in an `if __name__ == "__main__":` block. Output only the code, no commentary.'
REQ_BODY="$(python3 - <<'PY'
import json,os
print(json.dumps({"model":"qwen3.6-27b","stream":False,"max_tokens":400,"temperature":0,
"messages":[{"role":"user","content":os.environ["BENCH_PROMPT"]}]}))
PY
)"
curl -s -m 240 "http://${BIND}/v1/chat/completions" \
  -H 'Content-Type: application/json' -d "$REQ_BODY" \
  > "$RESULT_DIR/qwen36-27b-${TS}.resp.json" 2>>"$LOG" || true
python3 - "$RESULT_DIR/qwen36-27b-${TS}.resp.json" <<'PY' | tee -a "$LOG"
import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception as e:
    print("[step 4] FAILED to parse response:",e); sys.exit(0)
t=d.get("timings",{}) or {}
u=d.get("usage",{}) or {}
ch=(d.get("choices") or [{}])[0]
msg=ch.get("message",{}) or {}
body=(msg.get("reasoning_content") or "")+(msg.get("content") or "")
print("[step 4] completion_tokens=%s finish=%s" % (u.get("completion_tokens"), ch.get("finish_reason")))
print("[step 4] prompt   tok/s = %.2f" % (t.get("prompt_per_second") or 0.0))
print("[step 4] generate tok/s = %.2f" % (t.get("predicted_per_second") or 0.0))
print("[step 4] output chars   = %d" % len(body))
PY

echo "[step 5] /v1/models sanity:" | tee -a "$LOG"
curl -sf "http://${BIND}/v1/models" 2>/dev/null | python3 -m json.tool 2>/dev/null | tee -a "$LOG" || echo "(models endpoint parse failed)" | tee -a "$LOG"

echo "=== bench complete; restoring ${RESTORE_NAME} in cleanup ===" | tee -a "$LOG"
echo "results: $LOG"
