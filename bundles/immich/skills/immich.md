---
name: immich
description: Search and manage photos in your Immich photo library
triggers:
  - photos
  - pictures
  - album
  - immich
  - photo library
tools:
  - immich
  - crow-memory
---

# Immich Photo Library

## When to Activate

- User asks about photos, pictures, or albums
- User wants to search their photo library
- User mentions Immich
- User wants to organize photos into albums

## Workflow 1: Search Photos

1. Ask what the user is looking for (or use their query directly)
2. Use `immich_search_photos` with appropriate filters:
   - Text query for semantic search (searches CLIP embeddings)
   - Date range for time-based searches
   - City/country for location-based searches
3. Present results with filename, date, and location

## Workflow 2: Browse Albums

1. `immich_list_albums` to show all albums
2. `immich_get_album` for details on a specific album
3. Present album contents with photo counts and date ranges

## Workflow 3: Organize Photos

1. Create new albums with `immich_create_album`
2. Help the user organize by suggesting album groupings based on:
   - Dates (trips, events)
   - Locations (cities, countries)
   - Themes (from search results)

## Tips

- Immich's smart search uses CLIP embeddings — natural language queries work well (e.g., "sunset at the beach", "birthday cake")
- Store album names and common search patterns in Crow memory
- Photo metadata includes GPS coordinates — useful for travel-related queries
- Immich has its own Docker stack — this bundle connects to an existing instance, it doesn't deploy Immich itself

## ARM64 Compatibility Note

Immich's Docker images have historically had limited ARM64 support. Verify your Immich version supports ARM64 before running on Raspberry Pi or other ARM devices. Check [Immich's GitHub releases](https://github.com/immich-app/immich/releases) for the latest compatibility information.

## Error Handling

- If Immich is unreachable: "Can't connect to Immich. Check that your Immich server is running and IMMICH_URL is correct."
- If API key is invalid: "Immich authentication failed. Verify your IMMICH_API_KEY in the settings."
