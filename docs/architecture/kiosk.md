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

- Theme: each paired display has a **Theme** setting in the Kiosk panel (`kiosk_settings.theme`: `auto` | `light` | `dark`, default `auto`). Automatic turns the page dark during the display's sleep hours (default 22:30–06:30); Light or Dark holds all day. A save reaches an open page at once. The dashboard overlay has no stored settings and follows the OS color scheme.
- The page is served at `/display`, not `/kiosk`, because the installed maker-lab bundle owns `/kiosk/*`. The API stays under `/api/kiosk/*` and the dashboard panel at `/dashboard/kiosk`.

## Talk to Crow in the dashboard (session mode)
The Crow's Nest header bird opens the same page inside the dashboard, with no pairing: tap the bird and choose **Talk to Crow**, or press and hold the bird (a held Enter/Space on the focused bird does the same). It uses the microphone and speaker of the device you are on. The row and the long-press exist only while the Kiosk extension is installed.

- Page: `/display/session`; WebSocket: `/api/kiosk/session/dashboard`. Both sit behind the same network rule as the dashboard (never Funnel) **and** require the dashboard's own session cookie — the bundle mints no token for this. The page answers `401` without a session; the socket is refused before the upgrade.
- The socket handshake must come from this origin (`Sec-Fetch-Site: same-origin`, or an `Origin` that names the `Host` / `X-Forwarded-Host`), and its first `hello` frame must echo the `crow_csrf` cookie — the same double-submit rule as every dashboard POST. A reverse proxy in front of Crow must forward `Host` or `X-Forwarded-Host`.
- Nothing is stored: the display exists in memory for the life of the socket, under an id derived from a hash of the session. It is not a paired device, so it is not listed in **Kiosk**, cannot be announced to, and cannot be claimed by a device id. The login is re-checked at every question and once a minute; logging out closes the display. Its windows, timers and short conversation are dropped two minutes after the overlay closes.
- Assistant: the one chosen under **Kiosk → Talk to Crow in the dashboard**, else (Automatic) the first enabled assistant that fits the quick voice model — in full, else without its skills, never one that is too large (see "Does the assistant fit?"). The setting refuses a too-large assistant. It runs with the same tool limits, display-tool rules and clock as a paired display (the browser reports its time zone), and memories stay off. With no enabled assistant that fits — or a chosen one that no longer does — the page says so and links to the Kiosk panel.
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

## How a spoken request is resolved

A request goes through the cheapest step that can answer it, and every step ends in the same executor (`server/executor.js`) with the same result shape.

1. **A control phrase with a live target** (`server/phrases.js`): "close that", "next step", "cierra todo". A fixed table of whole utterances in English and Spanish, compared word by word. It acts only when its target exists (a window to close, a recipe to step through) and names a window by its whole title or whole words of it; otherwise the request goes on.
2. **An anchored pattern whose slot resolves on this display** (`server/patterns.js`): the verb at the start of the utterance, then a name that must match something the display has. No match means no action here.
3. **The assistant, with the display tools** (`server/tools.js`, `server/display-tools.js`): `crow_show` (a card: text, a list, steps, a timer), `crow_wm` (close windows, move through steps), and, once a display has something to play or open, `crow_play` and `crow_open`. Each has at most three flat arguments, and every list of choices is built on the server for this display.

The clock answers without a model: the time, today's date, tomorrow and yesterday, the weekday of a named date, and the days until one (`server/clock.js`).

**Offered, and required.** A display tool is offered to the model only on a turn whose words are about it (or, for `crow_wm`, while a window is open). It is *required* when the person is asking for the thing now: new content, a change to the open card, a play or open request. On a required turn the model's text is held until the call has succeeded; a turn that ends without one gets one corrective round, and after that the display says that it could not, in its own words, instead of claiming it did. A sentence with two requests ("close the timer and then show me a list") is given to the model whole, with every tool that applies.

**Results.** A tool result is `{ ok, outcome, say, final }`. A final result ends the turn on `say`, one sentence in the display's language, so a second model round is not needed to confirm what happened. If the model already spoke a sentence and the call changed something, `say` is not added on top. If the call changed nothing or failed, `say` is always spoken. A non-final result goes back to the model with the fix to make.

**Forcing.** A forced tool call is sent only to an engine known to honour it (read from the model server's own model list). An engine that ignores a forced call is sent none, and the corrective round does the work. `"required"` is never sent to an engine that is not known to honour it.

**Other tools.** The assistant's other tool families (projects, messages, files, news, add-ons) are offered to the quick model only on a turn whose words ask for them, or on the turn right after one that used them. A family that is not on offer is never run, whatever the model calls. Each turn's log line and the Diagnostics list say which families were not offered. Memory keeps its own rule (when asked to remember or recall).

**Display profiles.** Each display has a type (small wall display, phone, tablet, desktop). What a display may show is the lesser of its type and what its page reports it can draw. A display with no type set is treated as the small wall display: audio first. The type is not stored until someone picks it in the Kiosk panel or the display's first connection guesses it from what its page reports (a phone says it is mobile; a small screen on an ARM Linux browser is a wall display); a guessed type is marked as guessed in the panel.

## Display tool and clock
- A plain question is answered aloud in one model round with no display tool on offer. While a window is open, `crow_wm` alone is offered on such a turn (closes and steps).
- A card is refused when the question did not ask to see anything, and any card whose title or text is empty or a placeholder is refused, with the fix. A card sent under the title of the card that is open updates it; a new content card replaces the previous one; a timer always gets its own window, so setting one never cancels another.
- Every turn carries the display's local date, time and time zone on the user message (the page reports its zone when it connects; without one the server's zone is used).
- Each tool call's outcome is logged as `name:outcome` (`shown`, `updated`, `placeholder`, `no_intent`, `not_offered`, `refused_policy`, …), never its arguments or text; the page's debug list (long press on the clock) shows the same line.
- `POST /api/kiosk/internal/turn-check` (loopback and the announce token only) runs three fixed sentences through the same turn a display uses, on a display that does not exist, and reports what happened. It never escalates to the larger model (so it can never start one), and it passes only when the card it asks for is really on the screen (that sentence is tried up to three times). It is the check to run after an update.

## Privacy
- The page sends its time zone name when it connects, so the display can tell the time.
- Nothing is sent before a tap. No audio is stored; transcripts live only in the display's short in-memory conversation (15 min).
- Memories are off by default on a display (`memory_integration`). When they are on, the memory tool is offered only when the question asks to remember, recall or forget something (`server/memory-intent.js`): the assistant uses memories when asked, not on every question.
