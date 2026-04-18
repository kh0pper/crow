# Meta Glasses Skill

The Meta Glasses bundle lets a user pair a pair of Meta Ray-Ban (Gen 2)
smart glasses with their Crow installation. Voice turns captured on the
glasses are routed through the user's default STT, AI, and TTS profiles.

Claude: only offer to use this bundle when the user's request is about
their *physical* Ray-Ban Meta glasses. Prefer asking about the state of the
pair (via the panel) before recommending actions.

## Tools exposed

- `crow_glasses_status` — list paired devices and their last-seen state.
- `crow_glasses_speak(text, device_id?)` — request a TTS broadcast to a
  paired device that has an active `/session` WebSocket. Does nothing if
  the device is offline. Returns a hint string; actual delivery happens via
  the bundle's panel/routes.js when the socket is up.
- `crow_glasses_capture_photo(device_id?)` — ask the glasses to capture a
  still image. The image arrives asynchronously on the session WebSocket;
  you will not receive the photo URL as the tool's return value.
- `crow_glasses_search_photos(query, limit?)` — FTS5 search over the photo
  library (caption + OCR). Returns top hits with presigned URLs.
- `crow_glasses_start_note_session({ topic?, mode?, device_id, project_id? })`
  — begin a note-taking session. `mode` defaults to `'session'` (multi-turn
  discrete events). `'continuous'` enables Slice C.3 streaming transcription
  (up to 2 hours); the tool returns `needs_consent: true` plus a
  `consent_prompt` string you MUST read aloud verbatim. The session is
  parked in awaiting-consent state for 120 s — you must then call
  `crow_glasses_confirm_continuous_recording` on the next turn (after the
  user answers). Calling `start_note_session` with `mode: 'continuous'` twice
  for the same device before the first is confirmed rejects with
  `{ error: "consent_pending", existing_session_id }` — cancel the existing
  session first via `crow_glasses_end_note_session` before retrying.
- `crow_glasses_confirm_continuous_recording({ session_id, device_id })`
  — user explicitly authorized continuous recording. Call this ONLY when the
  user's NEXT voice turn affirmatively answers the consent prompt (e.g.
  "yes, record", "go ahead", "record the meeting"). Rejects if no matching
  awaiting-consent session exists, if the 120-s freshness window has elapsed,
  or if the session is no longer active. **Do NOT retry on rejection** — ask
  the user to re-initiate via a fresh `start_note_session`.
- `crow_glasses_add_to_note({ text, session_id?, device_id })` — append a
  `[HH:MM] <text>\n` line to the session's backing note. If `session_id` is
  omitted, the most-recent active session for the device is used.
