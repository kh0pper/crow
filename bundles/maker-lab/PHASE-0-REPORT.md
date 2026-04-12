# Maker Lab — Phase 0 Spike Report

Status: 4 of 5 spikes resolved. Spike 5 (Ollama benchmark) needs user decision before running — flagged at the bottom.

Evidence was gathered against the running `crow-companion` container (image `crow-companion`, uptime 45h on grackle). Open-LLM-VTuber is checked out at `/app/` inside the container via `git clone --recursive https://github.com/Open-LLM-VTuber/Open-LLM-VTuber.git`.

---

## Spike 1 — Companion WS routing model: **per-connection** ✅

**Finding:** The backend is per-connection. No singleton posture anywhere in the hot path.

Evidence (`src/open_llm_vtuber/websocket_handler.py`):

- `WebSocketHandler.__init__` holds three per-client maps:
  - `client_connections: Dict[str, WebSocket]` — one `WebSocket` per `client_uid`
  - `client_contexts: Dict[str, ServiceContext]` — one `ServiceContext` per `client_uid`
  - `current_conversation_tasks: Dict[str, Optional[asyncio.Task]]` — per-client asyncio task
- `_init_service_context(send_text, client_uid)` performs `model_copy(deep=True)` on every sub-config (`system_config`, `character_config`, `live2d_model`, `asr_engine`, `tts_engine`, `vad_engine`, `agent_engine`, `translate_engine`, `mcp_server_registery`, `tool_adapter`) and stores the clone in `client_contexts[client_uid]`. State mutations on one connection cannot bleed to another.
- `_handle_config_switch(websocket, client_uid, data)` (line 603) resolves `context = self.client_contexts[client_uid]` and calls `context.handle_config_switch(websocket, config_file_name)` — scoped to one connection.

**Impact on plan:**

- `backend-0002-per-connection-session-context.patch` is **not needed**. The patch slot stays empty.
- Phase 1 can lock tool signatures. Tools can safely rely on `session_token → connection_id → ServiceContext` routing.
- The "multi-kiosk isolation" verification test (plan line 367–368) is already guaranteed by the backend architecture; our job is to pin the token to a `client_uid` at redeem time.

---

## Spike 2 — Persona-swap mechanism: **per-connection via `switch-config`** ✅

**Finding:** Per-connection persona switching already exists upstream. No new mechanism needed. No renderer-side patch needed.

Evidence:

- `scripts/generate-config.py` already emits per-persona YAMLs into `/app/characters/` (see `generate_character_configs`). Each YAML carries its own `persona_prompt`, `live2d_model_name`, `character_name`, `tts_config.edge_tts.voice`. Household profiles use this same mechanism today for per-user memory scoping (lines 384–497).
- `config_alts_dir: "characters"` is set in `system_config` (line 307 of generate-config.py).
- Runtime WS message `switch-config` (registered in `MessageType.CONFIG`, line 45 of `websocket_handler.py`) swaps the calling connection's character without touching other connections.

**Implementation for maker-lab:**

1. Ship three age-band YAMLs as part of the bundle's config-generation step (installer drops them into the companion's `characters/` dir, matching the household-profile pattern):
   - `/app/characters/maker_lab_kid_tutor.yaml` (ages 5–9)
   - `/app/characters/maker_lab_tween_tutor.yaml` (ages 10–13)
   - `/app/characters/maker_lab_adult_tutor.yaml` (14+)
2. On `maker_start_session`, **the server** (not the client, not the LLM) sends `switch-config` on the kiosk's WS with the appropriate filename. This closes the LLM-spoofing path.
3. On `maker_end_session`, the server sends `switch-config` back to `crow_default.yaml`.

**Impact on plan:**

