---
name: calibre-server
description: Manage Calibre content server — search, browse, and download ebooks from your Calibre library
triggers:
  - calibre
  - ebook server
  - OPDS
  - calibre library
  - book library
tools:
  - crow-calibre-server
  - crow-memory
---

# Calibre Content Server

## When to Activate

- User asks to search for, browse, or download ebooks
- User mentions Calibre or their ebook library
- User asks about available books, authors, series, or tags
- User wants to download a book in a specific format
- User wants to browse books by category (author, tag, series, publisher)

## Workflow 1: Search Books

1. Use `crow_calibre_search` with the user's query
2. Present results with titles, authors, tags, and available formats
3. When the user picks a book, use `crow_calibre_get_book` for full details
4. Offer to download in their preferred format with `crow_calibre_download`

## Workflow 2: Browse by Category

1. Use `crow_calibre_list_categories` to show available category types (authors, tags, series, publishers)
2. Use `crow_calibre_browse_category` with the category type to list items (e.g., all authors)
3. Use `crow_calibre_browse_category` with both `category` and `item_id` to list books by that author/tag/series
4. Support pagination with limit/offset for large collections

## Workflow 3: Get Book Details

1. Use `crow_calibre_get_book` with the book ID
2. Show title, authors, description/comments, tags, series info, and available formats
3. Include identifiers (ISBN, etc.) if available
4. If the user wants to read it, offer download links via `crow_calibre_download`

## Workflow 4: Download Book

1. Ask which format the user prefers (EPUB, PDF, MOBI, AZW3, etc.)
2. Use `crow_calibre_get_book` to check available formats
3. Use `crow_calibre_download` to get the download URL
4. Present the direct download link

## Workflow 5: Library Overview

1. Use `crow_calibre_list_books` with `sort_by: "timestamp"` and `sort_order: "desc"` for recently added
2. Use `crow_calibre_list_categories` to show category counts
3. Summarize: total books, top categories, recent additions

## Tips

- The Calibre content server uses book IDs (integers) as identifiers
- Available formats depend on what the user has in their library (EPUB, PDF, MOBI, AZW3, TXT, CBZ, etc.)
- Download URLs can be opened directly in a browser
- If authentication is enabled, download URLs require the same credentials
- Use pagination for large libraries to avoid timeouts
- Store the user's format preferences in memory for future downloads

## Error Handling

- If Calibre is unreachable: "Cannot connect to Calibre at the configured URL. Make sure the content server is running."
- If auth fails (401): "Calibre rejected the credentials. Check CALIBRE_USERNAME and CALIBRE_PASSWORD in settings."
- If a book is not found: the book may have been removed from the library
- If a format is not available: show available formats and let the user choose another