- `crow_glasses_undo_last_append({ session_id?, device_id })` — strip the
  most recent dictated line. Refuses to mutate if the last line isn't a
  `[HH:MM] ` entry (won't clobber a header or operator-edited paragraph).
  Use when the user says "undo that" within ~60 s of the wrong dictation.
- `crow_glasses_end_note_session({ session_id?, device_id })` — runs the
  summarization + action-item extraction pipeline against the configured
  default AI profile, prepends a `## Summary` block to the note, and
  returns the structured result. **Read the action_items back to the user
  verbally and ask them which ones to keep.** Then call
  `crow_glasses_confirm_action_items` on the next turn with the user's
  selection. The structured result includes `needs_confirmation: true`
  when there are action items pending.
- `crow_glasses_confirm_action_items({ session_id, keep })` — `keep` is
  `'all' | 'none' | [1, 2, 5]` (1-indexed item numbers). Creates a
  notification per kept item. **Retry budget**: a malformed `keep` returns
  `{ error: "invalid_keep", retries_remaining: N }`. After 3 failures the
  call fails closed (zero items kept). Don't retry past the budget — ask
  the user to re-summarize.
- `crow_glasses_capture_and_attach_photo({ device_id, session_id?, caption? })`
  — during an active note session, capture a photo via the glasses and
  inline it into the backing note as `![caption](photo://<photo_id>) *HH:MM*`.
  If no `caption` is given, a placeholder is inserted and the scheduler
  backfills the auto-caption once recordGlassesPhoto's vision pipeline
  completes. `photo://` is a **reserved scheme** within Crow notes —
  the Notes tab's renderer re-mints presigned URLs at render time, so
  don't emit `photo://` URLs pointing at anything other than valid
  glasses_photos row ids. Non-digit variants (e.g. `photo://xyz`) are
  preserved verbatim as literal text.

### Notes-sync caveat

Action-item notifications are inserted into the local `notifications`
table, which is NOT in `SYNCED_TABLES` (per `servers/sharing/instance-sync.js`).
This is deliberate — bell badges stay per-instance. Action items surface
on whichever Crow instance ran summarization; paired Crows get their own
items from their own sessions.

## Architecture one-liner

```
Glasses ─BT/DAT─> Android (Crow app 1.4.0+) ─WSS─> Crow gateway ─> STT → AI → TTS
```

## Constraints

- Gen 1 (Ray-Ban Stories, 2021) is **not** supported — DAT does not expose
  the required primitives on that device.
- The Android app (1.4.0+, package `press.maestro.crow`) is required on
  the user's phone; the gateway alone cannot talk to the glasses directly.
- Wake-word is opt-in; the default trigger is an in-app push-to-talk
  button. Do not assume the glasses respond to arbitrary phrases.

## Continuous-mode flow (Slice C.3)

Continuous mode streams 10-second PCM chunks from the glasses mic through
the server's STT profile, appending `[HH:MM] <text>` lines to the session's
backing note as transcripts come back in-order. Hard caps: 2 hours, or
"stop recording".

**Consent paradox.** The consent-answering voice turn uses the mic NORMALLY
(PTT → discrete turn). The consent authorizes the SUBSEQUENT 2-hour
continuous block, not the answering turn itself. So the flow is always:

1. User: "Record this meeting."
2. You call `crow_glasses_start_note_session({ mode: "continuous", device_id, topic })`.
3. You receive `needs_consent: true` + `consent_prompt`. Speak the prompt verbatim.
4. User's NEXT voice turn: "Yes, record" (or "Cancel").
5. If affirmative → call `crow_glasses_confirm_continuous_recording({ session_id, device_id })`.
   Server sends `note_stream_begin` to the glasses; Android opens the PCM pump.
6. Continuous transcription appends lines to the note.
7. User says "Stop recording." → call `crow_glasses_end_note_session({ session_id, device_id })`.
   Server tears down the pump and runs the summarization pipeline (same as
   discrete sessions — ask about action items next).

**PTT during continuous is rejected.** If the user presses PTT while a
note_stream is active, the phone and server both reject with
`note_session_active`. You don't need to handle this explicitly — the server
speaks the error automatically.

**Two-party-consent warning.** Continuous recording captures audio from
everyone within mic range of the glasses. In jurisdictions with two-party-
consent laws (California, Florida, Illinois, Maryland, Massachusetts,
Montana, New Hampshire, Pennsylvania, Washington), obtaining consent from
all recorded parties is the OPERATOR's responsibility — Crow does not beep
or flash an LED. If the user asks you to start a meeting recording in one
of these jurisdictions (or you're not sure), remind them before confirming.

**Abnormal terminations.** If SCO never connects, an STT provider lags so
far behind that 3 consecutive 10-s chunks get dropped, or the 2-hour cap
fires, the server automatically speaks one of: "Can't record — the glasses
mic isn't connected", "Recording stopped — transcription can't keep up with
real-time speech", or "Recording stopped — 2-hour cap reached". The session
is finalized + summarized with whatever transcript was captured up to that
point.

**No retry on consent rejection.** If `confirm_continuous_recording`
returns any error (`consent_expired`, `not_found`, `not_active`,
`wrong_mode`, `already_confirmed_or_not_awaiting`), DO NOT call it again.
Ask the user to initiate a fresh session via `start_note_session`.
