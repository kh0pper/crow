---
title: Navidrome
---

# Navidrome

Connect Crow to Navidrome to browse your music library, search artists and albums, manage playlists, and stream music through your AI assistant.

## What You Get

- Search songs, albums, and artists
- Browse albums with sorting (newest, alphabetical, recent)
- View album details with track listings
- Create and manage playlists
- Get stream URLs for playback
- See what's currently playing

## Setup

Crow supports two modes for Navidrome: self-hosting via Docker or connecting to an existing instance.

### Option A: Docker (self-hosted)

Install Navidrome as a Crow bundle. This runs Navidrome in Docker alongside your Crow gateway.

> "Crow, install the Navidrome bundle"

Or install from the **Extensions** panel in the Crow's Nest.

After installation, set the path to your music directory:

```bash
# In your .env file
NAVIDROME_MUSIC_PATH=/path/to/your/music
```

Restart the bundle for changes to take effect:

> "Crow, restart the Navidrome bundle"

Navidrome will be available at `http://your-server:4533`. Create an admin account through the web UI on first launch.

### Option B: Connect to existing Navidrome

If you already run a Navidrome instance, connect Crow to it directly. Navidrome uses the Subsonic API for programmatic access.

#### Step 1: Note your credentials

Crow authenticates with Navidrome using your username and password via the Subsonic API.

#### Step 2: Add to Crow

Set the following in your `.env` file or via **Crow's Nest** > **Settings** > **Integrations**:

```bash
NAVIDROME_URL=http://your-navidrome-server:4533
NAVIDROME_USERNAME=your-username
NAVIDROME_PASSWORD=your-password
```

## AI Tools

Once connected, you can interact with Navidrome through your AI:

> "Search my music for jazz albums"

> "Show me recently added albums"

> "Create a playlist called Road Trip"

> "Play that song"

> "What albums do I have by Miles Davis?"

## Subsonic API Compatibility

Navidrome implements the Subsonic API, which means it works with any Subsonic-compatible client (DSub, Symfonium, play:Sub, Ultrasonic, and others) alongside Crow. You can use these apps for mobile playback while managing your library through your AI.

## Troubleshooting

### "Connection refused" or timeout

Make sure the `NAVIDROME_URL` is reachable from the machine running Crow. If Navidrome is on a different machine, use the correct IP or hostname.

### Authentication failed

Verify that `NAVIDROME_USERNAME` and `NAVIDROME_PASSWORD` are correct. Try logging in through the Navidrome web UI with the same credentials to confirm they work.

### Music not appearing

Navidrome needs to scan your music library after you set `NAVIDROME_MUSIC_PATH`. Open the Navidrome web UI and trigger a library scan from the admin settings. Navidrome supports MP3, FLAC, OGG, AAC, and other common formats.
