---
title: Linkding
---

# Linkding

Connect Crow to Linkding to save, search, tag, and organize your bookmarks through your AI assistant.

## What You Get

- Save bookmarks with tags and descriptions
- Search bookmarks by text
- Browse and filter by tags
- Edit bookmark details
- Organize with archive and unread flags
- Delete bookmarks

## Setup

Crow supports two modes for Linkding: self-hosting via Docker or connecting to an existing instance.

### Option A: Docker (self-hosted)

Install Linkding as a Crow bundle. This runs Linkding in Docker alongside your Crow gateway.

> "Crow, install the Linkding bundle"

Or install from the **Extensions** panel in the Crow's Nest.

Linkding will be available at `http://your-server:9090` for initial setup. Create an account via the web UI, then get your API token from **Settings** > **Integrations**.

### Option B: Connect to existing Linkding

If you already run a Linkding instance, connect Crow to it directly.

#### Step 1: Get your API token

1. Open your Linkding web interface
2. Go to **Settings** > **Integrations**
3. Copy the API token shown on the page

#### Step 2: Add to Crow

Set the following in your `.env` file or via **Crow's Nest** > **Settings** > **Integrations**:

```bash
LINKDING_URL=http://your-linkding-server:9090
LINKDING_API_TOKEN=your-api-token-here
```

## AI Tools

Once connected, you can interact with Linkding through your AI:

> "Save this link: https://example.com tagged 'reference'"

> "Search my bookmarks for python tutorials"

> "Show me bookmarks tagged 'recipes'"

> "Delete that bookmark"

## Docker Compose Reference

If you prefer manual Docker setup instead of the bundle installer:

```yaml
services:
  linkding:
    image: sissbruecker/linkding:latest
    container_name: crow-linkding
    ports:
      - "9090:9090"
    volumes:
      - linkding-data:/etc/linkding/data
    restart: unless-stopped

volumes:
  linkding-data:
```

## Troubleshooting

### "Connection refused" or timeout

Make sure the `LINKDING_URL` is reachable from the machine running Crow. If Linkding is on a different machine, use the correct IP or hostname.

### "401 Unauthorized" or invalid token

The API token may have been regenerated. Get the current token from Linkding **Settings** > **Integrations** and update your `.env` file.

### Search not finding results

Linkding indexes bookmark titles, descriptions, and tags, but not the full page content of saved URLs. Make sure you add descriptive tags and notes when saving bookmarks to improve search results.
