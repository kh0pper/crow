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

## Federation — Opening apps on paired instances (Phase 3)

When the kiosk host has trusted paired Crow instances, the companion's
window-manager tools accept an optional `instance` parameter. Setting it to
a trusted instance id rewrites the app URL to target that peer instead of
the local host.

**Registry**: the kiosk fetches `/dashboard/federation/companion-overview`
on startup and every 60 seconds. The registry is available at
`window.CrowWM.federation` as
`{ local: {static, bundles}, peers: { <id>: {name, hostname, status, tiles} } }`.
Peers with `status !== "ok"` are not launchable — their apps appear in the
registry but `urlForPeerApp()` returns null for them.

**Tool payload extension**: `crow_wm` tool results gain an optional
`instance` field. When set:
- `"local"` (default) — open on the kiosk host, unchanged behavior.
- `<instance-id>` — rewrite `data.url` to the peer's native URL using
  `https://<peer-hostname>[:port]<pathname>` from the federation cache.
  Falls back to local-host URL construction if the peer is offline or the
  app isn't in its tile list.

**Name resolution rules** (apply BEFORE emitting the tool result):
- If the user names an instance explicitly ("open Jellyfin on crow"),
  resolve the name to an id. If two peers share the same name, ask the
  user to disambiguate — do not silently pick one.
- If only one peer hosts the requested app (single-peer bundle like
  "Jellyfin" on crow), auto-target that instance.
- If multiple peers host the same app (both grackle and crow have
  Navidrome), default to local and offer a choice.
- If the user asks for an app that only exists on a peer, auto-target
  that peer.
- If the target peer is offline (`status !== "ok"`), say "crow is offline;
  I can't open Jellyfin right now" rather than falling back silently.

**Peer tokens never leave the gateway.** The kiosk's browser JS only sees
the sanitized overview JSON — never raw signing keys.

**Rollback**: setting `CROW_UNIFIED_DASHBOARD=0` unmounts the federation
endpoint; the WM's fetch fails silently and the registry stays empty, so
the `instance` parameter becomes a no-op.
