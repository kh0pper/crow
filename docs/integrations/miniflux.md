---
title: Miniflux
---

# Miniflux

Connect Crow to Miniflux, a minimalist RSS reader, to subscribe to feeds, read articles, and stay on top of your news through your AI assistant.

## What You Get

- Subscribe to RSS/Atom feeds
- Browse unread articles with filters
- Read full article content
- Star and bookmark important articles
- Mark entries as read (single or bulk)
- Manage feed subscriptions

## Setup

Crow supports two modes for Miniflux: self-hosting via Docker or connecting to an existing instance.

### Option A: Docker (self-hosted)

Install Miniflux as a Crow bundle. This runs Miniflux with PostgreSQL in Docker alongside your Crow gateway.

> "Crow, install the Miniflux bundle"

Or install from the **Extensions** panel in the Crow's Nest.

After installation, set your admin password:

```bash
# In your .env file
MINIFLUX_ADMIN_PASSWORD=your-secure-password
```

Restart the bundle for changes to take effect:

> "Crow, restart the Miniflux bundle"

Miniflux will be available at `http://your-server:8085`. Log in with the admin account, then generate an API key from **Settings** > **API Keys**.

::: tip Port note
The default Miniflux port (8080) is remapped to 8085 to avoid conflicts with other services.
:::

### Option B: Connect to existing Miniflux

If you already run a Miniflux instance, connect Crow to it directly.

#### Step 1: Get your API key

1. Open your Miniflux web interface
2. Go to **Settings** > **API Keys**
3. Click **Create a new API key**
4. Copy the generated key

#### Step 2: Add to Crow

Set the following in your `.env` file or via **Crow's Nest** > **Settings** > **Integrations**:

```bash
MINIFLUX_URL=http://your-miniflux-server:8085
MINIFLUX_API_KEY=your-api-key-here
```

## AI Tools

Once connected, you can interact with Miniflux through your AI:

> "What are my unread articles?"

> "Subscribe to https://example.com/feed.xml"

> "Show me starred articles"

> "Mark all news feeds as read"

> "What feeds am I subscribed to?"

## Troubleshooting

### "Connection refused" or timeout

Make sure the `MINIFLUX_URL` is reachable from the machine running Crow. If Miniflux is on a different machine, use the correct IP or hostname.

### "Invalid API key"

API keys can be invalidated if regenerated. Create a new API key from Miniflux **Settings** > **API Keys** and update your `.env` file.

### Feeds not updating

Check that the feed URL is valid and accessible from the machine running Miniflux. Some feeds require specific User-Agent headers or may be behind authentication. You can verify feed status in the Miniflux web UI under **Feeds**.
