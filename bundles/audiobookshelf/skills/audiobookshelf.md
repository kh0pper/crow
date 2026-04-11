---
name: audiobookshelf
description: Manage Audiobookshelf — search audiobooks and podcasts, track listening progress, browse library, get stream URLs
triggers:
  - audiobookshelf
  - audiobook
  - listen to book
  - podcast server
  - listening progress
  - audiobooks
  - what am I listening to
  - book recommendations
tools:
  - crow-audiobookshelf
  - crow-memory
---

# Audiobookshelf

## When to Activate

- User asks about audiobooks, podcasts, or listening progress
- User mentions Audiobookshelf or their audiobook library
- User wants to find or listen to a book or podcast
- User asks what they're currently listening to
- User wants to browse their audio library or collections

## Workflow 1: Search and Listen

1. Use `crow_audiobookshelf_search` with the user's query
   - Searches across all libraries (audiobooks and podcasts)
   - Returns titles, authors, narrators, and duration
2. Present results with relevant metadata
3. When the user picks one, use `crow_audiobookshelf_get_item` for full details (chapters, progress)
4. Use `crow_audiobookshelf_play` to get a stream/player URL
5. Recommend the web player URL for the best experience

## Workflow 2: Check Listening Progress

1. Use `crow_audiobookshelf_progress` to see all in-progress items
2. Present titles, authors, progress percentages, and time remaining
3. Offer to resume an item or find something new
4. Calculate remaining time: total duration minus current position

## Workflow 3: Browse Library

1. Use `crow_audiobookshelf_libraries` to list available libraries
2. Use `crow_audiobookshelf_browse` with a library ID to see items
   - Sort by `title`, `authorLF`, `addedAt`, `duration`, or `publishedYear`
   - Use pagination (page/limit) for large libraries
3. Help the user find their next listen

## Workflow 4: Explore Collections and Series

1. Use `crow_audiobookshelf_collections` with a library ID
2. Shows both user-created collections and auto-detected series
3. Use `crow_audiobookshelf_browse` with filters to see items in a series

## Workflow 5: Library Overview

1. Use `crow_audiobookshelf_libraries` to list libraries and their types
2. Use `crow_audiobookshelf_progress` for active listening
3. Use `crow_audiobookshelf_browse` with `sort: "addedAt"` for recently added
4. Summarize: library count, in-progress items, recent additions

## Tips

- Audiobookshelf tracks listening progress per-user automatically
- The web player URL (`/item/<id>`) provides the full playback experience with chapters
- Duration is returned in HH:MM:SS format
- Search works across titles, authors, narrators, and descriptions
- For podcasts, use `episode_id` with `crow_audiobookshelf_play` for specific episodes
- Store the user's listening preferences in memory (favorite genres, authors, preferred narrators)

## Error Handling

- If Audiobookshelf is unreachable: "Can't connect to Audiobookshelf at the configured URL. Make sure the server is running."
- If auth fails (401): "Audiobookshelf rejected the API token. Check AUDIOBOOKSHELF_API_KEY in settings. Generate a new token in Settings > Users > your user."
- If a library or item is not found (404): it may have been removed or the library rescanned
- If search returns no results: suggest browsing the library directly or checking the spelling
