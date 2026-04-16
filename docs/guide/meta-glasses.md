---
title: Meta Glasses
---

# Meta Glasses (Ray-Ban Meta Gen 2)

Pair your **Meta Ray-Ban (Gen 2)** smart glasses with your Crow installation
and drive them with your own BYOAI. Voice turns captured on the glasses flow
through the Crow Android app → your configured STT → AI → TTS profiles →
back to the glasses' speakers.

No firmware jailbreak. No reverse engineering. The integration uses Meta's
official [**Wearables Device Access Toolkit**](https://wearables.developer.meta.com/docs)
(DAT), which gives a companion Android app camera + audio access to paired
glasses via a supported SDK.

## Compatibility

| Model | Released | Supported |
|---|---|---|
| Ray-Ban Meta (Gen 2 / AR1) | 2023 | ✅ |
| Ray-Ban Stories (Gen 1) | 2021 | ❌ — DAT does not expose the required primitives |

You'll also need:

- **Crow gateway** running (any platform)
- **Crow Android app 1.4.0+** on a phone running Android 14 (API 34) or newer
- One **STT profile** (`Settings → Speech-to-Text`)
- One **AI profile** (`Settings → AI Profiles`)
- One **TTS profile** (`Settings → Text-to-Speech`)
- Your glasses already paired to the phone in the Meta AI companion app

## Architecture

```
  ┌───────────────────────────┐
  │  Ray-Ban Meta (Gen 2)     │
  │  mic / speaker / camera   │
  └──────────┬────────────────┘
             │  DAT (camera) + standard BT A2DP/HFP (audio)
  ┌──────────▼────────────────┐
  │  Crow Android app          │
  │   GlassesService (fg svc) │  ←— maintains /session WebSocket
  │   PairingActivity         │
  └──────────┬────────────────┘
             │  WSS + HTTPS (Tailscale-friendly)
  ┌──────────▼────────────────┐
  │  Crow gateway             │
  │   bundles/meta-glasses/   │  ←— REST + WebSocket routes
  │   ai/stt/ (platform)      │
  │   ai/provider.js (BYOAI)  │
  │   ai/tts/ (platform)      │
  └───────────────────────────┘
```

## Setup (step-by-step)

### 1. Configure your profiles

If you've never set these up, do them first — pairing won't be useful
until the pipeline has somewhere to send audio.

**Speech-to-Text** — Open `Settings → Speech-to-Text` and add a profile.
For voice turns to feel responsive, prefer:

- **Groq Whisper** (`whisper-large-v3-turbo`) — fastest cloud option
- **Deepgram** (`nova-3`) — only true streaming option (partial transcripts)
- **faster-whisper** on your grackle / local GPU — fully local

**AI Profiles (BYOAI)** — You already have this if you've used Crow's
Messages feature. The glasses will use your default AI profile unless you
override per-device.

**Text-to-Speech** — Open `Settings → Text-to-Speech` and pick a provider.

- **OpenAI TTS** (`tts-1`) — good quality, ~200 ms first chunk
- **ElevenLabs** — highest quality, billed per character
- **Piper** on your grackle — free, fast, all-local
- **Kokoro** on your grackle — higher quality than Piper, still local

### 2. Install the Meta Glasses bundle

From the Crow dashboard: **Extensions → Meta Glasses → Install**. The
bundle is small — it ships no Docker services, just the MCP server + panel
+ REST routes.

### 3. Install the Crow Android app 1.4.0+

Sideload the latest APK from the Crow releases page on your phone.
Play Store distribution is gated on Meta's DAT GA.

On first launch:

- Accept the **Bluetooth** and **Camera** permissions (required for glasses pairing)
- Accept the **Connected device** foreground service notification
- If your phone is a Samsung, Xiaomi, OnePlus, or Huawei — disable
  battery optimization for the Crow app (OEMs aggressively kill
  connected-device foreground services by default)

### 4. Pair your glasses

- Open the Crow app. Navigate to **Meta Glasses**.
- Tap **Pair new glasses**. The app opens Meta's DAT pairing sheet.
- Confirm on your glasses when prompted.

On success the app:

- Receives a device handle from DAT
- Registers the device with your Crow gateway (`POST /api/meta-glasses/pair`)
- Receives a bearer token and stores it in encrypted SharedPreferences
- Starts the foreground `GlassesService`, which opens a WebSocket to
  `wss://.../api/meta-glasses/session?device_id=X`

You should see a pulsing dot next to your glasses' name in the Meta
Glasses dashboard page when the session is live.

### 5. Take your first voice turn

Default trigger is an in-app push-to-talk button (DAT does not expose the
glasses' physical capture button to third-party apps as of this writing).

- Tap and hold the PTT button in the Crow Android app.
- Speak.
- Release.

Your voice is streamed as PCM over the WebSocket. The gateway runs it
through STT, sends the transcript to your AI profile, streams the reply
through TTS, and plays it back through the glasses' speakers.

Expect first audible reply in **1.5–3 seconds** depending on your STT +
AI + TTS latency. Groq Whisper + a fast chat model + OpenAI TTS lands
near 1.5 s.

## Using the glasses

### Ask a question

Press the PTT button. *"What's on my calendar tomorrow?"* The Crow agent
tools (calendar, memory, etc.) are available to the chat profile, so the
glasses can reach anything Crow can.

### "Look at this" (vision)

Tap the photo-capture button in the app. The glasses capture a photo via
DAT, upload it to Crow's S3 storage, and attach it as an image URL to
your next chat turn. Any vision-capable AI profile (`gpt-4o`,
`claude-sonnet-4`, `gemini-2.5-flash`, `llama-4-vision`) will see it.

### Push a line to speak

From the Meta Glasses dashboard page, use the **Developer tools → Say**
input. Useful for scripts that want to notify you through the glasses.

```bash
curl -X POST http://localhost:3000/api/meta-glasses/say \
  -H 'Content-Type: application/json' \
  --cookie "$CROW_COOKIE" \
  -d '{"text":"Reminder: stand up"}'
```

### Play music ("hands-free" Funkwhale)

If you've installed the [Funkwhale bundle](/platforms/openclaw#funkwhale)
and configured shared MinIO/S3 storage, the glasses can play your library
through their bone-conduction speakers without ever pulling out your phone.

Install + configure once:

1. Add MinIO config in **Settings → Multi-Instance → Shared Storage** (one
   endpoint, applies to every paired Crow instance).
2. Install the Funkwhale bundle from Extensions. The gateway auto-injects
   `AWS_*` credentials into Funkwhale's container, so audio uploads land
   on shared MinIO instead of local disk.
3. Set `PROXY_MEDIA=False` in `~/.crow/bundles/funkwhale/.env` (already
   the install default for new shared-storage installs) so Funkwhale
   redirects to S3 presigned URLs instead of nginx X-Accel.
4. Mint a personal access token in Funkwhale's web UI
   (Settings → Your applications → Register one, scopes
   `read write read:libraries read:listenings`), drop it into
   `~/crow/.env` as `FUNKWHALE_ACCESS_TOKEN`, restart the gateway.

Then say:

> "Play *Comfy in Nautica* by Panda Bear from my library."

The chain runs entirely server-side — `fw_search` → `fw_play(track_uuid)`
→ Funkwhale 302 to a presigned MinIO URL → gateway fetches with
`Authorization: Bearer <token>` (token never leaves the server) → binary
frames over the device WebSocket → Android `MediaCodec` decodes →
`musicTrack` `AudioTrack` plays through the glasses speakers.

**TTS ducking** is automatic: ask Crow a question mid-playback, the music
volume drops to 0.25 while Crow speaks, returns to 1.0 on drain. Chained
TTS messages don't un-duck mid-utterance (per-device `pendingTtsDucks`
counter).

The same `_audio_stream` envelope works for any future audio producer —
podcast bundles, TTS narration of long-form articles, etc. — just emit
`{ _audio_stream: { url, codec, auth: "<sentinel>" } }` from your tool.

```bash
# Operator-direct push for diagnostics:
curl -X POST http://localhost:3000/api/meta-glasses/stream \
  -H 'Content-Type: application/json' \
  --cookie "$CROW_COOKIE" \
  -d '{"device_id":"<id>","url":"https://...mp3","codec":"mp3"}'
```

## Household profiles

If you share your Crow with family, pair each person's glasses separately
and associate each with a Companion **household profile**. That way each
member's glasses get their own voice (TTS profile override), persona, and
memory scope.

On the Meta Glasses panel, click **Edit** next to a paired device and
pick a household profile + per-device STT / AI / TTS overrides.

## Troubleshooting

**The "Pair new glasses" button is disabled.**
You're viewing the page in a browser instead of the Crow Android app, or
your app is older than 1.4.0. The compatibility banner at the top of the
page tells you which.

**"No active session" when I press the PTT button.**
The glasses are disconnected from the phone's Bluetooth. Reconnect them
in the Meta AI companion app, then return to Crow.

**First audible reply > 5 seconds.**
Check your STT profile. OpenAI Whisper adds ~1 s over Groq, and
self-hosted whisper.cpp on CPU can easily add 2–4 s. Also make sure your
TTS profile streams (OpenAI TTS, ElevenLabs, Kokoro do; Edge TTS returns
a single buffer).

**The wake-word setting keeps mis-triggering.**
Disable it. Bluetooth SCO audio is narrowband (16 kHz with codec
artifacts) and wake-word accuracy suffers significantly. Push-to-talk
remains the reliable default.

**The Crow Android app keeps getting killed in the background.**
Your OEM's battery manager is aggressive. Disable battery optimization
for the Crow app and allow it to run in the background unrestricted.

## API reference (dashboardAuth-gated)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/meta-glasses/devices` | List paired devices (tokens redacted) |
| `POST` | `/api/meta-glasses/pair` | Pair a device, returns `{device, token}` once |
| `DELETE` | `/api/meta-glasses/devices/:id` | Unpair |
| `POST` | `/api/meta-glasses/devices/:id` | Update per-device profile overrides |
| `POST` | `/api/meta-glasses/say` | TTS to all or one active session |
| `GET` | `wss://.../api/meta-glasses/session` | Per-device audio/control WebSocket |

The `/session` protocol is documented in the bundle's `README.md`.

## Related guides

- [AI Providers (BYOAI)](/guide/ai-providers)
- Speech-to-Text settings live at `Settings → Speech-to-Text` in your Crow dashboard
- Text-to-Speech settings live at `Settings → Text-to-Speech` in your Crow dashboard
- The **Companion** bundle shares the same TTS profiles — if you already have Companion voices configured, the glasses can use them verbatim

## Licensing & legal

- The **Meta Wearables Device Access Toolkit** is distributed by Meta
  under their developer terms; accept them in the DAT SDK's licensing
  flow when you enable the preview on your Meta developer account.
- This bundle ships no DAT code itself — the Android app depends on
  Meta's published Maven artifacts (`com.meta.wearables:mwdat-*`).
- Ray-Ban Meta firmware is owned by Meta; this integration uses only
  supported SDK surfaces.
