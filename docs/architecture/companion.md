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
- **forwards `messages` + `tools` verbatim** and pipes the upstream SSE back, so OLVV's tool loop, `tool_call_status`, and streaming are untouched;
- disables visible chain-of-thought on the fast route (`chat_template_kwargs.enable_thinking=false`) so the avatar doesn't speak its reasoning; escalation keeps reasoning for agentic work;
- runs globally (not per device): OLVV's `base_url` is fixed per container, so **the model pair is shared across every device on one companion container**.

`generate-config.py` points OLVV's `base_url` at the router when `COMPANION_PROXY_URL` is set (default `http://localhost:3001/llm/v1`); unset it to talk to a model directly.

## Models: fast voice, escalate for agentic work

| Role | Provider / model | Engine | Notes |
|------|------------------|--------|-------|
| Fast voice (default) | `crow-voice/qwen3.5-4b` (`:8011`) | vLLM-ROCm | Text-only. Qwen3.5-4B is natively vision-language, but its ViT encoder OOMs (256 GiB) under vLLM-ROCm multimodal profiling on gfx1151, so image/video input is disabled (`--limit-mm-per-prompt`). Registered `alwaysResident` with **no mutex group** so it co-resides with the 35B and can never evict it. |
| Escalation (agentic) | `crow-chat/qwen3.6-35b-a3b` (`:8003`) | llama.cpp Vulkan | The daily-driver MoE; **multimodal** (mmproj). Vision-bearing turns escalate here (or to `grackle-vision`). |

Vision on this node is served by the multimodal 35B (stable on Vulkan) and the on-demand `grackle-vision` model — **not** by the fast 4B — so a text-only fast model loses no capability; image turns simply escalate. See [GPU orchestration](/architecture/gateway) for the `mutexGroup` eviction model.

### Three model registries

The companion resolves models through `servers/gateway/ai/resolve-profile.js` (`resolveProviderConfig`), which is **DB-`providers`-first with `models.json` fallback** — register a model in both. This is distinct from the pi bridge (`~/.pi/agent/models.json`) and the orchestrator (`models.json`).

## Binding a bot (the companion channel)

A companion **device** (a kiosk tablet / room display) binds to a Bot Builder agent exactly like a Meta Glasses device: the device record (`device-store.js`, tagged `device_kind:"companion"`) carries `bound_bot_id`, and the kiosk shows that bot's persona/avatar plus the per-device `companion_features` toggles. Configure it in the bot's **Gateways** tab (type *AI Companion*). The model pair is global (the gateway's `/llm/v1` router); per-device variation is persona/avatar/voice/features only. See [kiosk mode](/guide/kiosk-mode).

### `companion_features` semantics

The Gateways tab's *AI Companion* checkboxes/fields aren't uniform — each is wired at a different layer:

| Feature | Layer | Default | Effect |
|---------|-------|---------|--------|
| `social_chat` | runtime | off | `crow-device-config.js` hides the `#crow-voice-panel` (voice/peer) panel unless `true`. |
| `avatar_model` | config-gen | bot's configured avatar, else the default | `generate-config.py` picks the Live2D model for the bot's character preset. |
| `memory_integration` | config-gen | **off — per-bot opt-in** | `true` adds the `crow` router bridge (memory/projects/blog/sharing category tools) to that bot's `mcp_enabled_servers` (`bot_mcp_servers()` in `generate-config.py`). Off by default: a shared kiosk's default character must not search the owner's memory store unless deliberately enabled. Household mode (below) overrides this globally regardless of any bot's own setting. |
| `face_tracking` | runtime | **on** (only `=== false` disables) | An availability gate, not an opt-in: `false` hides the `#crow-face-tracking-toggle` button, blocks `toggle()` from opening the camera, and — because features load via an async fetch that a click can beat — tears down an already-running camera/tracking loop the moment the `false` flag arrives (`crow-face-tracking.js` + `crow-device-config.js`). |
| `hearing_style` / `voice_idle_timeout` | device-config plumbing | `push_to_talk` / 30s | Set in the bot's Gateways tab (`gw_hearing_style`, `gw_voice_idle_timeout`), stored on the gateway row, passed through to the device config. |
| `pet_mode` / `avatar_animation` | stored | pet off / animation on | `crow-device-config.js` reflects both as `data-crow-pet` / `data-crow-anim` attributes; the values are stored and applied as attributes today, but the kiosk-side pet-mode behavior they're meant to drive hasn't been verified end-to-end on a real kiosk yet. |

`proactive_speak_prompt` was considered but removed — no trigger ever fired it, so it shipped as dead config.

### Household profiles

Household profiles are a **separate, global** mechanism from per-bot features: multiple named users (up to 9), each with their own avatar and TTS voice, sharing one companion container/kiosk. They're configured in **Settings → Companion → Household** (`bundles/companion/settings-section.js`), not per bot, via `COMPANION_PROFILE_N_NAME` / `_AVATAR` / `_TTS_PROFILE_ID` / `_TTS_VOICE` env vars, read by `get_household_profiles()` in `generate-config.py`. Each profile becomes its own OLVV character (`crow_profile_<slug>`) whose persona is auto-appended with per-user memory-scoping instructions (tag `profile:<slug>` on store/search, don't read other members' memories without being asked).

Defining any household profile flips a **global** switch: `global_mcp_servers()` enables the `crow` memory bridge for the default character regardless of any individual bot's `memory_integration` toggle, because household personas already carry their own per-profile memory scoping in the prompt. Env var changes require a container restart to take effect — `generate-config.py` runs once at container start, it isn't hot-reloaded.

### MCP bridges

Every companion character gets `crow-wm` (window manager) and `crow-storage` (uploads) unconditionally — those are always in `mcp_enabled_servers`. The `crow` bridge (router category tools, including memory/projects/blog/sharing) is opt-in, gated two ways:

- **Per bot**: only when that bot's `memory_integration` feature is `true`. The bot's character preset gets a minimal `agent_config` override with `crow` added to `mcp_enabled_servers`, emitted only when it differs from the global default.
- **Globally**: when household profiles are defined, every character (not just opted-in bots) gets `crow`.

The privacy rationale is the same in both cases: a shared kiosk's default character must not be able to search the owner's memory store just by virtue of running on Crow's infrastructure — either a bot must be deliberately opted in, or the household-profile persona must carry its own per-user memory scoping.

## Troubleshooting

- **"error calling the chat endpoint…"** — the generated `conf.yaml` is pointing OLVV at an endpoint that rejects the request. Check `docker logs crow-companion` for the upstream error. Common causes: a cloud profile rejecting an empty `tools: []` array (use a local model, which tolerates it), or the MCP bridge failing so no tools load. The bridge targets the gateway's MCP mounts (`/router`, `/storage`, `/wm`) on `CROW_MCP_BRIDGE_PORT` (default `3001`); `/router`, `/storage`, and `/wm` all require a local MCP token (generate it in the dashboard's Connect panel; `generate-config.py` reads it from the `CROW_LOCAL_MCP_TOKEN` env var and embeds it in `mcp_servers.json` — unset, the bridges get 401s).
- **Avatar speaks its reasoning** — ensure the fast route disables thinking (`COMPANION_FAST_DISABLE_THINKING=1`, the default).
- **Window/media commands do nothing** — the `crow_wm` MCP bridge isn't connected; verify `ToolManager initialized with N OpenAI tools` (N>0) in the container logs.

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
| `servers/gateway/dashboard/panels/bot-builder/editor.js` | the Gateways-tab UI for `companion_features` (memory integration, face tracking, hearing style, etc.) |
