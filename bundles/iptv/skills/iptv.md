---
name: iptv
description: IPTV channel management — M3U playlists, EPG program guide, channel groups, and favorites
triggers:
  - iptv
  - tv channels
  - live tv
  - m3u
  - playlist
  - epg
  - program guide
  - channels
  - streaming
tools:
  - crow-iptv
---

# IPTV Management

## When to Activate

- User wants to add or manage IPTV playlists (M3U/M3U8)
- User asks about TV channels, live streaming, or program schedules
- User wants to browse channels by group or search for a channel
- User wants to favorite or unfavorite channels
- User asks about what's on TV (EPG lookup)

## Core Workflows

### Add a Playlist

1. `crow_iptv_add_playlist` with `url` and `name`
   - Fetches the M3U file, parses channels, stores in database
   - Returns channel count and group breakdown
   - Set `auto_refresh: true` if the playlist updates regularly

### Browse Channels

1. `crow_iptv_channels` — browse with filters
   - Filter by `playlist_id`, `group`, or `search` text
   - Set `favorites_only: true` to see only favorited channels
   - Supports pagination via `limit` and `offset`
   - Shows current program (now playing) when EPG data is available

### Check Program Guide

1. `crow_iptv_epg` with `channel_id`
   - Shows upcoming programs for the next `hours_ahead` hours (default 6)
   - Requires the channel to have a tvg_id mapped to EPG data

### Get Stream URL

1. `crow_iptv_stream_url` with `channel_id`
   - Returns the direct stream URL for playback in a media player

### Manage Favorites

1. `crow_iptv_favorite` with `channel_id` and `action` ("add" or "remove")
   - Favorited channels appear first in channel listings

## Tools Reference

| Tool | Purpose |
|------|---------|
| `crow_iptv_add_playlist` | Import M3U playlist from URL |
| `crow_iptv_list_playlists` | List all playlists with stats |
| `crow_iptv_channels` | Browse/search/filter channels |
| `crow_iptv_epg` | View EPG program schedule |
| `crow_iptv_stream_url` | Get stream URL for playback |
| `crow_iptv_favorite` | Toggle channel favorite status |

## Tips

- M3U playlists can contain hundreds of channels — use group filters to navigate
- EPG data must be loaded separately (XMLTV format) — not all playlists include EPG
- Stream URLs can be opened in VLC, mpv, or any media player that supports HTTP streams
- Favorites are pinned to the top of channel listings for quick access
