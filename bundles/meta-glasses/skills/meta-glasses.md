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
