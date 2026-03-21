---
name: trilium
description: Manage TriliumNext knowledge base — search notes, organize knowledge, clip web pages, daily journal
triggers:
  - trilium
  - notes
  - knowledge base
  - wiki
  - clip web page
  - journal entry
  - day note
tools:
  - crow-trilium
  - crow-memory
---

# TriliumNext Knowledge Base

## When to Activate

- User asks to search, create, or organize notes
- User mentions TriliumNext, Trilium, or their knowledge base/wiki
- User wants to clip a web page or save research
- User asks about their day note or daily journal
- User wants to browse their note tree or find recent notes
- User asks to export a note

## Workflow 1: Search and Read Notes

1. Use `crow_trilium_search` with the user's query
   - For exact title matches: set `fast_search` to `true`
   - For content search: leave `fast_search` as `false` (default)
2. Present results with titles, types, and modification dates
3. When the user picks one, use `crow_trilium_get_note` to retrieve full content
4. For code notes, display the content in a code block

## Workflow 2: Create and Organize Notes

1. Ask where to put the note — use `crow_trilium_browse_tree` to show available locations
2. Use `crow_trilium_create_note` with:
   - `parent_note_id`: chosen parent (default "root")
   - `type`: "text" for rich notes, "code" for code snippets, "book" for containers
   - `content`: HTML for text notes, plain text for code notes
3. Confirm creation with the note ID
4. Store the note ID in Crow memory if it's an important reference

## Workflow 3: Web Clipping

1. When the user shares a URL to save:
   - Use `crow_trilium_clip_web` with the URL
   - Optionally set a custom `title` and `parent_note_id`
2. The clip extracts text content and saves it with a source link
3. Suggest organizing the clip into an appropriate parent note

## Workflow 4: Daily Journal

1. Use `crow_trilium_day_note` to get/create today's entry
   - For past dates, provide the `date` parameter (YYYY-MM-DD)
2. Use `crow_trilium_get_note` to read the day note's content
3. Use `crow_trilium_update_note` to append or update journal entries

## Workflow 5: Browse and Explore

1. Use `crow_trilium_browse_tree` to show the note hierarchy
   - Start at "root" for top-level structure
   - Increase `depth` (max 5) for deeper exploration
2. Use `crow_trilium_get_attributes` to see labels and relations on a note
3. Help the user navigate their knowledge structure

## Workflow 6: Export Notes

1. Use `crow_trilium_export` with the desired format
   - "html" for web-ready output
   - "markdown" for plain text / documentation use
2. Present the exported content to the user

## Workflow 7: Research Capture

When capturing research findings into TriliumNext:

1. Search existing notes first to avoid duplicates (`crow_trilium_search`)
2. Create a structured note with the research content
3. Use `crow_trilium_get_attributes` to check for existing tags/labels
4. Store a cross-reference in Crow memory linking the research to the note ID

## Tips

- TriliumNext uses HTML for text note content — wrap content in `<p>` tags
- Note IDs are short alphanumeric strings (e.g., "abc123def")
- "Book" type notes are containers that hold child notes
- Protected notes cannot be read via ETAPI — inform the user if access fails
- The root note is always "root" — use it as the default parent
- Day notes are automatically organized under a date hierarchy by TriliumNext
- Store important note IDs in Crow memory for quick cross-session reference

## Error Handling

- If TriliumNext is unreachable: "Can't connect to TriliumNext at the configured URL. Make sure the server is running."
- If auth fails (401): "TriliumNext rejected the ETAPI token. Check TRILIUM_ETAPI_TOKEN in settings. You can generate a new token in Options > ETAPI."
- If a note is not found (404): the note may have been deleted or the ID is incorrect
- If a note is protected: "This note is protected and cannot be accessed via ETAPI."
