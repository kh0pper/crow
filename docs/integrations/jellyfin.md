---
title: Jellyfin
---

# Jellyfin

Connect Crow to Jellyfin to browse your media library, search content, and control playback through your AI assistant.

## What You Get

- Search your media library (movies, TV shows, music, audiobooks)
- Browse collections and recently added content
- Control playback on connected devices
- View what's currently playing
- Automatic **Library** tab in the Media Hub panel

## Setup

Crow supports two modes for Jellyfin: self-hosting via Docker or connecting to an existing instance.

### Option A: Docker (self-hosted)

Install Jellyfin as a Crow bundle. This runs Jellyfin in Docker alongside your Crow gateway.

> "Crow, install the Jellyfin bundle"

Or install from the **Extensions** panel in the Crow's Nest.

After installation, set the path to your media files:

```bash
# In your .env file
JELLYFIN_MEDIA_PATH=/path/to/your/media
```

Restart the bundle for changes to take effect:

> "Crow, restart the Jellyfin bundle"

Jellyfin will be available at `http://your-server:8096` for initial setup (create an admin account and configure libraries).

### Option B: Connect to existing Jellyfin

If you already run a Jellyfin server, connect Crow to it directly.

#### Step 1: Get your API key

1. Open your Jellyfin web interface
2. Go to **Dashboard** > **API Keys** (under the Advanced section)
3. Click **Add** (the `+` button)
4. Name it (e.g., "Crow")
5. Copy the generated API key

#### Step 2: Add to Crow

Set the following in your `.env` file or via **Crow's Nest** > **Settings** > **Integrations**:

```bash
JELLYFIN_URL=http://your-jellyfin-server:8096
JELLYFIN_API_KEY=your-api-key-here
```

## AI Tools

Once connected, you can interact with Jellyfin through your AI:

> "What movies have I added recently?"

> "Search my library for documentaries"

> "What's playing right now?"

> "Play the next episode of The Expanse on the living room TV"

## Media Hub Integration

When Jellyfin is installed, a **Library** tab automatically appears in the Media Hub panel of the Crow's Nest. This gives you a visual interface for browsing your library alongside other media sources.

## Docker Compose Reference

If you prefer manual Docker setup instead of the bundle installer:

```yaml
services:
  jellyfin:
    image: jellyfin/jellyfin:latest
    container_name: crow-jellyfin
    ports:
      - "8096:8096"
    volumes:
      - jellyfin-config:/config
      - jellyfin-cache:/cache
      - ${JELLYFIN_MEDIA_PATH:-/media}:/media:ro
    restart: unless-stopped

volumes:
  jellyfin-config:
  jellyfin-cache:
```

## Troubleshooting

### "Connection refused" or timeout

Make sure the `JELLYFIN_URL` is reachable from the machine running Crow. If Jellyfin is on a different machine, use the correct IP or hostname.

### "401 Unauthorized"

The API key may have been deleted. Create a new one from Jellyfin Dashboard > API Keys.

### Media files not appearing

Jellyfin needs to scan your media library after you set `JELLYFIN_MEDIA_PATH`. Open the Jellyfin web UI and trigger a library scan from Dashboard > Libraries.
