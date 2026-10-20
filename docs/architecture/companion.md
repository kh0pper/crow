---
title: AI Companion Architecture
---

# AI Companion

The AI Companion is Crow's voice-and-avatar front end — an animated [Live2D](https://www.live2d.com/) character with speech in/out, running the [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) (OLVV) engine in the `crow-companion` Docker container (port `12393`). It is the surface behind [kiosk mode](/guide/kiosk-mode) and is bound to a [Bot Builder](/architecture/bot-builder) agent, making it the companion **channel** alongside Gmail, Discord, and Meta Glasses.

## Design: OLVV keeps its loop; the gateway chooses the model

Unlike the email/Discord channels (which route turns through the pi runtime in `bridge.mjs`), the companion **keeps OLVV's own LLM loop**. That loop already does three things the companion depends on:

- **MCP tools** — OLVV connects to the gateway's MCP bridges and runs the tool calls itself.
- **Client-side window manager** — `crow_wm_open` / `crow_wm_media` are MCP tools whose *effect* is delivered by `crow-wm.js` (injected into OLVV's browser) listening for `tool_call_status` events that **OLVV's loop emits**. Routing turns through pi would break voice-driven window/media control.
- **Token streaming** — OLVV streams the response into TTS sentence-by-sentence.

So instead of replacing the loop, OLVV's `base_url` points at the gateway's in-process **`/llm/v1` router**, which only chooses *which local model answers*:

```
Voice/text → OLVV (STT · LLM loop · MCP tools · Live2D · TTS)
   OLVV base_url → gateway /llm/v1 router (http://localhost:3001/llm/v1)   [global, no device scope]
        forwards messages + tools verbatim · pipes the SSE stream straight back
        per turn:  qwen3.5-4b (fast)  --leading "!escalate"-->  qwen3.6-35b-a3b
   OLVV runs the tool loop → emits tool_call_status → crow-wm.js opens windows
```

Model routing runs in-process in the gateway: `servers/gateway/routes/llm-router.js` serves `/llm/v1` (OpenAI-compatible), routing each turn fast-model-first with `!escalate` escalation. The companion container reaches it via `COMPANION_PROXY_URL` (default `http://localhost:3001/llm/v1`, see `bundles/companion/docker-compose.yml`). The router:

- exposes `/llm/v1/chat/completions` and `/llm/v1/models`, OpenAI-compatible;
- routes each turn to the **fast** model by default, switching to the **escalation** model when the latest user message begins with `!escalate` (the token is stripped before forwarding);
- **forwards `messages` + `tools` verbatim** and pipes the upstream SSE back, so OLVV's tool loop, `tool_call_status`, and streaming are untouched — with one addition: a request naming the companion's own model id, `crow-companion` (what `generate-config.py` sends), gets a `[Now]` line (server time zone) on its latest user message every turn, plus a `[Dates]` line (the next week's dates by weekday) when the user names a day like "Monday" or "tomorrow". The system prompt and earlier messages are never changed, and an echo of those lines is stripped from the reply (`servers/gateway/voice/sse-echo.js`). `COMPANION_TURN_CONTEXT=0` on the gateway turns this off. An existing install keeps its old generated model id until **Restart** on the Extensions page rebuilds the image (`up -d --build`), and a custom `COMPANION_PROXY_MODEL` skips the feature;
- disables visible chain-of-thought on the fast route (`chat_template_kwargs.enable_thinking=false`) so the avatar doesn't speak its reasoning; escalation keeps reasoning for agentic work;
- runs globally (not per device): OLVV's `base_url` is fixed per container, so **the model pair is shared across every device on one companion container**.

`generate-config.py` points OLVV's `base_url` at the router when `COMPANION_PROXY_URL` is set (default `http://localhost:3001/llm/v1`); unset it to talk to a model directly.

## Models: fast voice, escalate for agentic work

| Role | Provider / model | Engine | Notes |
|------|------------------|--------|-------|
| Fast voice (default) | `crow-voice/qwen3.5-4b` (`:8011`) | vLLM-ROCm | Text-only. Qwen3.5-4B is natively vision-language, but its ViT encoder OOMs (256 GiB) under vLLM-ROCm multimodal profiling on gfx1151, so image/video input is disabled (`--limit-mm-per-prompt`). Registered `alwaysResident` with **no mutex group** so it co-resides with the 35B and can never evict it. |
| Escalation (agentic) | `crow-chat/qwen3.6-35b-a3b` (`:8003`) | llama.cpp Vulkan | The daily-driver MoE; **multimodal** (mmproj). Vision-bearing turns escalate here. |

Vision routes through the smart-router's capability pick — the first enabled provider with an image-capable model, or (if none is tagged) the profile fallback, then crow-chat (on crow, the multimodal 35B) — **not** the fast 4B, so a text-only fast model loses no capability; image turns simply escalate. See [GPU orchestration](/architecture/gateway) for the `mutexGroup` eviction model.

### Three model registries

The companion resolves models through `servers/gateway/ai/resolve-profile.js` (`resolveProviderConfig`), which is **DB-`providers`-first with `models.json` fallback** — register a model in both. This is distinct from the pi bridge (`~/.pi/agent/models.json`) and the orchestrator (`models.json`).

## Binding a bot (the companion channel)

A companion **device** (a kiosk tablet / room display) binds to a Bot Builder agent exactly like a Meta Glasses device: the device record (`device-store.js`, tagged `device_kind:"companion"`) carries `bound_bot_id`, and the kiosk shows that bot's persona/avatar plus the per-device `companion_features` toggles. Configure it on the bot's **Basics** tab (channel *AI Companion*). The model pair is global (the gateway's `/llm/v1` router); per-device variation is persona/avatar/voice/features only. See [kiosk mode](/guide/kiosk-mode).

### `companion_features` semantics

The *AI Companion* channel's checkboxes/fields (Bot Builder → Basics) aren't uniform — each is wired at a different layer:

| Feature | Layer | Default | Effect |
|---------|-------|---------|--------|
| `social_chat` | runtime | off | `crow-device-config.js` hides the `#crow-voice-panel` (voice/peer) panel unless `true`. |
| `avatar_model` | config-gen | bot's configured avatar, else the default | `generate-config.py` picks the Live2D model for the bot's character preset. |
| `memory_integration` | config-gen | **off — per-bot opt-in** | `true` adds the `crow` router bridge (memory/projects/blog/sharing category tools) to that bot's `mcp_enabled_servers` (`bot_mcp_servers()` in `generate-config.py`). Off by default: a shared kiosk's default character must not search the owner's memory store unless deliberately enabled. Household mode (below) flips the global default to include `crow`, but a bot preset whose `memory_integration` is `false` or absent still gets a deep-merge override that strips `crow` back out — per-bot non-opt-in wins even in household mode. |
| `face_tracking` | runtime | **on** (only `=== false` disables) | An availability gate, not an opt-in: `false` hides the `#crow-face-tracking-toggle` button, blocks `toggle()` from opening the camera, and — because features load via an async fetch that a click can beat — tears down an already-running camera/tracking loop the moment the `false` flag arrives (`crow-face-tracking.js` + `crow-device-config.js`). |
| `hearing_style` / `voice_idle_timeout` | device-config plumbing (no consumer) | `push_to_talk` / 30s | No longer shown in the editor (nothing ever applied them). A value saved by an older editor is kept: the companion save merges into the stored features instead of replacing them. |
| `pet_mode` / `avatar_animation` | stored | pet off / animation on | `crow-device-config.js` reflects both as `data-crow-pet` / `data-crow-anim` attributes; the values are stored and applied as attributes today, but the kiosk-side pet-mode behavior they're meant to drive hasn't been verified end-to-end on a real kiosk yet. |

`proactive_speak_prompt` was considered but removed — no trigger ever fired it, so it shipped as dead config.

### Household profiles

Household profiles are a **separate, global** mechanism from per-bot features: multiple named users (up to 9), each with their own avatar and TTS voice, sharing one companion container/kiosk. They're configured in **Settings → Companion → Household** (`bundles/companion/settings-section.js`), not per bot, via `COMPANION_PROFILE_N_NAME` / `_AVATAR` / `_TTS_PROFILE_ID` / `_TTS_VOICE` env vars, read by `get_household_profiles()` in `generate-config.py`. Each profile becomes its own OLVV character (`crow_profile_<slug>`) whose persona is auto-appended with per-user memory-scoping instructions (tag `profile:<slug>` on store/search, don't read other members' memories without being asked).

Defining any household profile flips a **global** switch: `global_mcp_servers()` enables the `crow` memory bridge for the default character regardless of any individual bot's `memory_integration` toggle, because household personas already carry their own per-profile memory scoping in the prompt. Env var changes require a container restart to take effect — `generate-config.py` runs once at container start, it isn't hot-reloaded.

### MCP bridges

Every companion character gets `crow-wm` (window manager) and `crow-storage` (uploads) unconditionally — those are always in `mcp_enabled_servers`. The `crow` bridge (router category tools, including memory/projects/blog/sharing) is opt-in, gated two ways:

- **Per bot**: only when that bot's `memory_integration` feature is `true`. The bot's character preset gets a minimal `agent_config` override with `crow` added to `mcp_enabled_servers`, emitted only when it differs from the global default. When a bot's `memory_integration` is `false` or absent, its preset instead gets a deep-merge override that strips `crow` back out — this per-bot opt-out wins even in household mode.
- **Globally**: when household profiles are defined, the global/base config (the default character plus each household-profile character) gets `crow` — but that doesn't touch bot presets, which still follow the per-bot rule above.

The privacy rationale is the same in both cases: a shared kiosk's default character must not be able to search the owner's memory store just by virtue of running on Crow's infrastructure — either a bot must be deliberately opted in, or the household-profile persona must carry its own per-user memory scoping.

## Lifecycle: install, update, rebuild

The Companion builds its own image, so its installed copy (`CROW_HOME/bundles/companion/`) carries the build: `docker-compose.yml`, `Dockerfile`, `.dockerignore` and `scripts/`. Extensions and Settings run Compose there, like every other compose extension. A version bump re-copies those files (`refreshFiles` in the manifest; never `.env` or data) but restarts nothing.

- **Rebuild needed.** The scripts are copied into the image at build time, so a changed script needs a rebuild, not a restart. Every start from Extensions or Settings, and an install, passes a hash of the build inputs (the Dockerfile and the files it copies; `servers/gateway/bundle-build-inputs.js`), which the image carries as the `crow.build-inputs` label. When the running container's label differs from the installed files (or it has none: built by hand, or before 1.1.0), Extensions shows **Rebuild needed** and a **Rebuild** button. Rebuild, Start and Restart run `compose build` (an unchanged build is a cache hit) and then `up -d --no-build`, so the old container keeps running while the image builds. One start runs at a time per extension; Stop and Remove wait for it.
- **Settings saves** re-create the container through the same start path, with the install security check, and build only when the image is older than its build inputs (a persona edit never rebuilds). If the restart fails, the page says so (the settings are saved either way).
- **Names.** Compose sets `COMPOSE_PROJECT_NAME` while it reads the file: the primary's project `companion` keeps `crow-companion` as image and container name and `companion_companion-*` as volume names. A second instance sets `COMPOSE_PROJECT_NAME=companion-<x>` in its `.env` and gets its own names. Setting it on an existing install switches to new, empty `<x>_companion-*` volumes (the chat history stays in the old ones).

### What the container mounts

| Host | Container | Why |
|---|---|---|
| `companion-models`, `companion-cache`, `companion-history` volumes | `/app/models`, `/app/cache`, `/app/chat_history` | models, caches, chat history |
| `EIKANYA_MODELS_DIR` (default `./eikanya-models`), read-only | `/app/live2d-models/eikanya` | extra Live2D avatars. `CROW_HOME/live2d-models` is allowed read-only with the install consent. |
| this instance's `crow.db` (`CROW_DB_PATH`, else `CROW_DATA_DIR`/`CROW_HOME` `data/crow.db`), read-only | `/crow-data/crow.db` | `generate-config.py` reads AI/TTS profiles, providers and bots; `notify-bridge.py` reads notifications |

The database mount is the whole file, read-only: the container can read every table (provider keys included) and can never write it. Only the main file is mounted, not the `-wal`, so the container reads the last checkpointed state; a change made seconds before a restart can be missing until the next checkpoint.

The container does **not** mount the extensions folder (it holds every extension's `.env`). When the Calls extension is on, `scripts/fetch-calls-scripts.sh` fetches its two browser scripts from the gateway (`/calls/scripts/`, served while `CROW_CALLS_ENABLED=1`) at start, waiting up to 60 s for a gateway that is still starting, and inlines them only when the answer is JavaScript. "On" means enabled: the gateway serves its own copy when Calls is enabled but not installed.

### Installs that ran from the repo checkout

An install from before 1.1.0 can have a container started from the repo's `bundles/companion/` (Compose label `com.docker.compose.project.working_dir`), with an installed copy that has no compose file. After the 1.1.0 refresh the installed copy has one; the project name (`companion`) and volume names are the same, so Extensions finds the running container and a Rebuild re-creates it from the installed copy with the same volumes. The start path compares the two `.env` files first: while the container from the other folder exists and the files differ in any variable the compose file uses, Start, Rebuild and Settings refuse and name the variables (not their values). Copy the settings you want into the installed `.env`, then start (or, to keep the installed values, remove the old container with `docker rm` first). If Docker does not answer the container listing, the start is refused rather than guessed. From then on, start the Companion only from Extensions (or Compose in the installed folder), never from the repo checkout: that would put the container back on the repo's compose file and `.env`.

With a compose file in the installed folder, Extensions **Remove** stops and removes the container, and with "delete data" can also remove its volumes, chat history included.

## Troubleshooting

- **"error calling the chat endpoint…"** — the generated `conf.yaml` is pointing OLVV at an endpoint that rejects the request. Check `docker logs crow-companion` for the upstream error. Common causes: a cloud profile rejecting an empty `tools: []` array (use a local model, which tolerates it), or the MCP bridge failing so no tools load. The bridge targets the gateway's MCP mounts (`/router`, `/storage`, `/wm`) on `CROW_MCP_BRIDGE_PORT` (default `3001`); `/router`, `/storage`, and `/wm` all require a local MCP token (generate it in the dashboard's Connect panel; `generate-config.py` reads it from the `CROW_LOCAL_MCP_TOKEN` env var and embeds it in `mcp_servers.json` — unset, the bridges get 401s).
- **Avatar speaks its reasoning** — ensure the fast route disables thinking (`COMPANION_FAST_DISABLE_THINKING=1`, the default).
- **Window/media commands do nothing** — the `crow_wm` MCP bridge isn't connected; verify `ToolManager initialized with N OpenAI tools` (N>0) in the container logs.
- **Companion edits don't appear on paired instances** — expected: the companion container does not drive cross-instance sync. Its writes land through the gateway's MCP mounts, and only the primary gateway process (never a `--no-auth` companion/bridge gateway) opens the instance-sync feeds and emits changes. If gateway-side edits aren't syncing either, check `CROW_DISABLE_INSTANCE_SYNC` and the sync-conflicts page.

## Files

| Path | Role |
|------|------|
| `bundles/companion/` | OLVV container, `generate-config.py`, `crow-wm.js`, injectors |
| `servers/gateway/routes/llm-router.js` | in-process `/llm/v1` model-routing router (fast → escalate) |
| `bundles/vllm-rocm-qwen35-4b/` | the fast `crow-voice` model bundle |
| `bundles/meta-glasses/server/device-store.js` | device binding (`device_kind`, `companion_features`) |
| `bundles/companion/scripts/crow-device-config.js` | client-side: applies `companion_features` to the running kiosk (panel visibility, attributes, camera teardown) |
| `bundles/companion/scripts/crow-face-tracking.js` | camera-driven face tracking + the `face_tracking` availability gate |
| `bundles/companion/settings-section.js` | dashboard Settings → Companion, including Household profile slots |
| `servers/gateway/dashboard/panels/bot-builder.js` | the *AI Companion* gateway tab |
| `servers/gateway/dashboard/panels/bot-builder/tab-basics.js` | the Basics-tab channel UI for `companion_features` (memory integration, face tracking, etc.) |
