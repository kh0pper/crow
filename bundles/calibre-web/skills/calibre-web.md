---
name: calibre-web
description: Manage Calibre-Web — search, read, and organize ebooks with shelves and reading progress
triggers:
  - calibre-web
  - web reader
  - ebook reader
  - reading list
  - online books
tools:
  - crow-calibre-web
  - crow-memory
---

# Calibre-Web

## When to Activate

- User asks to search for, browse, or read ebooks online
- User mentions Calibre-Web or their web-based book reader
- User asks about reading lists, shelves, or reading progress
- User wants to download a book or read it in the browser
- User asks about their reading status or wants to mark books as read

## Workflow 1: Search and Read

1. Use `crow_calibreweb_search` with the user's query
2. Present results with titles, authors, and summaries
3. When the user picks a book, use `crow_calibreweb_get_book` for full details
4. Provide the reader URL for in-browser reading or download links for offline reading
5. Use `crow_calibreweb_download` to get format-specific download URLs

## Workflow 2: Browse Library

1. Use `crow_calibreweb_list_books` with different sort modes:
   - `new` for recently added
   - `rated` for highest rated
   - `hot` for most popular
   - `author` to browse by author
2. Present books with titles and authors
3. Help the user find something to read

## Workflow 3: Manage Shelves

1. Use `crow_calibreweb_shelves` to list available shelves
2. When the user wants to organize, use `crow_calibreweb_add_to_shelf` to add books
3. Shelves act as reading lists or collections

## Workflow 4: Track Reading Progress

1. Use `crow_calibreweb_reading_status` to check or set reading status
   - "read" for finished books
   - "reading" for in-progress books
   - "unread" for books not yet started
2. Help the user maintain their reading list

## Workflow 5: Download Books

1. Use `crow_calibreweb_get_book` to see available formats
2. Use `crow_calibreweb_download` with the desired format (epub, pdf, mobi)
3. Omit the format to get the web reader URL instead
4. Present both options: read online or download for offline reading

## Tips

- Calibre-Web provides an in-browser reader at `/read/BOOK_ID` for EPUB files
- Download URLs require authentication (the API key handles this)
- Shelves are user-created collections; suggest creating shelves for organization
- Store the user's reading preferences and current books in memory
- The web reader URL is the most convenient option for immediate reading
- OPDS feeds provide the underlying data; some features depend on Calibre-Web's version and configuration

## Error Handling

- If Calibre-Web is unreachable: "Cannot connect to Calibre-Web at the configured URL. Make sure the server is running."
- If auth fails (401/403): "Calibre-Web rejected the API key. Check CALIBRE_WEB_API_KEY in settings."
- If a book is not found: the book may have been removed from the library
- If shelves are empty: suggest creating shelves in the Calibre-Web interface
- If the reader URL doesn't work: the book format may not support in-browser reading (suggest downloading instead)
