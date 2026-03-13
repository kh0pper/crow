---
title: Discord
---

# Discord

Connect Crow to Discord to read and send messages in your servers through your AI assistant.

## What You Get

- Read messages from channels in your servers
- Send messages to channels
- List servers, channels, and members
- Browse message history

## Setup

### Step 1: Create a Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**
3. Name it (e.g., "Crow") and click **Create**

### Step 2: Create a bot and get the token

1. In your application, go to **Bot** in the left sidebar
2. Click **Reset Token** (or **Add Bot** if this is a new app)
3. Copy the bot token — Discord only shows it once
4. Under **Privileged Gateway Intents**, enable **Message Content Intent**

### Step 3: Invite the bot to your server

1. Go to **OAuth2** → **URL Generator** in the left sidebar
2. Under **Scopes**, check `bot`
3. Under **Bot Permissions**, check: `Read Messages/View Channels`, `Send Messages`, `Read Message History`
4. Copy the generated URL at the bottom and open it in your browser
5. Select the server to add the bot to and click **Authorize**

### Step 4: Add to Crow

Paste your bot token in **Crow's Nest** → **Settings** → **Integrations**,
or on the **Setup** page at `/setup`.

The environment variable is `DISCORD_BOT_TOKEN`.

## Required Permissions

| Permission | Why |
|---|---|
| **Message Content Intent** | Read the text content of messages (privileged intent, must be enabled in Bot settings) |
| `Read Messages/View Channels` | See channels and their messages |
| `Send Messages` | Post messages to channels |
| `Read Message History` | Access older messages in channels |

## Troubleshooting

### Bot is online but can't read messages

The **Message Content Intent** must be enabled in the Developer Portal under **Bot** → **Privileged Gateway Intents**. Without it, the bot receives message events but the content field is empty.

### "Missing Access" error

The bot doesn't have permission to access that channel. Check the channel's permission overrides in Discord's server settings to make sure the bot role isn't denied access.

### Bot doesn't appear in the server

Revisit the OAuth2 URL Generator, make sure the `bot` scope is selected, and re-authorize with the correct server.
