# Kiosk display

A paired browser — a phone today, a Raspberry Pi 3 with a 7" touchscreen next — shows your Ramble bird and talks with the Crow assistant you bind to it. Crow does all the work: speech-to-text, the assistant's turn, text-to-speech. The browser only captures audio after a tap and plays the reply.

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

## Talk to Crow in the dashboard (session mode)
The Crow's Nest header bird opens the same page inside the dashboard, with no pairing: tap the bird and choose **Talk to Crow**, or press and hold the bird (a held Enter/Space on the focused bird does the same). It uses the microphone and speaker of the device you are on. The row and the long-press exist only while the Kiosk extension is installed.

- Page: `/display/session`; WebSocket: `/api/kiosk/session/dashboard`. Both sit behind the same network rule as the dashboard (never Funnel) **and** require the dashboard's own session cookie — the bundle mints no token for this. The page answers `401` without a session; the socket is refused before the upgrade.
- The socket handshake must come from this origin (`Sec-Fetch-Site: same-origin`, or an `Origin` that names the `Host` / `X-Forwarded-Host`), and its first `hello` frame must echo the `crow_csrf` cookie — the same double-submit rule as every dashboard POST. A reverse proxy in front of Crow must forward `Host` or `X-Forwarded-Host`.
- Nothing is stored: the display exists in memory for the life of the socket, under an id derived from a hash of the session. It is not a paired device, so it is not listed in **Kiosk**, cannot be announced to, and cannot be claimed by a device id. The login is re-checked at every question and once a minute; logging out closes the display. Its windows, timers and short conversation are dropped two minutes after the overlay closes.
- Assistant: the one chosen under **Kiosk → Talk to Crow in the dashboard**, else the first enabled assistant. It runs with the same tool limits as a paired display, and memories stay off. With no enabled assistant the page says so and links to the Kiosk panel.
- Closing (the close button, or Esc) stops the microphone and any audio at once and removes the frame.
- The page is framed by the dashboard only (`frame-ancestors 'self'`); the paired page at `/display` still refuses all framing.

## Voice services
- Speech-to-text: the Faster-Whisper bundle (loopback :8004); the kiosk adds a `distil-small.en` profile at first pairing. Each display can switch to the faster, less accurate `tiny.en` (Speech model) and set its end-of-speech wait (300–900 ms, default 450). Crow warms the display's speech model at gateway start, on connect, and after a settings change, so the first question is not slow.
- Voice: the Kokoro TTS bundle (loopback :8880) when installed.

## Does the assistant fit?
The quick voice model has a small context (8,192 tokens on the stock local model), and an assistant's system prompt carries the full text of every skill it has. Before each model call the voice turn estimates the request (`servers/gateway/voice/prompt-fit.js`) and never sends one that cannot fit:
- the full prompt fits → nothing changes;
- it does not → the turn runs **without the assistant's skill bodies** (persona and tools stay); the turn's metrics carry `prompt_fit: "no_skills"`;
- still too large → no model call: the display says that the assistant is too large and to choose another one in the Kiosk settings (`failed: "bot_too_large"`).

Saved conversation is trimmed, oldest exchange first, when it would push a request over. The **Kiosk** panel shows the same result for every assistant in the picker — fits, works without its skills, or too large — and refuses to bind a too-large one. A general-purpose assistant with many skills belongs on a larger model; give a display a small household assistant.

## Display tool and clock
- The display tool (`crow_wm`: timers, recipes, a content card) is offered to the model only on turns that need it: the spoken question asks to show, time, follow or close something (English and Spanish word lists in `server/wm.js`, `wantsDisplay`), or a window is already open. A plain question gets no display tool, so it is answered aloud in one model round.
- A content card is refused when the question did not ask to see anything, and any card whose title or text is empty or a syntax placeholder is refused. A new content card replaces the previous one; timers and recipes keep their own windows.
- Every turn carries the display's local date, time and time zone on the user message (the page reports its zone when it connects; without one the server's zone is used). "What time is it?" and "What's the date?" are answered directly, without the model (`server/clock.js`).

## Privacy
- The page sends its time zone name when it connects, so the display can tell the time.
- Nothing is sent before a tap. No audio is stored; transcripts live only in the display's short in-memory conversation (15 min).
- Memories are off by default on a display (`memory_integration`).
