---
title: Slack
---

# Slack

Connect Crow to Slack to read messages, post updates, and interact with channels and threads through your AI assistant.

## What You Get

- Read messages from channels and threads
- Send messages to channels
- List channels and browse channel history
- Look up user profiles

## Setup

### Step 1: Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch**
3. Name it (e.g., "Crow") and select your workspace
4. Click **Create App**

### Step 2: Add Bot Token Scopes

1. In your app settings, go to **OAuth & Permissions** in the left sidebar
2. Scroll to **Scopes** → **Bot Token Scopes**
3. Click **Add an OAuth Scope** and add each scope listed in **Required Permissions** below
4. Scroll up and click **Install to Workspace**
5. Authorize the app when prompted
6. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

### Step 3: Invite the bot to channels

In Slack, go to each channel you want Crow to access and type `/invite @Crow` (or whatever you named the app).

### Step 4: Add to Crow

Paste your bot token in **Crow's Nest** → **Settings** → **Integrations**,
or on the **Setup** page at `/setup`.

The environment variable is `SLACK_BOT_TOKEN`.

## Required Permissions

| Scope | Why |
|---|---|
| `channels:history` | Read messages in public channels |
| `channels:read` | List public channels and their details |
| `chat:write` | Send messages to channels the bot is in |
| `users:read` | Look up user names and profiles |

Optional scopes for expanded access:

| Scope | Why |
|---|---|
| `groups:history` | Read messages in private channels |
| `groups:read` | List private channels |
| `im:history` | Read direct messages |
| `reactions:read` | View emoji reactions on messages |

## Troubleshooting

### "not_in_channel" error

The bot must be invited to each channel before it can read or post messages. Use `/invite @Crow` in the channel.

### "missing_scope" error

You need to add the missing scope in **OAuth & Permissions** and reinstall the app to your workspace. Slack requires reinstallation after adding new scopes.

### Bot can't see messages from before it joined

Slack bots can only access message history from channels they've been invited to. They cannot retroactively access messages from before the invitation.
