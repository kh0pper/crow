---
title: "Your First Bot: A Tutorial"
---

# Your first bot

This is a step-by-step walkthrough for building your first bot in Crow — written for people who have never set up an AI agent before. No config files, no command line, no jargon. If you can fill in a form, you can build a bot.

A **bot** is an AI helper with a job. You decide what it's called, which AI model powers it, where people can talk to it, and what it's allowed to do. Crow keeps it running for you.

Time needed: about five minutes for a bot you can talk to immediately.

## Before you start

You need one thing: **an AI provider**. That's the service (or local model) that does the actual thinking. If you haven't added one yet, open **Settings → LLM → Providers** in the dashboard and add one first — the bot wizard will point you there anyway if none is set up.

## Step 1 — Open the wizard

In the dashboard sidebar, open **Bot Builder** and click the **Create a bot** button. You'll see a short series of screens with a progress bar at the top. You can go **Back** at any point without losing what you typed, and nothing is created until the very last step.

## Step 2 — Pick a starting point

Templates set up a working bot for a common job. You can change every detail later, so don't overthink it.

| Template | What it does | What you'll need |
|---|---|---|
| **Personal assistant** | Chats with you, remembers what you tell it | Nothing — works immediately |
| **Email responder** | Reads incoming email, drafts polite replies | A Gmail address and a list of allowed senders |
| **Discord Q&A** | Answers questions in your Discord server | A free Discord bot token ([how to get one](#getting-a-discord-bot-token)) |
| **Project manager** | Works a task board: picks up tasks, moves them forward | Nothing — link a project later |
| **Start from scratch** | A minimal bot with safe defaults | For when you want full control |

**For your first bot, pick Personal assistant.** It needs no accounts, no tokens, and you can talk to it the moment it's created.

## Step 3 — Name your bot

Type a name — "Research Scout", "Homework Helper", whatever fits the job. A short internal id is created from the name automatically (you'll see it later on the summary screen). You don't need to touch the "Advanced" section.

## Step 4 — Choose its AI model

Pick the model that powers your bot from the list. The list shows exactly what's available on *your* Crow — nothing imaginary.

If the list is empty, the wizard shows a link to the provider settings. Add a provider there, then start the wizard again — it's only two quick screens back to this point, and no half-made bot is left behind (nothing is created until the final step).

You can change the model any time later on the bot's **AI** tab.

## Step 5 — Connect a channel

A **channel** is where people talk to your bot. The template picks a sensible one, but you can change it here.

- **Crow Messages** (the Personal assistant default) is built into Crow — no accounts, no credentials. After the bot is created you can share a link or QR code so family or teammates can message it.
- **Gmail / Discord / Telegram / Slack** need credentials from those services — see the [channel guides](#channel-guides) below. You can also pick the channel now, skip the credentials, and finish later.
- **No channel yet** is always an option. The bot still works — you can talk to it from its Sessions tab — and you can add a channel any time.

## Step 6 — Review and create

The last screen shows what you chose: template, name, internal id, model, channel. Click **Create bot**.

## Step 7 — The readiness checklist

You land on your new bot's **Review** tab, which shows a checklist:

- ✓ rows are ready.
- ⚠ rows tell you what's missing in plain language — with a **Change** link that takes you straight to the tab that fixes it.

The most common warning for a first bot is on the **Channel** row (for example, a Gmail channel with no allowed senders yet — the bot can't receive mail until that's set). The checklist never pretends something works when it doesn't.

Everything technical (the raw definition, diagnostics) is tucked under **Advanced** at the bottom. You never need it for everyday use.

## Step 8 — Talk to your bot

For a Crow Messages bot: open the bot's **Gateways** tab, click **Share access**, and you get a link + QR code. Open the link (or open **Messages** in the sidebar) and say hello. For other channels, message it where it lives — email it, mention it on Discord, and so on.

## Cleaning up

Made a test bot you don't want? Open it, expand **Advanced** on the Review tab (or use the **Delete this bot…** link on the bot list) and confirm. The confirmation page lists exactly what will be removed — including your conversation history with that bot — before you commit. Deleting cannot be undone.

## Channel guides

### Getting a Discord bot token

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and sign in.
2. Click **New Application**, name it, then open the **Bot** section.
3. Click **Reset Token** and copy the token — this is what you paste into the wizard's token field. Treat it like a password.
4. Under **Privileged Gateway Intents**, enable **Message Content Intent**.
5. In the **OAuth2 → URL Generator**, tick `bot`, give it *Send Messages* and *Read Message History*, open the generated URL, and invite the bot to your server.

### Setting up a Gmail channel

1. Use a Gmail address with a **plus alias**, e.g. `you+assistant@gmail.com` — mail to the alias lands in your normal inbox, and Crow watches for it.
2. Enter that alias as the bot's address.
3. Add the senders who may talk to the bot to the **allowlist**, one address per line. **This is required**: with an empty allowlist the bot ignores all mail, on purpose, so strangers can't command your bot.

### Getting a Telegram bot token

1. In Telegram, message **@BotFather** and send `/newbot`.
2. Follow the prompts; BotFather gives you a token. Paste it into the wizard.
3. Optionally restrict who can use the bot by adding Telegram user IDs to the allowlist (empty = anyone who finds the bot can talk to it).

### Setting up a Slack app

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) → **From scratch**.
2. Under **Socket Mode**, enable it and create an **app-level token** with the `connections:write` scope (starts with `xapp-`).
3. Under **OAuth & Permissions**, add the `chat:write` and `app_mentions:read` bot scopes and install the app to your workspace — this gives you the **bot token** (starts with `xoxb-`).
4. Paste both tokens into the wizard.

## Where to go next

- The [Bot Builder reference](/guide/bot-builder) explains every tab in depth — tools, skills, permissions, triggers, and voice channels.
- Give your bot **skills** (reusable instructions for a workflow) on its Skills tab.
- Set its **permissions** — new bots start safe: no shell access, email drafts only, no self-learning.
