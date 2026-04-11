---
name: miniflux
description: Manage Miniflux RSS reader — subscribe to feeds, read articles, track news, and manage bookmarks
triggers:
  - miniflux
  - RSS
  - feeds
  - news reader
  - subscribe
  - unread articles
  - news feed
  - bookmarked articles
tools:
  - crow-miniflux
  - crow-memory
---

# Miniflux RSS Reader

## When to Activate

- User asks about RSS feeds, news, or articles
- User mentions Miniflux or their RSS reader
- User wants to subscribe to a website or blog
- User asks to check unread articles or bookmarked items
- User wants a news summary or digest

## Workflow 1: Check Unread Articles

1. Use `crow_miniflux_entries` with `status: "unread"` to list unread articles
2. Present titles, feeds, and publish dates
3. When the user wants to read one, use `crow_miniflux_get_entry` with the entry ID
4. After reading, offer to mark it as read with `crow_miniflux_mark_read`

## Workflow 2: Subscribe to a Feed

1. Use `crow_miniflux_add_feed` with the user's URL
   - Miniflux auto-discovers RSS/Atom from web page URLs
2. If the user wants it in a specific category, list feeds first with `crow_miniflux_feeds` to find available category IDs
3. Confirm the subscription was created

## Workflow 3: Browse Feeds

1. Use `crow_miniflux_feeds` to list all subscriptions with unread counts
2. Use `crow_miniflux_entries` with `feed_id` to see entries from a specific feed
3. Support pagination with limit/offset for large feeds
4. Use the `search` parameter to find entries by keyword

## Workflow 4: Manage Starred/Bookmarks

1. Use `crow_miniflux_entries` with `starred: true` to list bookmarked articles
2. Use `crow_miniflux_star` to toggle the bookmark on an entry
3. Starred articles persist across read/unread status changes

## Workflow 5: News Digest

1. Use `crow_miniflux_entries` with `status: "unread"` and a reasonable limit
2. Summarize the headlines by feed or topic
3. Offer to read specific articles in full
4. Mark reviewed entries as read with `crow_miniflux_mark_read`

## Workflow 6: Remove a Feed

1. Use `crow_miniflux_feeds` to find the feed ID
2. Confirm the feed name with the user before removing
3. Use `crow_miniflux_remove_feed` with `confirm: "yes"`

## Tips

- Miniflux auto-discovers feed URLs from regular website URLs during subscription
- The `reading_time` field gives estimated read time in minutes
- Use `search` in `crow_miniflux_entries` to find articles by keyword across all feeds
- Store the user's reading preferences in memory (favorite feeds, topics of interest)
- Category IDs from the feeds list can be used to filter entries by topic

## Error Handling

- If Miniflux is unreachable: "Can't connect to Miniflux at the configured URL. Make sure the server is running."
- If auth fails (401): "Miniflux rejected the API key. Check MINIFLUX_API_KEY in settings. Generate a new key in Miniflux Settings > API Keys."
- If a feed URL is invalid: Miniflux returns a descriptive error about the feed format
- If a feed already exists: Miniflux returns an error indicating the duplicate subscription
