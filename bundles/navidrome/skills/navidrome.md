---
name: navidrome
description: Manage Navidrome music server — search songs, browse albums, manage playlists, stream music
triggers:
  - navidrome
  - music streaming
  - subsonic
  - play music
  - music library
  - albums
  - playlists
tools:
  - crow-navidrome
  - crow-memory
---

# Navidrome Music Server

## When to Activate

- User asks to search, browse, or play music
- User mentions Navidrome, Subsonic, or their music library
- User wants to see what's currently playing
- User asks about albums, artists, or playlists
- User wants to stream a specific song

## Workflow 1: Search and Stream

1. Use `crow_navidrome_search` with the user's query
   - Adjust `song_count`, `album_count`, `artist_count` based on what they're looking for
   - For "play [song]", focus on songs (set `album_count: 0`, `artist_count: 0`)
   - For "albums by [artist]", focus on albums
2. Present results organized by type (artists, albums, songs)
3. When the user picks a song, use `crow_navidrome_stream` with the `song_id`
4. For albums, use `crow_navidrome_get_album` first to show the track listing

## Workflow 2: Browse Albums

1. Use `crow_navidrome_albums` to list albums
   - `sort: "newest"` for recently added
   - `sort: "alphabeticalByName"` for A-Z browsing
   - `sort: "recent"` for recently played
   - `sort: "frequent"` for most played
   - `sort: "starred"` for favorites
2. Use pagination (size/offset) for large libraries
3. When the user picks an album, use `crow_navidrome_get_album` for full details

## Workflow 3: Explore Artists

1. Use `crow_navidrome_artists` to list all artists
2. Present with album counts
3. Use search to find specific artists

## Workflow 4: Manage Playlists

1. Use `crow_navidrome_playlists` with `action: "list"` to show existing playlists
2. Use `action: "create"` with a `name` to create a new playlist
3. Report song count and duration for each playlist

## Workflow 5: Check What's Playing

1. Use `crow_navidrome_now_playing` to see active sessions
2. Report the song, artist, album, and which user/player is listening
3. If nothing is playing, offer to help find music

## Tips

- Navidrome uses the Subsonic API with salt+token authentication
- Stream URLs include auth parameters; they're for direct playback, not for sharing publicly
- Song, album, and artist IDs are strings in Navidrome
- Store the user's music preferences in memory (favorite genres, artists, etc.)
- Duration is returned in seconds from the API and formatted as m:ss

## Error Handling

- If Navidrome is unreachable: "Can't connect to Navidrome at the configured URL. Make sure the server is running."
- If auth fails: "Navidrome rejected the credentials. Check NAVIDROME_USERNAME and NAVIDROME_PASSWORD in settings."
- If Subsonic API returns an error status: report the error message from the response
- If search returns no results: suggest broader search terms or browsing by category
