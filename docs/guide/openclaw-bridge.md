# OpenClaw Message Gateway Bridge

::: danger NOT YET IMPLEMENTED
This feature is on the [roadmap](/roadmap) but has **not been built**. The design below describes the intended architecture for future development. The configuration options and endpoints described here do not exist yet.
:::

Bridge Crow's messaging system to chat platforms (Discord, WhatsApp, Telegram, and others) through OpenClaw's gateway API.

## Vision

Crow already supports peer-to-peer messaging via Nostr. The OpenClaw bridge would extend this by forwarding messages between Crow and chat platforms that OpenClaw connects to — giving you a single inbox for Crow peers, Discord channels, Telegram chats, and more.

## Planned Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌───────────────────┐     ┌──────────────┐
│  Crow AI    │     │  Crow Sharing    │     │  OpenClaw Gateway │     │  Chat        │
│  (Claude,   │────▶│  Server          │────▶│  API              │────▶│  Platforms   │
│  ChatGPT,   │     │  (Nostr + Bridge)│     │  (webhook relay)  │     │  (Discord,   │
│  etc.)      │◀────│                  │◀────│                   │◀────│  Telegram,   │
└─────────────┘     └──────────────────┘     └───────────────────┘     │  WhatsApp)   │
                                                                       └──────────────┘
```

### How it would work

- **Outbound**: `crow_send_message` with a platform routing hint forwards through OpenClaw's gateway to Discord, WhatsApp, Telegram, etc.
- **Inbound**: Messages from connected chat platforms are forwarded to Crow's inbox via webhook, tagged with their source platform.

### Key design goals

- Single inbox for all messages (Crow peers + chat platforms)
- Platform routing determined by contact's linked accounts in OpenClaw
- Messages crossing the bridge lose Nostr's end-to-end encryption (subject to destination platform's privacy policy)
- Bridge is complementary — Crow-to-Crow messages continue using Nostr for maximum privacy

## Current Status

This feature depends on:
1. OpenClaw's gateway API (still in development)
2. Implementation of the bridge endpoints in Crow's sharing server

**For current messaging capabilities**, see:
- [Social & Messaging](/guide/social) — Nostr-based messaging (available now)
- [Sharing](/guide/sharing) — P2P data sharing with Hypercore (available now)
- [OpenClaw Platform](/platforms/openclaw) — OpenClaw integration overview
