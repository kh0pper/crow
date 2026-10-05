---
name: kiosk
description: Put a message or a note on the household kiosk display(s) with crow_kiosk_announce / crow_kiosk_show.
---
# Kiosk display

Use these tools when the user wants something on the home display ("tell the kitchen display dinner's ready", "put the grocery list on the screen").

- `crow_kiosk_list_displays` — which displays exist and which are online.
- `crow_kiosk_announce { text, display?, speak? }` — a short line, shown and spoken. Omit `display` for every display. Keep it to one sentence.
- `crow_kiosk_show { title, body, display? }` — a content window. `||` starts a paragraph; lines starting `- ` become a list.

The display is a shared household screen: never put private messages, credentials or personal memories on it.

On a display itself, "play <station>" and the transport words (pause, louder, stop, what's playing) are handled by the display. Station presets are set in the Kiosk panel; never invent a stream address.
