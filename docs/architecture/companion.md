---
title: AI Companion Architecture
---

# AI Companion

The AI Companion is Crow's voice-and-avatar front end — an animated [Live2D](https://www.live2d.com/) character with speech in/out, running the [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) (OLVV) engine in the `crow-companion` Docker container (port `12393`). It is the surface behind [kiosk mode](/guide/kiosk-mode) and is bound to a [Bot Builder](/architecture/bot-builder) agent, making it the companion **channel** alongside Gmail, Discord, and Meta Glasses.

## Design: OLVV keeps its loop; a proxy chooses the model

Unlike the email/Discord channels (which route turns through the pi runtime in `bridge.mjs`), the companion **keeps OLVV's own LLM loop**. That loop already does three things the companion depends on:

- **MCP tools** — OLVV connects to the gateway's MCP bridges and runs the tool calls itself.
- **Client-side window manager** — `crow_wm_open` / `crow_wm_media` are MCP tools whose *effect* is delivered by `crow-wm.js` (injected into OLVV's browser) listening for `tool_call_status` events that **OLVV's loop emits**. Routing turns through pi would break voice-driven window/media control.
- **Token streaming** — OLVV streams the response into TTS sentence-by-sentence.

So instead of replacing the loop, a thin **model-routing proxy** sits at OLVV's `base_url` and only chooses *which local model answers*:

```
Voice/text → OLVV (STT · LLM loop · MCP tools · Live2D · TTS)
   OLVV base_url → companion model-proxy (127.0.0.1:11435/v1)   [global, no device scope]
        forwards messages + tools verbatim · pipes the SSE stream straight back
        per turn:  qwen3.5-4b (fast)  --leading "!escalate"-->  qwen3.6-35b-a3b
   OLVV runs the tool loop → emits tool_call_status → crow-wm.js opens windows
```

The proxy (`scripts/companion/model-proxy.mjs`, `companion-model-proxy.service`):

- exposes `/v1/chat/completions` and `/v1/models` on loopback `:11435` (the container is `network_mode: host`, so `localhost` reaches it);
- routes each turn to the **fast** model by default, switching to the **escalation** model when the latest user message begins with `!escalate` (the token is stripped before forwarding);
- **forwards `messages` + `tools` verbatim** and pipes the upstream SSE back, so OLVV's tool loop, `tool_call_status`, and streaming are untouched;
- disables visible chain-of-thought on the fast route (`chat_template_kwargs.enable_thinking=false`) so the avatar doesn't speak its reasoning; escalation keeps reasoning for agentic work;
- runs globally (not per device): OLVV's `base_url` is fixed per container, so **the model pair is shared across every device on one companion container**.

`generate-config.py` points OLVV's `base_url` at the proxy when `COMPANION_PROXY_URL` is set (default `http://localhost:11435/v1`); unset it to talk to a model directly.

## Models: fast voice, escalate for agentic work

| Role | Provider / model | Engine | Notes |
|------|------------------|--------|-------|
| Fast voice (default) | `crow-voice/qwen3.5-4b` (`:8011`) | vLLM-ROCm | Text-only. Qwen3.5-4B is natively vision-language, but its ViT encoder OOMs (256 GiB) under vLLM-ROCm multimodal profiling on gfx1151, so image/video input is disabled (`--limit-mm-per-prompt`). Registered `alwaysResident` with **no mutex group** so it co-resides with the 35B and can never evict it. |
| Escalation (agentic) | `crow-chat/qwen3.6-35b-a3b` (`:8003`) | llama.cpp Vulkan | The daily-driver MoE; **multimodal** (mmproj). Vision-bearing turns escalate here (or to `grackle-vision`). |

Vision on this node is served by the multimodal 35B (stable on Vulkan) and the on-demand `grackle-vision` model — **not** by the fast 4B — so a text-only fast model loses no capability; image turns simply escalate. See [GPU orchestration](/architecture/gateway) for the `mutexGroup` eviction model.

### Three model registries

The companion resolves models through `servers/gateway/ai/resolve-profile.js` (`resolveProviderConfig`), which is **DB-`providers`-first with `models.json` fallback** — register a model in both. This is distinct from the pi bridge (`~/.pi/agent/models.json`) and the orchestrator (`models.json`).

## Binding a bot (the companion channel)

A companion **device** (a kiosk tablet / room display) binds to a Bot Builder agent exactly like a Meta Glasses device: the device record (`device-store.js`, tagged `device_kind:"companion"`) carries `bound_bot_id`, and the kiosk shows that bot's persona/avatar plus the per-device `companion_features` toggles. Configure it in the bot's **Gateways** tab (type *AI Companion*). The model pair is global (the proxy); per-device variation is persona/avatar/voice/features only. See [kiosk mode](/guide/kiosk-mode).

## Troubleshooting

- **"error calling the chat endpoint…"** — the generated `conf.yaml` is pointing OLVV at an endpoint that rejects the request. Check `docker logs crow-companion` for the upstream error. Common causes: a cloud profile rejecting an empty `tools: []` array (use a local model, which tolerates it), or the MCP bridge failing so no tools load. The bridge targets the gateway's MCP mounts (`/router`, `/storage`, `/wm`) on `CROW_MCP_BRIDGE_PORT` (default `3001`); `/router` and `/storage` need `CROW_LOCAL_MCP_TOKEN`, `/wm` is open.
- **Avatar speaks its reasoning** — ensure the fast route disables thinking (`COMPANION_FAST_DISABLE_THINKING=1`, the default).
- **Window/media commands do nothing** — the `crow_wm` MCP bridge isn't connected; verify `ToolManager initialized with N OpenAI tools` (N>0) in the container logs.

## Files

| Path | Role |
|------|------|
| `bundles/companion/` | OLVV container, `generate-config.py`, `crow-wm.js`, injectors |
| `scripts/companion/model-proxy.mjs` | model-routing proxy (fast → escalate) |
| `scripts/companion/companion-model-proxy.service` | systemd unit for the proxy |
| `bundles/vllm-rocm-qwen35-4b/` | the fast `crow-voice` model bundle |
| `bundles/meta-glasses/server/device-store.js` | device binding (`device_kind`, `companion_features`) |
| `servers/gateway/dashboard/panels/bot-builder.js` | the *AI Companion* gateway tab |
