---
title: Kodi
---

# Kodi

Control your Kodi media center remotely through Crow — browse libraries, manage playback, and check what's playing, all via your AI assistant.

## What You Get

- Remote control for Kodi playback (play, pause, stop, skip, volume)
- Search and browse media libraries
- View currently playing media
- Library navigation (movies, TV shows, music)
- Automatic **Remote** tab in the Media Hub panel

## Setup

### Step 1: Enable HTTP remote control in Kodi

1. Open Kodi on the device you want to control
2. Go to **Settings** > **Services** > **Control**
3. Enable **Allow remote control via HTTP**
4. Set a **Port** (default: 8080)
5. Optionally set a **Username** and **Password** for authentication

::: tip
If you set a username and password in Kodi, include them in the URL: `http://user:password@192.168.1.100:8080`
:::

### Step 2: Add to Crow

Set the Kodi URL in your `.env` file or via **Crow's Nest** > **Settings** > **Integrations**:

```bash
KODI_URL=http://192.168.1.100:8080
```

If you configured authentication in Kodi:

```bash
KODI_URL=http://kodi:mypassword@192.168.1.100:8080
```

## AI Tools

Once connected, control Kodi through your AI:

> "What's playing on Kodi?"

> "Pause Kodi"

> "Search Kodi for The Matrix"

> "Play the next episode"

> "Turn up the volume on Kodi"

> "Browse my Kodi movie library"

## Dashboard Panel

When Kodi is connected, the Media Hub panel adds a **Remote** tab with:

- **Now Playing** — current media with thumbnail, title, and progress
- **Transport controls** — play, pause, stop, skip, volume
- **Library browser** — browse movies, TV shows, and music by category

## Media Hub Integration

The Kodi remote tab appears automatically in the Media Hub alongside other media integrations (Jellyfin Library, Plex, IPTV). All your media sources in one place.

## Troubleshooting

### "Connection refused" or timeout

- Verify that HTTP remote control is enabled in Kodi (Settings > Services > Control)
- Make sure the port matches what you configured (default: 8080)
- Check that the Kodi device is reachable from your Crow server

### "401 Unauthorized"

If you set a username and password in Kodi's HTTP settings, make sure they're included in the `KODI_URL`.

### Commands not working

- Kodi must be running and not in a screensaver or standby state
- Some commands only work during playback (e.g., pause, skip)
- If Kodi is on a different network, use Tailscale to bridge the connection
