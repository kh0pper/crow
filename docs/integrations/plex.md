---
title: Plex
---

# Plex

Connect Crow to your Plex Media Server to search your library, browse collections, and control playback through your AI assistant.

## What You Get

- Search your media library (movies, TV shows, music)
- Browse recently added and On Deck content
- Control playback on connected Plex clients
- View what's currently playing
- Automatic integration with the Media Hub panel

## Setup

### Step 1: Get your Plex Token

Your Plex Token authenticates Crow with your server. To find it:

1. Open [app.plex.tv](https://app.plex.tv) in your browser and sign in
2. Play any media item or navigate to any library page
3. Open your browser's **Developer Tools** (F12 or right-click > Inspect)
4. Go to the **Network** tab
5. Look at any request to `plex.tv` or your server — find `X-Plex-Token` in the URL query parameters
6. Copy the token value

::: tip
The token is a long alphanumeric string like `abc123DEF456`. It appears as `?X-Plex-Token=...` at the end of API request URLs.
:::

Alternatively, you can find the token in your Plex configuration files:

- **macOS**: `~/Library/Application Support/Plex Media Server/Preferences.xml` — look for `PlexOnlineToken`
- **Linux**: `/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml`
- **Windows**: `%LOCALAPPDATA%\Plex Media Server\Preferences.xml`

### Step 2: Find your Plex server URL

This is the address of your Plex Media Server:

- Local: `http://192.168.1.100:32400` or `http://localhost:32400`
- Tailscale: `http://100.x.x.x:32400`

### Step 3: Add to Crow

Set the following in your `.env` file or via **Crow's Nest** > **Settings** > **Integrations**:

```bash
PLEX_URL=http://your-plex-server:32400
PLEX_TOKEN=your-plex-token-here
```

## AI Tools

Once connected, interact with your Plex library through your AI:

> "What movies did I add this week?"

> "Show me what's On Deck"

> "Search my library for sci-fi movies"

> "Play Blade Runner on the living room Plex client"

> "What's currently playing?"

## Plex Pass Features

Some features require an active Plex Pass subscription:

| Feature | Plex Pass Required |
|---|---|
| Library search | No |
| Browse collections | No |
| On Deck | No |
| Playback control | No |
| Lyrics | Yes |
| Hardware transcoding | Yes |
| Live TV & DVR | Yes |

Crow's integration works with or without Plex Pass. Advanced features like Live TV are only available if your Plex subscription supports them.

## Optional: Self-host Plex with Docker

If you don't already have Plex running, you can install it as a Docker container:

```yaml
services:
  plex:
    image: plexinc/pms-docker:latest
    container_name: crow-plex
    ports:
      - "32400:32400"
    environment:
      - PLEX_CLAIM=${PLEX_CLAIM_TOKEN}
      - TZ=${TZ:-America/Chicago}
    volumes:
      - plex-config:/config
      - ${PLEX_MEDIA_PATH:-/media}:/media:ro
    restart: unless-stopped

volumes:
  plex-config:
```

Get a claim token from [plex.tv/claim](https://www.plex.tv/claim/) and set it as `PLEX_CLAIM_TOKEN` in your `.env` before the first run.

## Troubleshooting

### "Connection refused" or timeout

Make sure the `PLEX_URL` is reachable from the Crow server. Plex defaults to port 32400.

### "401 Unauthorized"

Your Plex Token may have expired or been revoked. Generate a new one using the steps above.

### Library appears empty

Plex needs to scan your media folders. Open the Plex web UI, go to your library, and click the refresh icon to trigger a scan.
