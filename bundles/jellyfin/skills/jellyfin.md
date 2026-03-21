---
name: jellyfin
description: Manage Jellyfin media server — search library, stream media, control playback, browse collections
triggers:
  - jellyfin
  - stream movie
  - stream music
  - media server
  - watch something
  - what's streaming
  - media library
tools:
  - crow-jellyfin
  - crow-memory
---

# Jellyfin Media Server

## When to Activate

- User asks to search, browse, or stream movies, TV shows, or music
- User mentions Jellyfin or their media server/library
- User asks what's currently playing or who's watching
- User wants to control playback on a Jellyfin client
- User wants to see their library stats or recently added content

## Workflow 1: Search and Stream

1. Use `crow_jellyfin_search` with the user's query
   - Movies: set `media_types` to `["Movie"]`
   - TV shows: set `media_types` to `["Series"]` or `["Episode"]`
   - Music: set `media_types` to `["Audio"]` or `["MusicAlbum"]`
   - Leave `media_types` empty to search everything
2. Present results with names, years, ratings, and genres
3. When the user picks one, use `crow_jellyfin_play` with the `item_id` to get a stream URL
4. For items with multiple audio tracks or subtitles, use `crow_jellyfin_get_item` first to show available streams

## Workflow 2: Browse Library

1. Use `crow_jellyfin_collections` to list available libraries
2. Use `crow_jellyfin_browse` with the collection's `itemId` as `parent_id`
3. Support sorting by name, date added, or community rating
4. Use pagination (limit/offset) for large libraries
5. Help the user pick something to watch/listen to

## Workflow 3: Check What's Playing

1. Use `crow_jellyfin_now_playing` to see active sessions
2. Report what's playing, who's watching, on which device, and progress
3. If nothing is playing, offer to help find something

## Workflow 4: Remote Control

1. Use `crow_jellyfin_now_playing` to get the `sessionId`
2. Map user intent to `crow_jellyfin_control` commands:
   - "pause" / "resume" / "play" → `PlayPause`
   - "stop" → `Stop`
   - "next" / "skip" → `NextTrack`
   - "previous" / "go back" → `PreviousTrack`
   - "skip to 30 minutes" → `Seek` (value in ticks: seconds * 10,000,000)
   - "set volume to 50" → `SetVolume` (value 0-100)
3. Confirm the action was taken

## Workflow 5: Library Overview

1. Use `crow_jellyfin_collections` to list libraries
2. Use `crow_jellyfin_browse` with `sort_by: "DateCreated"` for recently added
3. Summarize: number of movies, shows, albums, and recent additions

## Tips

- Jellyfin uses ticks (10,000,000 ticks = 1 second) for time positions in seek commands
- Always get the session ID from `crow_jellyfin_now_playing` before sending control commands
- Use `crow_jellyfin_get_item` to check available audio/subtitle streams before playing
- Store the user's media preferences in memory (favorite genres, preferred audio language, etc.)
- Stream URLs include the API key — they're for direct playback, not for sharing publicly

## Error Handling

- If Jellyfin is unreachable: "Can't connect to Jellyfin at the configured URL. Make sure the server is running."
- If auth fails (401): "Jellyfin rejected the API key. Check JELLYFIN_API_KEY in settings. You can generate a new key in Jellyfin Dashboard > API Keys."
- If an item is not found (404): the item may have been removed from the library
- If no user ID is set and browsing fails: suggest setting JELLYFIN_USER_ID in the bundle settings