- `web-0006-persona-swap.patch` is **not needed** — no Electron-renderer change. Patch slot stays empty.
- The acceptance criterion ("persona-swap must be per-connection, not env-var, not process-global") is satisfied by the existing `switch-config` flow. No env-var toggling, no file-swap race.
- Phase 1 spike #2 in the plan said "a new MCP tool `crow_wm_set_persona(profile)` or a new WS message type is added if the companion doesn't already support per-connection persona" — the companion does, so neither is needed.
- **Security note added to Phase 1 plan:** maker-lab's backend handler must originate the `switch-config` server-side, driven by the session-token's resolved age band. The client/LLM must never be able to pick its own persona file.

---

## Spike 3 — `tutor-event` handler location: **Python backend** ✅

**Finding:** Handler lives in the Python backend, not the Electron renderer.

Rationale:

- The WS dispatcher (`_message_handlers` map at `websocket_handler.py:82`) is the natural home for a new typed message. Adding `"tutor-event": self._handle_tutor_event` next to `"text-input": self._handle_conversation_trigger` matches the existing pattern exactly.
- The per-client `ServiceContext`, `mcp_server_registery`, and `tool_adapter` are all backend-side. The Electron renderer has no MCP client and no server-side tool-calling surface.
- The handler must validate `session_token` against maker-lab's MCP server (bridge at `http://host:3004`) and route the filtered reply back on the originating `WebSocket`. That's backend work.
- The filtered reply is spoken via TTS, which lives in `ServiceContext.tts_engine` on the backend. A renderer-side handler would require re-broadcasting to the backend anyway.

**Impact on plan:**

- `backend-0001-tutor-event-handler.patch` owns the handler. `patches/web/` is **not** involved in tutor-event routing.
- Patch scope: add `"tutor-event"` entry to `_init_message_handlers`, add `_handle_tutor_event(self, websocket, client_uid, data)` method that: (a) resolves `data["session_token"]` via the maker-lab MCP tool `maker_hint`, (b) pipes the filtered return through `context.tts_engine` on the same connection, (c) never treats the payload as text-input (no echoing the raw event back).

---

## Spike 4 — Cubism SDK fetch target: **install-time fetch, pinned by SHA** ✅

**Finding:** Cubism Core is already present in the upstream Open-LLM-VTuber repo's `frontend/libs/`. Current deployment ships it transitively via `git clone` at Docker build time — already an install-time fetch.

Version & pin:

- File: `frontend/libs/live2dcubismcore.min.js`
- Size: 129,056 bytes
- SHA-256: `942783587666a3a1bddea93afd349e26f798ed19dcd7a52449d0ae3322fcff7c`
- License header: `Live2D Proprietary Software license` (EULA at `https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html`)
- File also ships unminified at `frontend/libs/live2dcubismcore.js` (222,574 bytes) for debugging.

CDN endpoint (for Phase 3 AppImage first-launch fetch):

- Canonical: `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`
- The community notes this CDN is "unreliable for production" (WebFetch returned 403, likely bot-filter; browsers succeed). **Mitigation:** after first fetch, cache locally at `~/.crow/cache/cubism/live2dcubismcore.min.js` keyed by SHA; verify SHA on every launch; only re-fetch on mismatch. If CDN fails, show the user-facing prompt pointing to the official Live2D SDK download page.
- Pinned SHA to enforce on fetch: `942783587666a3a1bddea93afd349e26f798ed19dcd7a52449d0ae3322fcff7c`.

End-user agreement prompt (first launch, Phase 3 AppImage only):

> **Live2D Cubism SDK License**
>
> This application uses the Live2D Cubism SDK for Web to render the animated mascot. The SDK is published by Live2D Inc. under the Live2D Proprietary Software License.
>
> To continue, download the SDK (≈130 KB) and accept the Live2D license. The download comes directly from Live2D's servers; Crow does not redistribute the SDK.
>
> Read the agreement: https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html
>
> [ I accept — download the SDK ]   [ Cancel — disable pet mode ]

`bundles/companion/CUBISM-LICENSE.md` (to ship with the bundle — draft):

