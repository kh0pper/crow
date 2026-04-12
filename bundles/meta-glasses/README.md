# meta-glasses

A Crow bundle that pairs **Meta Ray-Ban (Gen 2)** smart glasses with your
Crow BYOAI stack. Audio turns captured on the glasses flow through the
Crow Android app (1.4.0+) to your configured STT profile → AI profile →
TTS profile, and the synthesized answer plays back through the glasses'
speakers.

The glasses are driven via Meta's official
**[Wearables Device Access Toolkit](https://wearables.developer.meta.com/docs)**
(DAT). No firmware jailbreaks or reverse engineering are required.

## Status

- Gen 2 (Ray-Ban Meta, 2023) ✅ supported
- Gen 1 (Ray-Ban Stories, 2021) ❌ not supported — DAT does not expose
  the primitives we need on Gen 1 hardware

## Requirements

- Crow gateway on any platform
- Crow Android app **1.4.0+** on a phone that supports
  `FOREGROUND_SERVICE_CONNECTED_DEVICE` (Android 14 / API 34+)
- At least one configured STT profile (`Settings → Speech-to-Text`)
- At least one configured AI profile (`Settings → AI Profiles`)
- At least one configured TTS profile (`Settings → Text-to-Speech`)
- A Meta Ray-Ban (Gen 2) pair running the current firmware and already
  paired to the phone in the Meta AI companion app

## Pairing flow (end-to-end)

1. Install this bundle from the Crow Extensions page.
2. Open **Meta Glasses** in the Crow dashboard. If you haven't set up the
   three profiles yet, the panel will link you to them.
3. Open the Crow Android app on your phone. Tap the **Pair Glasses**
   button (it becomes available once the app sees this bundle installed).
4. The Android app opens the DAT pairing sheet; confirm on your glasses.
5. On success, the app POSTs the device handle to
   `/api/meta-glasses/pair`, receives a bearer token, and stores it in
   encrypted SharedPreferences.
6. From that moment on, the Android foreground service (`GlassesService`)
   maintains a WebSocket to `wss://.../api/meta-glasses/session?device_id=X`
   with `Authorization: Bearer <token>`, and each voice turn flows through
   the pipeline described above.

## API surface (REST, dashboardAuth-gated under `/api/meta-glasses`)

- `GET /devices` — list paired devices (no tokens in response)
- `POST /pair` — `{id, name?, generation?, stt_profile_id?, ai_profile_slug?, tts_profile_id?}` → `{device, token}`
- `DELETE /devices/:id` — unpair
- `POST /devices/:id` — update profile overrides
- `POST /say` — `{text, device_id?}` → TTS to active sessions

## WebSocket protocol (`/api/meta-glasses/session`)

Auth: `Authorization: Bearer <token>` header **or** `?token=<...>` query
param. Device id in `?device_id=<...>`.

### Client → server

- Text: `{"type":"hello","codec":"opus"|"pcm","sample_rate":16000}`
- Text: `{"type":"turn_start","trigger":"button"|"wakeword"|"vad"}`
- Binary: audio frames (during a turn). Opus preferred.
- Text: `{"type":"turn_end"}`

### Server → client

- Text: `{"type":"ready","session_id":"..."}`
- Text: `{"type":"transcript_partial","text":"..."}` / `"transcript_final"`
- Text: `{"type":"llm_delta","text":"..."}` (optional)
- Text: `{"type":"tts_start","codec":"mp3","sample_rate":24000}`
- Binary: TTS audio chunks
- Text: `{"type":"tts_end"}`
- Text: `{"type":"error","code":"...","recoverable":true|false,"message":"..."}`

Heartbeat: server pings every 15s; close idle sockets after ~60s idle.

## Compatibility

The bundle's panel inspects the dashboard's `User-Agent` for a
`CrowAndroid/<ver>` token. If absent or the version is below 1.4.0, the
pairing button is disabled and a warning banner tells the user what to do.

## Troubleshooting

- **"No active session" when pressing the in-app button** — the glasses
  are likely disconnected from the phone's Bluetooth. Reconnect via the
  Meta AI app first, then re-open the Crow app.
- **First audible reply > 3 seconds** — check your STT provider's latency.
  Groq Whisper and Deepgram are the best in this deployment; OpenAI
  Whisper typically adds ~1s over Groq.
- **Wake-word constantly mis-firing** — disable it in the Crow Android
  app's glasses settings; BT SCO audio is narrowband and degrades
  detection. Push-to-talk is more reliable.

## License

Same as Crow.
