# OpenClaw Message Gateway Bridge

Bridge Crow's messaging system to chat platforms (Discord, WhatsApp, Telegram, and others) through OpenClaw's gateway API. Send and receive messages across platforms without leaving your AI conversation.

::: warning STATUS: DESIGN PHASE
This feature is planned but **not yet implemented**. The architecture below describes the intended design. Implementation depends on OpenClaw's gateway API, which is still in development. This page will be updated as the bridge becomes available.
:::

## What the Bridge Does

Crow already supports peer-to-peer messaging via `crow_send_message` and `crow_inbox` (using Nostr for transport). The OpenClaw bridge extends this by forwarding messages between Crow and chat platforms that OpenClaw connects to:

- **Outbound**: When you use `crow_send_message`, the bridge optionally forwards the message through OpenClaw's gateway to Discord, WhatsApp, Telegram, or any other platform OpenClaw supports.
- **Inbound**: When someone messages you on a connected chat platform, the OpenClaw gateway forwards it to Crow, where it appears in `crow_inbox` alongside your Nostr messages.

This means you can have a single inbox for all your messages — Crow peers, Discord channels, Telegram chats, and more — all accessible through your AI assistant.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌───────────────────┐     ┌──────────────┐
│  Crow AI    │     │  Crow Sharing    │     │  OpenClaw Gateway │     │  Chat        │
│  (Claude,   │────▶│  Server          │────▶│  API              │────▶│  Platforms   │
│  ChatGPT,   │     │  (Nostr + Bridge)│     │  (webhook relay)  │     │  (Discord,   │
│  etc.)      │◀────│                  │◀────│                   │◀────│  Telegram,   │
└─────────────┘     └──────────────────┘     └───────────────────┘     │  WhatsApp)   │
                                                                       └──────────────┘
```

### Message flow: outbound

1. You say: *"Send a message to Alice on Discord: meeting at 3pm"*
2. Crow calls `crow_send_message` with a platform routing hint
3. The sharing server detects the routing hint and forwards the message to the OpenClaw gateway webhook
4. OpenClaw's gateway API delivers the message to the specified platform and channel/user

### Message flow: inbound

1. Someone sends you a message on Discord (or another connected platform)
2. OpenClaw's gateway captures the message and calls Crow's inbound webhook
3. Crow's sharing server stores the message in the local database
4. The message appears in `crow_inbox` on your next check, tagged with its source platform

## Prerequisites

- **Crow sharing server** running (either via stdio MCP or the HTTP gateway)
- **OpenClaw** installed with gateway module enabled
- Both services on the same network (or accessible via Tailscale / public URL)

## Configuration

Two environment variables control the bridge:

| Variable | Description | Example |
|---|---|---|
| `OPENCLAW_GATEWAY_URL` | Base URL of the OpenClaw gateway API | `http://localhost:3100` |
| `OPENCLAW_API_KEY` | API key for authenticating with the OpenClaw gateway | `oc_key_abc123...` |

Add these to your `.env` file:

```env
OPENCLAW_GATEWAY_URL=http://localhost:3100
OPENCLAW_API_KEY=your-openclaw-api-key
```

Then regenerate your MCP config:

```bash
npm run mcp-config
```

The bridge activates automatically when both variables are set. If they are absent, Crow's messaging works normally via Nostr only.

## Planned Features

### Message forwarding

Send messages to contacts on any OpenClaw-connected platform:

> "Message Alice on Discord: the draft is ready for review"
> "Send Bob on Telegram: can you check the server?"

Platform routing is determined by the contact's linked accounts in OpenClaw.

### Notification delivery

Receive notifications from chat platforms in your Crow inbox:

> "Check my messages" — returns Nostr messages and forwarded chat platform messages together
> "Any new Discord messages?" — filters by platform

### Status sync

Sync read/unread status between Crow and the chat platform. When you read a message in Crow, it marks as read on the platform (where supported). When you read it on the platform, Crow marks it as read locally.

### Contact linking

Link Crow contacts to their chat platform identities:

> "Link Alice to her Discord account alice#1234"

Once linked, `crow_send_message` to Alice can route through either Nostr (peer-to-peer) or the chat platform, depending on context.

## How It Differs from Native Nostr Messaging

| Aspect | Nostr (current) | OpenClaw Bridge (planned) |
|---|---|---|
| **Transport** | Public Nostr relays | OpenClaw gateway webhook |
| **Encryption** | NIP-44 end-to-end | Platform-dependent (Discord TLS, etc.) |
| **Recipients** | Crow users only | Anyone on connected chat platforms |
| **Privacy** | Gift-wrapped, no metadata leaks | Subject to platform's privacy policy |
| **Requires** | Nostr relay access | OpenClaw gateway running |

The bridge complements Nostr messaging rather than replacing it. Crow-to-Crow messages continue to use Nostr for maximum privacy. The bridge is for reaching people who are not Crow users.

## Webhook Endpoints (Planned)

The Crow gateway will expose these endpoints for OpenClaw integration:

| Endpoint | Method | Description |
|---|---|---|
| `/api/bridge/inbound` | POST | Receive messages from OpenClaw gateway |
| `/api/bridge/status` | GET | Bridge connection health check |
| `/api/bridge/platforms` | GET | List connected platforms and their status |

OpenClaw's gateway calls `/api/bridge/inbound` when a message arrives on a connected chat platform. The payload includes the sender's platform identity, message content, and thread context.

## Security Considerations

- The `OPENCLAW_API_KEY` authenticates both directions of the bridge. Keep it secret.
- Messages crossing the bridge lose Nostr's end-to-end encryption — they are only as private as the destination platform allows.
- Crow stores bridged messages locally in the same database as Nostr messages, with a `source` field indicating the origin platform.
- The bridge never forwards messages automatically. You must explicitly send via `crow_send_message` or opt in to inbound forwarding per platform.

## Related

- [Social & Messaging](/guide/social) — Nostr-based messaging (current)
- [Sharing](/guide/sharing) — P2P data sharing with Hypercore
- [OpenClaw Platform](/platforms/openclaw) — OpenClaw integration overview
- [Sharing Server Architecture](/architecture/sharing-server) — Technical details
