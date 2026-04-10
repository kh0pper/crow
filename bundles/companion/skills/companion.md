---
name: companion
description: AI Companion with voice interaction and animated avatar
triggers: ["companion", "avatar", "talk to crow", "voice chat", "vtuber"]
tools: []
---

# AI Companion

## When to Activate
- User asks to talk to their companion or avatar
- User wants voice-based conversation
- User mentions the VTuber or animated assistant

## How It Works
The AI Companion runs as a separate web app powered by Open-LLM-VTuber. It provides:
- **Voice interaction**: Speak to Crow and hear responses via Edge TTS
- **Animated avatar**: Live2D character with emotion expressions
- **Provider switching**: Switch between AI providers configured in Crow's AI Profiles

## Access
Open the companion at the AI Companion tile in the Crow's Nest, or visit:
`https://<your-tailscale-hostname>:12393`

## Settings (in the companion web UI)
- **WebSocket URL**: Must use `wss://` (Tailscale HTTPS) for microphone access
- **Base URL**: Same Tailscale HTTPS hostname
- **Character presets**: Switch providers from Settings > General

## Background Generation (requires SDXL extension)
Install the **SDXL Background Generator** extension to enable AI-generated backgrounds:
- **crow_generate_background**: Generate a new background from a text prompt (e.g. "cozy library at night")
- **crow_list_backgrounds**: Browse previously generated backgrounds
- **crow_set_background**: Set a gallery image as the current background
The background updates automatically in the companion UI within 5 seconds. Requires an NVIDIA GPU.

## Configuration
- LLM providers are auto-configured from Crow's AI Profiles
- TTS voice can be changed via the `COMPANION_TTS_VOICE` env var
- Persona prompt via `COMPANION_PERSONA` env var
