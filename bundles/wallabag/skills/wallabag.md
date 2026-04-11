---
name: wallabag
description: Manage Wallabag — save articles, search your reading list, organize with tags, and track reading progress
triggers:
  - wallabag
  - read later
  - save article
  - pocket alternative
  - article archive
  - reading list
  - save this link
  - bookmark article
tools:
  - crow-wallabag
  - crow-memory
---

# Wallabag Read-it-Later

## When to Activate

- User asks to save a URL or article for later reading
- User mentions Wallabag, reading list, or read-it-later
- User wants to search, browse, or organize saved articles
- User asks about starred or archived articles
- User wants to tag or categorize saved content

## Workflow 1: Save an Article

1. Use `crow_wallabag_save` with the URL
   - Optionally set `title` to override the auto-detected title
   - Add `tags` (comma-separated) for organization
   - Set `starred: true` for important articles
2. Confirm the article was saved with title and reading time estimate
3. Suggest tagging if the user didn't provide tags

## Workflow 2: Search Reading List

1. Use `crow_wallabag_search` with the user's query
   - Searches article titles and content
   - Filter with `archive: "0"` for unread, `"1"` for archived
   - Filter with `starred: "1"` for favorites
   - Filter by `tags` (comma-separated tag slugs)
2. Present results with titles, domains, reading times, and tags
3. When the user picks one, use `crow_wallabag_get` for full content

## Workflow 3: Browse Articles

1. Use `crow_wallabag_list` with filters:
   - `archive: "0"` for unread articles (default reading list)
   - `archive: "1"` for read/archived articles
   - `starred: "1"` for favorites
   - `tags`: filter by tag slugs
   - `sort`: "created", "updated", or "archived"
2. Use pagination for long lists
3. Help the user decide what to read next

## Workflow 4: Organize Articles

1. Use `crow_wallabag_update` to:
   - Mark as read: `archive: true`
   - Star/unstar: `starred: true/false`
   - Add tags: `tags: "tag1,tag2"` (replaces all tags)
   - Update title: `title: "Better Title"`
2. Batch operations: process multiple articles in sequence

## Workflow 5: Clean Up

1. List old unread articles with `crow_wallabag_list` sorted by `created` ascending
2. For each, ask the user: archive, delete, or keep?
3. Use `crow_wallabag_update` to archive or `crow_wallabag_delete` to remove
4. Deletion requires `confirm: "yes"` and is permanent

## Workflow 6: Reading Overview

1. Use `crow_wallabag_list` with `archive: "0"` to count unread
2. Use `crow_wallabag_list` with `starred: "1"` to show priorities
3. Summarize: unread count, starred count, top tags, oldest unread article

## Tips

- Wallabag fetches and stores the full article content; the original URL can go offline
- Reading time is estimated by Wallabag based on content length
- Tags are applied as comma-separated strings (e.g., "tech,ai,research")
- The `domain_name` field is useful for filtering by source
- Store the user's reading preferences in memory (favorite topics, reading habits)
- When saving from a conversation, extract URLs the user mentions naturally

## Error Handling

- If Wallabag is unreachable: "Can't connect to Wallabag at the configured URL. Make sure the server is running."
- If OAuth2 fails: "Wallabag rejected the credentials. Check WALLABAG_CLIENT_ID, WALLABAG_CLIENT_SECRET, WALLABAG_USERNAME, and WALLABAG_PASSWORD in settings. Create an API client in Wallabag under Developer > Create a new client."
- If an article is not found (404): the article may have been deleted
- If saving a URL fails: the URL may be behind a paywall or otherwise inaccessible to Wallabag