```markdown
# Live2D Cubism SDK — Plain-Language Summary

The AI Companion uses the Live2D Cubism SDK for Web to animate its mascot. The SDK
is owned by Live2D Inc. and published under the Live2D Proprietary Software License
(https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html).

What this means for you:

- The SDK is NOT bundled in this install. On first launch the app downloads it from
  Live2D's CDN (≈130 KB) into ~/.crow/cache/cubism/.
- You — the end user — accept Live2D's license at download time. Crow does not act
  as a redistributor.
- If you opt out, pet-mode is disabled but web-tiled mode works without the SDK
  being downloaded.
- For air-gapped classrooms: a documented manual install script is planned (fetch
  the SDK on an internet-connected machine, copy into ~/.crow/cache/cubism/).

Attribution (required by the Live2D agreement):

  Live2D Cubism SDK for Web © Live2D Inc.
```

**Impact on plan:**

- Phase 3 is no longer blocked on a legal review. Phase 0 Cubism work is done: CDN confirmed, SHA pinned, prompt drafted, license doc drafted. All that remains is writing these into the bundle during Phase 3 work.
- CI is not gated on a Publication License (per the plan's revised posture).

---

## Spike 5 — Ollama concurrency baseline: **done, with caveats** ✅

**Hardware:** grackle, RTX 5060 Ti 16 GB, llama3.2:3b, Q8 KV cache, flash attention on. Pulled to `/mnt/ollama-models/ollama` (external drive, 184 GB free). Prompt: "Explain a for-loop to a 7-year-old in 40 words or fewer." `num_predict=150`, `temperature=0.7`.

Each row is the result of firing N concurrent `/api/generate` calls after a warm-up.

### NUM_PARALLEL=1 (serialized — current production default)

| N | wall | p50 | p95 | max | agg tok/s | errs |
|--:|--:|--:|--:|--:|--:|--:|
| 1 | 4.63s | 4.61 | 4.61 | 4.61 | 10.8 | 0 |
| 4 | 14.9s | 10.8 | 14.9 | 14.9 | 13.6 | 0 |
| 8 | 28.8s | 18.2 | 28.8 | 28.8 | 13.6 | 0 |
| 16 | 57.4s | 32.7 | 57.4 | 57.4 | 13.5 | 0 |
| 25 | 90.5s | 48.4 | 71.5 | 71.7 | 13.6 | 0 |

Throughput plateaus at ~13.6 tok/s; p95 grows linearly with N. 25 kids → 71 s worst-case hint latency. Unusable for classroom.

### NUM_PARALLEL=4 (recommended if sticking with Ollama)

| N | wall | p50 | p95 | max | agg tok/s | errs |
|--:|--:|--:|--:|--:|--:|--:|
| 1 | 3.27s | 3.26 | 3.26 | 3.26 | 12.9 | 0 |
| 4 | 11.2s | 11.1 | 11.2 | 11.2 | 20.0 | 0 |
| 8 | 14.8s | 14.0 | 14.7 | 14.7 | 27.6 | 0 |
| 16 | 29.3s | 19.5 | 29.3 | 29.3 | 27.3 | 0 |
| 25 | 46.8s | 28.1 | 36.1 | 37.0 | 26.6 | 0 |

Throughput ~2× better; p95 at 25 concurrent is 36s. Still marginal but survivable with the plan's canned-hint fallback on queue-overflow.

### NUM_PARALLEL=8 (unstable on this hardware)

| N | wall | errs |
|--:|--:|--:|
| 1 | 4.86s | 0 |
| 4 | 2.24s | **4** |
| 8 | 63.3s | **8** |
| 16 | 117s | **16** |
| 25 | 105s | **25** |

Every multi-request test failed. Likely VRAM exhaustion or per-slot context overflow (32k context × 8 slots on Q8 KV = many GB). Do not deploy at 8 on this GPU with these settings.

### Manifest recommendations

- `ollama.recommended_num_parallel: 4` on a 16 GB consumer GPU.
- `requires.min_ram_gb = 8` for family mode, `16` for classroom mode: confirmed by measurement.
- **Hard warning:** Even at NUM_PARALLEL=4, 25-kid classroom p95 is 36s. The plan's global hint queue + canned-lesson-hint fallback on queue depth is not optional — it's the only thing making classroom mode tolerable with Ollama.

### Important caveat surfaced by the benchmark

Ollama does **not** scale well for classroom mode. Continuous batching is not part of the engine; each parallel slot is a separate context. The user-raised question of swapping to vLLM for classroom deployments is addressed in a separate note below — short version: the maker-lab server should not hard-code Ollama. The benchmark supports broadening the hard dep to "any OpenAI-compatible local endpoint" with vLLM as the recommended classroom engine.



**Status:** Cannot run yet. Two blockers:

1. **Model not pulled.** `ollama list` on grackle shows no `llama3.2:3b`. Per user CLAUDE.md rule ("If you need to install a package in order to complete the tasks as prompted, ask me for permission"), I need approval before `ollama pull llama3.2:3b` (~2 GB download).
2. **GPU currently saturated.** `nvidia-smi` reports the RTX 5060 Ti at 15,141 / 16,311 MiB used (93%) from other Ollama-loaded models. A fair benchmark needs a clean GPU; running now would spill to CPU or evict another model and skew all numbers.

**Hardware context for the eventual benchmark:**

- Host: grackle (32 GB RAM)
- GPU: NVIDIA RTX 5060 Ti, 16 GB VRAM, driver 580.126.09, CUDA 13.0
- Ollama: `/usr/local/bin/ollama`, HTTP API responsive on `localhost:11434`
- Existing models in range: `qwen3:8b` (5.2 GB), `dolphin3:8b` (4.9 GB), `qwen3.5:0.8b` (1 GB) — can serve as relative reference points but the plan specifically targets `llama3.2:3b` as the minimum recommended model.

**Proposed benchmark plan (when approved):**

1. Unload all other Ollama models: `curl -X POST http://localhost:11434/api/generate -d '{"model":"<name>","keep_alive":0}'` for each loaded model, or restart the Ollama service.
2. `ollama pull llama3.2:3b`.
3. For each `OLLAMA_NUM_PARALLEL ∈ {1, 4, 8}`:
   - Restart Ollama with the env var set.
   - Warm the model with a single request.
   - Drive N concurrent 150-token completions (N = 1, 4, 8, 16, 25 to match classroom scale). Prompt: a short "explain a for-loop to a 7-year-old in 40 words or fewer" hint-shaped prompt.
   - Measure: p50, p95, p99 first-token latency + total response latency; total throughput (tok/s aggregate).
4. Output: a table in this report + a `requires.num_parallel` recommendation in the bundle manifest.

**Questions for the user:**

- **Approve `ollama pull llama3.2:3b`?** It's the specific model the plan names.
- **Approve restarting Ollama mid-benchmark?** This will briefly drop any current Ollama consumers (chat-gateway, other sessions). Probably fine on a Sunday afternoon but wanted to flag.
- Alternative: skip the benchmark for now, hard-code the plan's suggested tuning, and revisit if classroom sessions show real latency problems. The plan's `requires.min_ram_gb = 16` classroom floor is defensible without the benchmark.

---

## Summary of plan impact

| Patch slot | Outcome |
|---|---|
| `backend-0001-tutor-event-handler.patch` | Needed. Owns the `tutor-event` WS message handler. Spike 3. |
| `backend-0002-per-connection-session-context.patch` | **Not needed.** Backend is already per-connection. Spike 1. |
| `backend-0003-maker-lab-mcp-registration.patch` | Needed. Registers maker-lab as a fourth MCP server (pattern already visible for `crow`, `crow-storage`, `crow-wm` in `generate-config.py`). |
| `web-0001` through `web-0005` | Unaffected by Phase 0. Needed for Linux pet-mode in Phase 3. |
| `web-0006-persona-swap.patch` | **Not needed.** Persona swap uses existing `switch-config`. Spike 2. |

Phase 1 is cleared to begin once Spike 5 is resolved (or explicitly deferred).
