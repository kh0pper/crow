---
name: vllm
description: Operational skill for the vLLM classroom inference engine — size the GPU, pick a model, wire into Maker Lab / Companion, diagnose common issues
triggers:
  - vllm
  - classroom engine
  - scale to 25 learners
  - local llm inference
  - openai-compatible endpoint
  - gpu inference
tools:
  - crow-memory
---

# vLLM — Classroom Inference Engine

## When to activate

- Admin / teacher asks about serving an LLM to a **classroom** (≥10 concurrent learners).
- Request references vLLM by name, "continuous batching", "PagedAttention", or OpenAI-compatible local inference.
- Ollama benchmarks are coming back with high p95 latencies at scale and the user is looking for an upgrade.
- Maker Lab classroom deployment planning.

## Why vLLM, not Ollama

Per the Maker Lab Phase 0 benchmark (Spike 5, see `bundles/maker-lab/PHASE-0-REPORT.md`):

- Ollama at `NUM_PARALLEL=4` on a 16 GB GPU → p95=36s at N=25 concurrent. Borderline unusable for a classroom hint loop.
- Ollama at `NUM_PARALLEL=8` crashed on the same GPU (VRAM exhaustion).
- vLLM's architecture — continuous batching + PagedAttention — is the right shape for the N=25 shape. Same hardware, structurally better latency distribution.

**Use Ollama for solo/family.** Use vLLM for classroom.

## Workflow 1: size the GPU

1. Ask what GPU is available. If unknown, `nvidia-smi` from the server.
2. Rule of thumb for fp16 weights:
   - 7B params → ~14 GB of VRAM for weights alone; realistic with a 24 GB GPU leaving headroom for KV cache.
   - 3B params → ~6 GB; fits a 16 GB GPU comfortably with ~8 GB of KV cache headroom.
   - 1B params → ~2 GB; even a 6-8 GB GPU works.
3. Int8 / AWQ quantization roughly halves weight footprint. Default to fp16 unless the GPU is tight.
4. If the GPU is <8 GB, flag it — vLLM technically runs but the classroom scale benefit collapses; suggest Ollama solo mode instead.

## Workflow 2: pick a model

Good defaults:

- **16 GB GPU (RTX 4060 Ti, RTX 4070)** — `Qwen/Qwen2.5-3B-Instruct` at `max-num-seqs=16`.
- **24 GB GPU (RTX 3090, 4090, A5000)** — `Qwen/Qwen2.5-7B-Instruct` or `meta-llama/Llama-3.1-8B-Instruct` at `max-num-seqs=16`.
- **48 GB+ (A6000, H100)** — 13B-class models; `max-num-seqs=32+` for a full classroom.

Don't fabricate HuggingFace model IDs. If the user wants a specific model and you're unsure of the canonical name, suggest they check `huggingface.co` first.

## Workflow 3: wire into Maker Lab

Once vLLM is up, the OpenAI-compatible endpoint drops into Maker Lab's config:

```
MAKER_LAB_LLM_ENDPOINT=http://<host>:8089/v1
MAKER_LAB_LLM_MODEL=<same as VLLM_MODEL>
```

Same two env vars wire into Companion (it's also OpenAI-compatible-speaking) and the gateway's BYOAI chat.

## Workflow 4: diagnose common issues

- **"CUDA out of memory" on startup** → lower `VLLM_GPU_MEMORY_UTILIZATION` (try 0.7) or pick a smaller model.
- **"Model access denied"** → gated model. Check huggingface.co for the model page, request access, then set `VLLM_HF_TOKEN`.
- **First start hangs forever** → it's downloading. `docker logs -f crow-vllm` shows progress. A 7B model is ~15 GB; on a home connection that's 10-30 minutes.
- **p95 latency still bad at N=25** → raise `--max-num-seqs` to 32. Watch `nvidia-smi` for VRAM pressure. If it OOMs, fall back to 16 + a smaller model.
- **Container exits with "No CUDA GPUs are available"** → NVIDIA Container Toolkit isn't set up. On Ubuntu: `sudo apt install nvidia-container-toolkit && sudo systemctl restart docker`.

## Transparency

- Tell the user when a suggested model needs gated access and the HuggingFace workflow to get it.
- First-start download is multi-GB. Say so before they commit.
- This bundle is Linux x86_64 + NVIDIA only. Don't recommend it on a Pi, an M-series Mac, or an AMD GPU host — point those users at Ollama instead.
- VRAM numbers above are rules of thumb. Real weights may surprise by ±20% — the first `docker logs` line from vLLM prints exact memory usage once the model loads.
