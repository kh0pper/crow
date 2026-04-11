---
name: linkding
description: Manage Linkding bookmarks — save, tag, search, and organize web links
triggers:
  - linkding
  - bookmark
  - save link
  - bookmarks manager
  - organize links
  - tag link
tools:
  - crow-linkding
  - crow-memory
---

# Linkding Bookmark Manager

## When to Activate

- User asks to save, bookmark, or store a URL
- User mentions Linkding or their bookmark manager
- User wants to search or find saved links
- User asks to organize, tag, or manage bookmarks
- User wants to see recent bookmarks or browse by tag

## Workflow 1: Save a Bookmark

1. Use `crow_linkding_create` with the URL
   - If the user provides a title, pass it; otherwise Linkding auto-fetches it
   - Apply tags if the user mentions categories or topics
   - Set `unread: true` if the user says "read later" or "save for later"
2. Confirm the bookmark was saved with its title and tags

## Workflow 2: Search Bookmarks

1. Use `crow_linkding_search` with the user's query text
2. Present results with titles, URLs, tags, and descriptions
3. Use `#tagname` syntax in the query to filter by tag
4. Use pagination (limit/offset) for large result sets

## Workflow 3: Browse and Organize

1. Use `crow_linkding_list` to show recent bookmarks
2. Use `crow_linkding_get` to see full details of a specific bookmark
3. Use `crow_linkding_update` to add or change tags, titles, or descriptions
4. Help the user build a tagging system for their bookmarks

## Workflow 4: Delete a Bookmark

1. Always confirm with the user before deleting
2. Use `crow_linkding_get` to show the bookmark details first
3. Use `crow_linkding_delete` with `confirm: "yes"` only after user confirmation

## Workflow 5: Tag Management

1. Search by tag using `crow_linkding_search` with `#tagname` in the query
2. Help organize bookmarks by suggesting consistent tag names
3. Use `crow_linkding_update` to add missing tags to existing bookmarks

## Tips

- Linkding auto-fetches page titles and descriptions when creating bookmarks
- Use `#tag` syntax in search queries to filter by specific tags
- The `unread` flag is useful for "read later" workflows
- Archived bookmarks are hidden from the default view but still searchable
- Store the user's preferred tagging patterns in memory for consistency

## Error Handling

- If Linkding is unreachable: "Can't connect to Linkding at the configured URL. Make sure the server is running."
- If auth fails (401): "Linkding rejected the API token. Check LINKDING_API_TOKEN in settings. Generate a new token in Linkding Settings > Integrations."
- If a bookmark is not found (404): the bookmark may have been deleted
- If a duplicate URL is submitted: Linkding returns the existing bookmark
