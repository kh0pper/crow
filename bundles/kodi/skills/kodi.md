---
name: kodi
description: Remote control Kodi media center — playback, library browsing, queue management
triggers:
  - kodi
  - htpc
  - media player
  - watch movie
  - play music
  - what's playing
  - remote control
tools:
  - crow-kodi
  - crow-memory
---

# Kodi Remote Control

## When to Activate

- User asks to play, pause, stop, or skip media
- User wants to search movies, TV shows, or music
- User asks what's currently playing
- User mentions Kodi, HTPC, or media center
- User wants to browse their media library
- User wants to adjust volume or navigate the Kodi UI

## Workflow 1: Check What's Playing

1. Use `crow_kodi_now_playing` to get current playback info
2. Report title, progress, elapsed/total time, and playback state
3. If nothing is playing, let the user know and offer to help find something

## Workflow 2: Playback Control

1. Map the user's intent to a `crow_kodi_control` command:
   - "pause" / "resume" / "play" → `play_pause`
   - "stop" → `stop`
   - "skip" / "next" → `next`
   - "go back" / "previous" → `previous`
   - "fast forward" / "skip ahead" → `seek_forward` (value = seconds)
   - "rewind" / "go back 30 seconds" → `seek_backward` (value = seconds)
   - "volume up/down" / "set volume to 50" → `set_volume` (value = 0-100)
   - "mute" / "unmute" → `mute` / `unmute`
2. Confirm the action was taken

## Workflow 3: Search and Play

1. Use `crow_kodi_search` with the user's query and appropriate `media_type`
   - Movies: "watch", "movie", film titles
   - TV shows: "show", "series", show titles
   - Episodes: specific episode references
   - Music: "listen", "play song", "album", artist/song names
2. Present results with IDs
3. When the user picks one, use `crow_kodi_play` with the `media_type` and `id`
4. For direct URLs or file paths, use `crow_kodi_play` with the `file` parameter

## Workflow 4: Browse Library

1. Use `crow_kodi_browse` to list library contents
2. Support sorting: title, year, rating, recently added
3. Use pagination (limit/offset) for large libraries
4. Help the user pick something to watch/listen to

## Workflow 5: System Check

1. Use `crow_kodi_status` to verify Kodi is running and reachable
2. Report version, volume level, and whether anything is playing
3. If Kodi is unreachable, suggest checking:
   - Is Kodi running?
   - Is HTTP control enabled? (Settings > Services > Web server)
   - Is the KODI_URL correct?

## Tips

- Always check `crow_kodi_status` first if you're unsure whether Kodi is running
- When searching, try the most specific media_type first (e.g., "movie" not "episode")
- For music requests, search by "artist" first, then "album" or "song" for specifics
- Store the user's Kodi preferences in memory (preferred volume level, favorite genres, etc.)
- The `resume` flag on `crow_kodi_play` picks up where the user left off — useful for movies and episodes

## Error Handling

- If Kodi is unreachable: "Can't connect to Kodi at the configured URL. Make sure Kodi is running and HTTP control is enabled in Settings > Services > Web server."
- If auth fails: "Kodi rejected the credentials. Check KODI_USER and KODI_PASSWORD in settings."
- If a library search returns nothing: suggest checking that the library has been scanned (Kodi > Library > Update)
