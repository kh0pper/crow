---
name: kavita
description: Manage Kavita manga/comics/ebook server — search series, browse libraries, track reading progress
triggers:
  - kavita
  - manga
  - comics
  - comic reader
  - manga reader
  - ebooks
  - reading list
tools:
  - crow-kavita
  - crow-memory
---

# Kavita Manga/Comics/Ebook Server

## When to Activate

- User asks to search, browse, or read manga, comics, or ebooks
- User mentions Kavita or their reading library
- User wants to check reading progress or manage their want-to-read list
- User asks about recently added series

## Workflow 1: Search and Browse

1. Use `crow_kavita_search` with the user's query
2. Present results with names, formats, and library names
3. When the user picks one, use `crow_kavita_get_series` with the `series_id` for full details
4. Show metadata: summary, genres, tags, writers, page count

## Workflow 2: Browse Library

1. Use `crow_kavita_libraries` to list available libraries
2. Use `crow_kavita_browse` with the `library_id` to list series
3. Support pagination (page/page_size) for large libraries
4. Help the user find something to read

## Workflow 3: Reading Progress

1. Use `crow_kavita_reading_progress` with the `series_id`
2. Report pages read, total pages, and percent complete
3. If the user has unfinished series, suggest continuing

## Workflow 4: Want-to-Read List

1. Use `crow_kavita_want_to_read` with `action: "list"` to show the list
2. Use `action: "add"` with a `series_id` to add a series
3. Use `action: "remove"` with a `series_id` to remove a series
4. Confirm additions and removals

## Workflow 5: Recently Added

1. Use `crow_kavita_recently_added` to see new content
2. Optionally filter by `library_id`
3. Present names, formats, and page counts
4. Offer to show details or add to want-to-read list

## Tips

- Kavita uses JWT authentication; credentials are configured via KAVITA_USERNAME and KAVITA_PASSWORD
- Format types: Image, Archive, EPUB, PDF
- Store the user's reading preferences in memory (favorite genres, preferred format, etc.)
- Series IDs are numeric in Kavita

## Error Handling

- If Kavita is unreachable: "Can't connect to Kavita at the configured URL. Make sure the server is running."
- If auth fails (login error): "Kavita rejected the credentials. Check KAVITA_USERNAME and KAVITA_PASSWORD in settings."
- If a series is not found (404): the series may have been removed from the library
- Port 5000 conflicts are common; suggest changing the port if connection fails
