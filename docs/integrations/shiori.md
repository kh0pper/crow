---
title: Shiori
---

# Shiori

Connect Crow to Shiori to save web pages with full offline caching, search bookmarks, and manage your reading archive through your AI assistant.

## What You Get

- Save web pages with cached content for offline reading
- Search bookmarks by keyword
- Browse bookmarks with pagination
- Tag and organize saved pages
- View cached page content
- Delete bookmarks

## Setup

Crow supports two modes for Shiori: self-hosting via Docker or connecting to an existing instance.

### Option A: Docker (self-hosted)

Install Shiori as a Crow bundle. This runs Shiori in Docker alongside your Crow gateway.

> "Crow, install the Shiori bundle"

Or install from the **Extensions** panel in the Crow's Nest.

Shiori will be available at `http://your-server:8086` for initial setup. The default credentials are `shiori` / `gopher`. Change the password immediately after first login.

::: warning Port mapping
Shiori's default port (8080) is remapped to **8086** to avoid conflicts with other services.
:::

::: warning Default credentials
Change the default password (`shiori` / `gopher`) immediately after first login.
:::

### Option B: Connect to existing Shiori

If you already run a Shiori instance, connect Crow to it directly. Shiori uses session-based authentication, so Crow logs in automatically with your credentials.

Set the following in your `.env` file or via **Crow's Nest** > **Settings** > **Integrations**:

```bash
SHIORI_URL=http://your-shiori-server:8086
SHIORI_USERNAME=your-username
SHIORI_PASSWORD=your-password
```

## AI Tools

Once connected, you can interact with Shiori through your AI:

> "Save this page: https://example.com"

> "Search my bookmarks for cooking recipes"

> "Show me my recent bookmarks"

> "What tags do I have?"

## Offline Caching

Shiori caches full page content when you save a bookmark, making saved pages available even when the original site goes down. This makes it a reliable archive for reference material, tutorials, and documentation you want to keep permanently.

## Docker Compose Reference

If you prefer manual Docker setup instead of the bundle installer:

```yaml
services:
  shiori:
    image: ghcr.io/go-shiori/shiori:latest
    container_name: crow-shiori
    ports:
      - "8086:8080"
    volumes:
      - shiori-data:/shiori
    restart: unless-stopped

volumes:
  shiori-data:
```

## Troubleshooting

### Login failed

Check that the username and password are correct. If you are using the default credentials, they are `shiori` / `gopher`. If you changed the password in the Shiori web UI, update `SHIORI_PASSWORD` in your `.env` file.

### "Connection refused" or timeout

Make sure the `SHIORI_URL` is reachable from the machine running Crow. If Shiori is on a different machine, use the correct IP or hostname.

### Pages not caching content

Shiori needs network access to fetch page content when saving a bookmark. If the server running Shiori cannot reach the target URL, the page will be saved without cached content. Check network connectivity from the Shiori container.
