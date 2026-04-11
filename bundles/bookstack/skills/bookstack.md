---
name: bookstack
description: Manage BookStack wiki — search content, browse shelves and books, create and edit pages, organize documentation
triggers:
  - bookstack
  - wiki
  - documentation
  - knowledge base wiki
  - write documentation
tools:
  - crow-bookstack
  - crow-memory
---

# BookStack Wiki

## When to Activate

- User asks to search, browse, or edit wiki content
- User mentions BookStack, wiki, or documentation platform
- User wants to create or update a documentation page
- User wants to organize knowledge into shelves, books, or chapters
- User asks about their wiki's structure or content

## Workflow 1: Search and Read

1. Use `crow_bookstack_search` with the user's query
2. Present results with names, types, and preview text
3. When the user picks a page, use `crow_bookstack_get_page` with the page ID
4. Content is returned as markdown (preferred) or HTML
5. Summarize or display the content as requested

## Workflow 2: Browse Structure

1. Use `crow_bookstack_shelves` to list top-level shelves
2. Use `crow_bookstack_books` to list books (all or within a shelf)
3. Use `crow_bookstack_chapters` with a `book_id` to see chapters and pages within a book
4. Support pagination with count/offset for large wikis
5. Help the user navigate to the content they need

## Workflow 3: Create Content

1. Confirm the target location: which book or chapter to create the page in
2. If the user hasn't specified, use `crow_bookstack_books` to list available books
3. Use `crow_bookstack_create_page` with:
   - `book_id` or `chapter_id` (one is required)
   - `name` for the page title
   - `markdown` for content (preferred over HTML)
4. Confirm the page was created and provide its ID

## Workflow 4: Edit Content

1. Use `crow_bookstack_get_page` to fetch current content
2. Apply the user's requested changes
3. Use `crow_bookstack_update_page` with the modified content
4. Provide only the fields that changed (name, markdown, or html)
5. Confirm the update was applied

## Workflow 5: Delete Content

1. Always confirm with the user before deletion (this is irreversible)
2. Use `crow_bookstack_delete` with:
   - `id` of the page or chapter
   - `type` set to "page" or "chapter"
   - `confirm` set to "yes"
3. Warn that deleting a chapter also removes all its pages

## Tips

- BookStack uses a hierarchy: Shelves > Books > Chapters > Pages
- Pages can live directly in a book (no chapter) or inside a chapter
- The search endpoint searches across all content types (pages, chapters, books, shelves)
- Use markdown format for creating and updating pages when possible
- BookStack preserves revision history, so updates are non-destructive
- Store the user's frequently used book/chapter IDs in memory for quick access

## Error Handling

- If BookStack is unreachable: "Can't connect to BookStack at the configured URL. Make sure the server is running."
- If auth fails (401): "BookStack rejected the API token. Check BOOKSTACK_TOKEN_ID and BOOKSTACK_TOKEN_SECRET in settings. Create tokens in BookStack under Settings > API Tokens."
- If permission denied (403): "The API token doesn't have access to this resource. Check the token's permissions in BookStack."
- If not found (404): the page, chapter, or book may have been deleted
