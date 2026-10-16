---
title: Audiobookshelf
---

# Audiobookshelf

Connect Crow to Audiobookshelf to search audiobooks and podcasts, track listening progress, and manage your audio library through your AI assistant.

## What You Get

- Search audiobooks and podcasts
- Browse libraries with sorting and pagination
- Track listening progress across devices
- Browse collections and series
- Get stream URLs for playback
- View audiobook details (chapters, duration, narrator)

## Setup

Crow supports two modes for Audiobookshelf: self-hosting via Docker or connecting to an existing instance.

### Option A: Docker (self-hosted)

Install Audiobookshelf as a Crow bundle. This runs Audiobookshelf in Docker alongside your Crow gateway.

> "Crow, install the Audiobookshelf bundle"

Or install from the **Extensions** panel in the Crow's Nest.

After installation, set the paths to your media directories:

```bash
# In your .env file
AUDIOBOOKSHELF_AUDIOBOOK_PATH=/path/to/your/audiobooks
AUDIOBOOKSHELF_PODCAST_PATH=/path/to/your/podcasts
```

Restart the bundle for changes to take effect:

> "Crow, restart the Audiobookshelf bundle"

Audiobookshelf will be available at `http://your-server:13378`. Create an admin account through the web UI on first launch, then generate an API key from **Settings** > **Users** > your user.

### Option B: Connect to existing Audiobookshelf

If you already run an Audiobookshelf instance, connect Crow to it directly.

#### Step 1: Get your API key

1. Open your Audiobookshelf web interface
2. Go to **Settings** > **Users**
3. Click on your user
4. Copy your API token

#### Step 2: Add to Crow

Set the following in your `.env` file or via **Crow's Nest** > **Settings** > **Integrations**:

```bash
AUDIOBOOKSHELF_URL=http://your-audiobookshelf-server:13378
AUDIOBOOKSHELF_API_KEY=your-api-key-here
```

## AI Tools

Once connected, you can interact with Audiobookshelf through your AI:

> "Search my audiobooks for Stephen King"

> "What am I currently listening to?"

> "Show me my podcast library"

> "How far am I in that audiobook?"

> "Play the next chapter"

## Troubleshooting

### "Connection refused" or timeout

Make sure the `AUDIOBOOKSHELF_URL` is reachable from the machine running Crow. If Audiobookshelf is on a different machine, use the correct IP or hostname.

### "401 Unauthorized"

The API token may have been invalidated. Regenerate it from Audiobookshelf **Settings** > **Users** > your user.

### Media files not appearing

Verify that the volume paths (`AUDIOBOOKSHELF_AUDIOBOOK_PATH` and `AUDIOBOOKSHELF_PODCAST_PATH`) are correct and that the directories contain properly organized media files. Audiobookshelf expects audiobooks in a `Author/Book Title/` folder structure. Trigger a library scan from the web UI if files were recently added.
