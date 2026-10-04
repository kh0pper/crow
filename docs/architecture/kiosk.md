# Kiosk display

A paired browser — a phone today, a Raspberry Pi 3 with a 7" touchscreen next — shows your Ramble bird and talks with the Crow assistant you bind to it. Crow does all the work: speech-to-text, the assistant's turn, text-to-speech. The browser only captures audio after a tap and plays the reply.

**Design:** `docs/superpowers/specs/2026-10-03-crow-kiosk-companion-design.md`. **K1 plan:** `docs/superpowers/plans/2026-10-03-kiosk-k1-page-and-voice.md`.

## Pieces
- `bundles/kiosk/` — the bundle: page (`public/`), routes + WebSocket (`server/runtime.js`, `server/session.js`), pairing (`server/pairing.js`), windows (`server/wm.js`), MCP tools (`server/server.js`), dashboard panel (`panel/kiosk.js`).
- `servers/gateway/voice/turn.js` — the transport-free voice turn (bound bot, routing with an 8 s cold fallback, think gate, barge-in, memory stripped by default).
- `servers/shared/device-store.js` — paired devices (`device_kind: kiosk`), token hashes only.

## Network and auth
- Tailnet only: `https://<host>:8444/display`. Never Funnel (`/display`, `/api/kiosk` are not public prefixes; the router and the WebSocket upgrade also refuse a Funnel header).
- Pairing: the display shows a 6-digit code; an owner approves it in **Kiosk → Pair a display** and picks the assistant. The display collects its token once with a poll secret.
- The device token is accepted only in the session's first `hello` frame — never in a URL, never by any other route.
- MCP tools reach live sessions through loopback-only `/api/kiosk/internal/*` with `$CROW_HOME/kiosk-announce-token`.

- The page is served at `/display`, not `/kiosk`, because the installed maker-lab bundle owns `/kiosk/*`. The API stays under `/api/kiosk/*` and the dashboard panel at `/dashboard/kiosk`.

## Voice services
- Speech-to-text: the Faster-Whisper bundle (loopback :8004); the kiosk adds a `distil-small.en` profile at first pairing. Each display can switch to the faster, less accurate `tiny.en` (Speech model) and set its end-of-speech wait (300–900 ms, default 450). Crow warms the display's speech model at gateway start, on connect, and after a settings change, so the first question is not slow.
- Voice: the Kokoro TTS bundle (loopback :8880) when installed.

## Privacy
- Nothing is sent before a tap. No audio is stored; transcripts live only in the display's short in-memory conversation (15 min).
- Memories are off by default on a display (`memory_integration`).
