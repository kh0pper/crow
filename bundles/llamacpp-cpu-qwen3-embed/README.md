# llama.cpp Qwen3-Embedding-0.6B (CPU)

A **CPU-only** embedding endpoint for Crow's semantic search, for hosts without a
compatible GPU (or that can't reach a shared embedding server like `grackle-embed`).
It serves **Qwen3-Embedding-0.6B** (Q8_0 GGUF, 1024-dim) via llama.cpp with an
OpenAI-compatible `/v1/embeddings` API on `127.0.0.1:8007`.

Same model — and therefore the same 1024-dim vector space — as the GPU
`vllm-cuda-embed` / `llamacpp-vulkan-qwen3-embed` bundles, so embeddings are
interchangeable across them.

## Install

From the Crow's Nest **Extensions** panel, install **llama.cpp Qwen3-Embedding-0.6B (CPU)**.
Requires Docker. The first request downloads the ~640MB GGUF and caches it in a
Docker volume.

## Make it the embedding provider

The bundle registers a provider with id **`llamacpp-cpu-embed`**. Point Crow's
semantic search at it (see *Choosing the embedding provider* in the AI Providers
guide):

```sql
INSERT INTO dashboard_settings (key, value) VALUES ('embed_provider', 'llamacpp-cpu-embed')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
```

…or set `CROW_EMBED_PROVIDER=llamacpp-cpu-embed`. Allow ~30s for the cache to refresh.

## Verify

```bash
curl http://127.0.0.1:8007/v1/models
curl -s http://127.0.0.1:8007/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-embedding-0.6b","input":"hello"}' | head -c 200
```

## Notes

- CPU inference: embedding a short text is fast; the one-time model load takes a
  couple of seconds on first call.
- No API key, no GPU, no data leaves your machine.
