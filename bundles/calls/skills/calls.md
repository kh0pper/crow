---
name: calls
description: Voice and video calling between Crow users
triggers:
  - call
  - video call
  - start a call
  - phone
tools:
  - crow_room_invite
  - crow_list_contacts
---

# Calls Skill

## When to activate
- User says "call <name>", "video call <name>", "start a call with <name>"
- User asks to "phone" or "ring" a contact
- User asks about calling features

## Workflow

### Starting a call
1. If a contact name is provided, use `crow_room_invite` to create a room and send the invite
2. The contact will receive a notification with the call link
3. Return the call URL so the user can open it: `/calls?room=<code>&token=<token>`
4. If no contact name, create a room via `POST /api/rooms` (no invite) and share the link

### During a call
- Calls happen in the browser at the `/calls` page
- Audio calling works out of the box
- Video calling available when camera is enabled (Phase 2)
- If the AI Companion is also installed, users get avatar representation modes

### Ending a call
- Users hang up from the call page UI
- Rooms expire after 24 hours automatically

## Notes
- Maximum 4 participants per call
- Calls use WebRTC (peer-to-peer, encrypted)
- Optional TURN relay available if the coturn bundle is installed
- Call quality adapts to network conditions automatically
