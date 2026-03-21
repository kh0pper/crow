---
name: plex
description: Manage Plex Media Server — search library, browse collections, control playback, view sessions
triggers:
  - plex
  - plex server
  - stream movie
  - stream music
  - what's on deck
  - continue watching
  - media library
tools:
  - crow-plex
  - crow-memory
---

# Plex Media Server

## When to Activate

- User asks to search, browse, or stream movies, TV shows, or music
- User mentions Plex or their media server
- User asks what's on deck or what to continue watching
- User asks what's currently playing or who's streaming
- User wants to control playback on a Plex client
- User wants to see their library sections

## Workflow 1: Search and Play

1. Use `crow_plex_search` with the user's query
   - Movies: set `media_type` to `movie`
   - TV shows: set `media_type` to `show`
   - Episodes: set `media_type` to `episode`
   - Music: set `media_type` to `artist`, `album`, or `track`
   - Leave `media_type` empty to search everything
2. Present results with titles, years, ratings, and genres
3. When the user picks one, use `crow_plex_play` with the `rating_key`
4. If no `client_id` is given, `crow_plex_play` will list available clients — ask the user to pick one
5. For detailed info before playing, use `crow_plex_get_item` to see media streams, cast, etc.

## Workflow 2: Browse Library

1. Use `crow_plex_libraries` to list available sections
2. Use `crow_plex_browse` with the section's `id` as `section_id`
3. Support sorting: titleSort (alphabetical), addedAt (newest), rating, year, lastViewedAt
4. Use pagination (limit/offset) for large libraries
5. Help the user pick something to watch/listen to

## Workflow 3: Continue Watching (On Deck)

1. Use `crow_plex_on_deck` to see items ready to resume
2. Report titles, progress, and which show/season for TV episodes
3. Offer to play the top item or let the user pick

## Workflow 4: Remote Control

1. First get available clients: call `crow_plex_play` with just a dummy `rating_key` and no `client_id` to list clients
2. Map user intent to `crow_plex_control` commands:
   - "pause" → `pause`
   - "resume" / "play" → `play`
   - "stop" → `stop`
   - "next" / "skip" → `skipNext`
   - "previous" / "go back" → `skipPrevious`
   - "skip to 30 minutes" → `seekTo` (value in milliseconds: 30 * 60 * 1000 = 1800000)
   - "set volume to 50" → `setVolume` (value 0-100)
3. Always provide the `client_id` — ask the user which client if multiple are available

## Workflow 5: Active Sessions

1. Check the Plex panel in the Crow's Nest for a visual overview
2. Or use `crow_plex_libraries` to see section details + the user can check the panel

## Getting the PLEX_TOKEN

Guide the user through finding their Plex token:

1. Open https://app.plex.tv in a web browser and sign in
2. Open browser Developer Tools (F12 or Cmd+Option+I)
3. Go to the **Network** tab
4. Navigate to any page in the Plex web app (e.g., click on a library)
5. Look at any API request — find the `X-Plex-Token` parameter in the URL or headers
6. Copy the token value and set it as `PLEX_TOKEN` in the bundle settings

Alternative method:
1. Open any media item in Plex Web
2. Click the three-dot menu and select "Get Info"
3. Click "View XML" at the bottom
4. The token appears in the URL as `X-Plex-Token=...`

## Tips

- Plex uses milliseconds for seek positions (not seconds or ticks)
- Always list clients before trying to play — Plex needs a target client
- Store the user's Plex preferences in memory (favorite libraries, preferred client, etc.)
- The On Deck list is a great starting point when the user asks "what should I watch?"
- Some features (e.g., hardware transcoding, lyrics) require Plex Pass — if a tool returns a Plex Pass error, let the user know

## Error Handling

- If Plex is unreachable: "Can't connect to Plex at the configured URL. Make sure the server is running."
- If auth fails (401): "Plex rejected the token. Check PLEX_TOKEN in settings. You can find a new token by inspecting API requests at app.plex.tv (see setup instructions)."
- If no clients are available: "No Plex clients are online. Open Plex on a device (phone, TV, computer) first."
- If an item is not found (404): the item may have been removed from the library or the library needs refreshing
