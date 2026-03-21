---
title: IPTV
---

# IPTV

Manage M3U playlists, browse channels, and access electronic program guide (EPG) data through Crow.

## What You Get

- Load and manage M3U playlists
- Browse and search channels
- Organize favorites and channel groups
- View program guide (EPG) from XMLTV sources
- Media Hub integration for channel browsing

## Setup

No Docker container is required — IPTV runs as a lightweight bundle.

### Install the bundle

> "Crow, install the IPTV bundle"

Or install from the **Extensions** panel in the Crow's Nest.

## Adding Playlists

Add an M3U playlist URL through your AI or the IPTV panel:

> "Crow, add an IPTV playlist: https://example.com/playlist.m3u"

You can add multiple playlists. Each playlist's channels are merged into a single browsable list.

::: warning
Only use M3U playlists from services you have a legitimate subscription to. Crow does not provide or endorse any specific IPTV service.
:::

## Channel Management

### Browsing channels

Browse channels by group (as defined in the M3U playlist) or search by name:

> "Show me all news channels"

> "Search for BBC in my IPTV channels"

### Favorites

Mark channels as favorites for quick access:

> "Crow, add CNN to my IPTV favorites"

Favorites appear at the top of the channel list in the IPTV panel.

### Groups

Channels are organized by the groups defined in your M3U playlist (e.g., News, Sports, Movies). You can browse by group in the panel or ask:

> "Show me my Sports channels"

## Electronic Program Guide (EPG)

EPG data shows what's currently airing and upcoming programs for each channel.

### Adding an EPG source

Provide an XMLTV URL alongside your playlist:

> "Crow, set EPG source to https://example.com/epg.xml"

Or configure it in **Crow's Nest** > **Settings** > **Integrations**.

### Viewing the guide

> "What's on CNN right now?"

> "Show me tonight's schedule for BBC One"

The program guide is also available visually in the IPTV panel.

## Future Plans

- **Recording** — Scheduled recording via ffmpeg (planned for v2)

## Troubleshooting

### Playlist not loading

- Verify the M3U URL is accessible from your server (try opening it in a browser)
- Make sure the URL points to a valid `.m3u` or `.m3u8` file
- Some providers require authentication tokens in the URL

### EPG data missing

- XMLTV source URLs can go stale — verify the URL is still active
- EPG channel IDs must match the `tvg-id` attributes in your M3U playlist
- EPG data may take a few minutes to download and parse on first load

### Channels not playing

Crow manages playlists and metadata. Actual stream playback depends on your media player and network conditions. Make sure you can play the stream URL directly before troubleshooting the Crow integration.
