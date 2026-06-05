#!/usr/bin/env bash
# pir_model_swap.sh — idempotently make :8003 serve the model the PIR bot needs,
# then restore the 35B daily driver afterward. The 27B (dense) cannot co-reside
# with the 35B (crow-chat) on the Strix Halo, so PIR processing borrows :8003.
#
#   pir_model_swap.sh 27b   # stop 35B bundle, serve 27B (non-MTP) on :8003
#   pir_model_swap.sh 35b   # remove 27B, restore 35B bundle on :8003
#
# Idempotent: if :8003 already serves the requested model, it's a no-op.
# Exit 0 on success, non-zero on failure (caller must handle — e.g. needs-human).
set -uo pipefail

WANT="${1:-}"
BIND="${CROW_TAILSCALE_IP:-100.118.41.122}:8003"
BUNDLE_35B="/home/kh0pp/crow/bundles/llamacpp-vulkan-qwen36-35b-a3b"
GGUF_27B="/models/qwen36-27b/Qwen3.6-27B-UD-Q6_K_XL.gguf"
TOOLBOX_27B="kyuz0/amd-strix-halo-toolboxes:rocm-7.2.1"
C27="qwen36-27b-pir-server"
READY_TIMEOUT="${PIR_MODEL_READY_TIMEOUT:-300}"   # seconds to wait for a model to warm

served() { curl -sf "http://$BIND/v1/models" 2>/dev/null | python3 -c 'import sys,json;print((json.load(sys.stdin).get("data") or [{}])[0].get("id",""))' 2>/dev/null; }

wait_ready() {
  local want_id="$1" t=0
  until curl -sf "http://$BIND/health" >/dev/null 2>&1; do
    t=$((t+5)); [ "$t" -ge "$READY_TIMEOUT" ] && { echo "TIMEOUT waiting /health"; return 1; }; sleep 5
  done
  # warm until a real completion returns
  t=0
  until curl -s -m 60 "http://$BIND/v1/chat/completions" -H 'Content-Type: application/json' \
      -d "{\"model\":\"$want_id\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":4,\"temperature\":0}" 2>/dev/null \
      | python3 -c 'import sys,json;sys.exit(0 if json.load(sys.stdin).get("choices") else 1)' 2>/dev/null; do
    t=$((t+5)); [ "$t" -ge "$READY_TIMEOUT" ] && { echo "TIMEOUT warming"; return 1; }; sleep 5
  done
  return 0
}

case "$WANT" in
  27b)
    [ "$(served)" = "qwen3.6-27b" ] && { echo "27b already served"; exit 0; }
    echo "swap -> 27b: stopping 35b bundle"
    ( cd "$BUNDLE_35B" && docker compose stop ) >/dev/null 2>&1 || docker stop llamacpp-vulkan-qwen36-35b-a3b >/dev/null 2>&1 || true
    docker rm -f "$C27" >/dev/null 2>&1 || true
    # shellcheck disable=SC1091
    source /home/kh0pp/.crow/env/rocm.env
    docker run -d \
      --device=/dev/kfd --device=/dev/dri \
      --group-add "${VIDEO_GID}" --group-add "${RENDER_GID}" \
      --env-file /home/kh0pp/.crow/env/rocm.env \
      -v /home/kh0pp/llm/hf-cache:/models \
      --ipc=host --shm-size=16g \
      -p "${BIND}:8000" \
      --name "$C27" --restart no \
      --entrypoint llama-server "$TOOLBOX_27B" \
      -m "$GGUF_27B" --alias qwen3.6-27b \
      --host 0.0.0.0 --port 8000 \
      -ngl 999 -fa on --no-mmap -c 65536 --parallel 1 --jinja \
      --temp 0.7 --top-p 0.8 --top-k 20 --min-p 0 --seed 42 >/dev/null 2>&1
      # Qwen3-family RECOMMENDED sampling, non-thinking preset (these bots run
      # with thinking disabled): temp 0.7 / top-p 0.8 / top-k 20 / min-p 0. Qwen
      # explicitly warns AGAINST greedy (temp 0) for these reasoning models
      # (repetition / quality loss) — we previously forced greedy only to make
      # the test VERDICTS reproducible, which hurt the bot's actual quality and
      # was only partly attainable on an agentic tool-loop anyway. Correctness is
      # now guaranteed by the validate-or-escalate layer, not by greedy decoding.
      # --seed 42 keeps a little run-to-run stability without changing the
      # distribution. pi sends no sampling params, so these launch flags apply.
    if wait_ready qwen3.6-27b; then echo "27b ready"; exit 0; fi
    echo "27b FAILED to warm — restoring 35b"; docker rm -f "$C27" >/dev/null 2>&1 || true
    ( cd "$BUNDLE_35B" && docker compose up -d ) >/dev/null 2>&1; exit 1
    ;;
  35b)
    [ "$(served)" = "qwen3.6-35b-a3b" ] && { echo "35b already served"; exit 0; }
    echo "swap -> 35b: removing 27b, restoring 35b bundle"
    docker rm -f "$C27" >/dev/null 2>&1 || true
    ( cd "$BUNDLE_35B" && docker compose up -d ) >/dev/null 2>&1
    if wait_ready qwen3.6-35b-a3b; then echo "35b ready"; exit 0; fi
    echo "35b FAILED to warm"; exit 1
    ;;
  *) echo "usage: pir_model_swap.sh 27b|35b"; exit 2;;
esac
