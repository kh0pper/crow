---
title: Video & Audio Calls
---

# Video & Audio Calls

Make peer-to-peer video and audio calls between Crow instances. Calls use WebRTC for media and the gateway's WebSocket relay for signaling. No third-party servers, no accounts, no data leaves your network.

## Requirements

- The **Calls** extension installed on both instances (Extensions page or `crow bundle install calls`)
- Both instances reachable over the network (Tailscale recommended)
- A modern browser with WebRTC support (Chrome, Firefox, Safari, Edge)
- HTTPS required for camera/microphone access (Tailscale HTTPS or a reverse proxy)

## Starting a Call

### From the Calls panel

1. Open **Calls** in the Crow's Nest sidebar
2. Your contacts appear with a **Call** button next to each
3. Click **Call** to create a room and send an invite via Nostr
4. A new tab opens with the call page. Click **Join Call** to connect your microphone and camera

### From the AI

> "Call Alice"
> "Start a video call with Bob"

The AI uses the `crow_room_invite` tool to create a room and send the invite.

### Via direct link

Every call room has a shareable URL:

```
https://your-instance.ts.net:8444/calls?room=abc123&token=xyz
```

Share this link through any channel. Anyone with the link and token can join.

## Receiving a Call

When someone calls you, three things happen:

### 1. Toast banner

A slide-down banner appears at the top of any Crow's Nest page:

```
+---------------------------------------------------+
|  Caller is calling...             [Accept] [Dismiss] |
+---------------------------------------------------+
```

- **Accept** opens the call in a new tab
- **Dismiss** removes the notification
- Auto-dismisses after 60 seconds

The toast appears when the notification bell detects new call invites during its 60-second poll cycle. For faster delivery, use Web Push or the ntfy bundle.

### 2. Push notification

If you have [Web Push](/guide/notifications) or [ntfy](/guide/notifications#ntfy-bundle) configured, you get an instant notification on your phone or desktop. Tapping it opens the call page directly.

### 3. Calls panel

The **Incoming** section at the top of the Calls panel shows undismissed call invites from the last hour with a **Join** button.

## In-Call Controls

Once in a call:

| Control | Action |
|---------|--------|
| Microphone toggle | Mute/unmute your audio |
| Camera toggle | Start/stop video |
| Screen share | Share your screen (desktop browsers) |
| Hang up | Leave the call |

Audio starts automatically when you join. Video is off by default until you toggle it on.

## How It Works

```
Caller                          Callee
  |                               |
  |-- POST /api/rooms ----------->|  (creates room + sends Nostr invite)
  |                               |
  |-- WebSocket /calls/ws ------->|  (signaling relay)
  |<- WebSocket /calls/ws --------|
  |                               |
  |<======= WebRTC P2P =========>|  (audio/video direct)
```

1. The caller creates a room via `POST /api/rooms`, which generates a room code and token
2. An encrypted Nostr message delivers the call URL to the callee
3. Both browsers connect to the gateway's WebSocket signaling relay
4. The relay brokers the WebRTC offer/answer exchange
5. Once ICE negotiation completes, audio and video flow directly between browsers

All media is peer-to-peer. The gateway only handles signaling (room management and SDP exchange). On Tailscale networks, STUN is typically sufficient for NAT traversal.

## Room Security

- Every room has a random 12-character code and a separate authentication token
- The signaling relay validates the token before accepting WebSocket connections
- No token-less connections are allowed
- Room tokens are single-use (generated per call, not reusable)

## Multi-Participant Calls

Rooms support up to 4 participants by default (configurable via `CROW_CALLS_MAX_PEERS`). Each participant establishes a WebRTC connection with every other participant (mesh topology).

## Companion Integration

When the [AI Companion](/guide/extensions) bundle is also installed, the Calls page gains additional modes:

- **Avatar mode** — the companion's Live2D avatar joins the call as a video participant
- **Face tracking** — the avatar mirrors your expressions via webcam

These modes appear as extra buttons on the call page when both bundles are active.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CROW_CALLS_ENABLED` | `1` | Enable calls signaling in the gateway |
| `CROW_CALLS_MAX_PEERS` | `4` | Maximum participants per room |

## Troubleshooting

**No audio or video?**
- Check that you're using HTTPS (required for `getUserMedia`)
- Verify both instances can reach each other over the network
- Check the browser console for WebRTC ICE errors

**Call invite not received?**
- Verify Nostr relays are connected (check gateway logs for `[nostr] Subscribed`)
- Check that the callee has the caller as a contact

**"Join Call" does nothing?**
- Check the browser console for WebSocket connection errors
- Verify the signaling endpoint is accessible: `wss://your-instance.ts.net:8444/calls/ws`
