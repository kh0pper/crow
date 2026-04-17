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
  discrete events). `'continuous'` is reserved for Slice C.3 PCM streaming
  and requires explicit consent (`needs_consent: true` flag in the
  response); do not auto-confirm.
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
