---
name: shiori
description: Manage Shiori bookmarks — save web pages with cached content for offline reading
triggers:
  - shiori
  - bookmark manager
  - save page
  - web clipper
  - cache page
  - offline reading
tools:
  - crow-shiori
  - crow-memory
---

# Shiori Bookmark Manager

## When to Activate

- User asks to save or archive a web page
- User mentions Shiori or offline reading
- User wants to clip or cache a page for later
- User asks to search or find saved pages
- User wants to organize bookmarks with tags

## Workflow 1: Save a Page

1. Use `crow_shiori_save` with the URL
   - Set `createArchive: true` (default) to cache the page content for offline reading
   - Set `createArchive: false` if the user only wants to bookmark without caching
   - Apply tags if the user mentions categories or topics
   - Provide a custom title if the user specifies one
2. Confirm the page was saved and whether it was archived

## Workflow 2: Search Bookmarks

1. Use `crow_shiori_search` with the user's keyword
2. Present results with titles, URLs, tags, and excerpts
3. Mention which bookmarks have archived content available
4. Use pagination (page number) for browsing through results

## Workflow 3: Browse Saved Pages

1. Use `crow_shiori_list` to show recent bookmarks
2. Use `crow_shiori_get` to see full details of a specific bookmark
3. Note whether the bookmark has cached content (`hasArchive`)
4. The user can view the cached version through the Shiori web UI

## Workflow 4: Organize Bookmarks

1. Use `crow_shiori_update` to add or change tags and titles
2. Help the user build a consistent tagging system
3. Suggest tags based on the page content and existing tags

## Workflow 5: Delete a Bookmark

1. Always confirm with the user before deleting
2. Use `crow_shiori_get` to show the bookmark details first
3. Warn that deletion also removes any cached/archived content
4. Use `crow_shiori_delete` with `confirm: "yes"` only after user confirmation

## Tips

- Shiori caches full page content by default, making pages available offline
- Cached pages preserve the original content even if the source page changes or goes down
- The Shiori web UI provides a reader view for cached content
- Default login credentials are shiori/gopher; remind users to change them
- Store the user's preferred tags in memory for consistent categorization
- Shiori is ideal for archiving important pages, research, and reference material

## Error Handling

- If Shiori is unreachable: "Can't connect to Shiori at the configured URL. Make sure the server is running."
- If auth fails: "Shiori login failed. Check SHIORI_USERNAME and SHIORI_PASSWORD in settings."
- If a bookmark is not found (404): the bookmark may have been deleted
- If archiving fails: the page may block automated access; try saving without archive
