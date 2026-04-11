---
name: paperless
description: Manage Paperless-ngx — search documents, upload scans, tag and organize your digital archive
triggers:
  - paperless
  - document scanner
  - OCR
  - scan document
  - document archive
  - digitize
  - find receipt
  - search documents
tools:
  - crow-paperless
  - crow-memory
---

# Paperless-ngx Document Management

## When to Activate

- User asks to search, find, or look up a document, receipt, or scan
- User mentions Paperless, OCR, scanning, or document archiving
- User wants to upload, tag, or organize documents
- User asks about correspondents, document types, or tags
- User wants to digitize or archive paper documents

## Workflow 1: Search Documents

1. Use `crow_paperless_search` with the user's query
   - Searches OCR content, titles, tags, and correspondents
   - Use `ordering` to sort by date, title, or modification time
2. Present results with titles, correspondents, tags, and creation dates
3. When the user picks one, use `crow_paperless_get` for full metadata and content preview
4. Offer to download the original or archived version via `crow_paperless_download`

## Workflow 2: Browse and Filter

1. Use `crow_paperless_list` with filters:
   - `tags`: filter by tag IDs (get IDs from `crow_paperless_tags`)
   - `correspondent`: filter by correspondent ID
   - `document_type`: filter by document type ID
   - `created_after` / `created_before`: filter by date range
2. Use pagination for large result sets
3. Help the user narrow down what they are looking for

## Workflow 3: Upload a Document

1. Use `crow_paperless_upload` with:
   - `content_base64`: the file content encoded as base64
   - `filename`: original filename (e.g., "invoice-2026.pdf")
   - Optional: `title`, `tags`, `correspondent`
2. Paperless-ngx processes the upload asynchronously (OCR, classification)
3. Inform the user that processing happens in the background

## Workflow 4: Organize Documents

1. To tag documents: first list available tags with `crow_paperless_tags` (action: "list")
2. Create new tags with `crow_paperless_tags` (action: "create", name: "...")
3. Update documents with `crow_paperless_update` to assign tags, correspondents, or titles
4. Create correspondents with `crow_paperless_correspondents` (action: "create") if needed

## Workflow 5: Overview

1. List tags with `crow_paperless_tags` to see categories and document counts
2. List correspondents with `crow_paperless_correspondents` for sender/source overview
3. Use `crow_paperless_list` with `-created` ordering for recent documents
4. Summarize the archive: total documents, top tags, recent activity

## Tips

- Paperless-ngx automatically OCRs uploaded documents; results appear in search after processing
- Tags can have colors; use `color` parameter when creating tags for visual organization
- The `archive_serial_number` field is useful for physical filing systems
- Upload supports PDF, images (JPEG, PNG, TIFF), and other document formats
- Store the user's filing preferences in memory (preferred tags, naming conventions)
- Document IDs are integers, tag IDs are integers; get them from list/search results

## Error Handling

- If Paperless-ngx is unreachable: "Can't connect to Paperless-ngx at the configured URL. Make sure the server is running."
- If auth fails (401): "Paperless rejected the API token. Check PAPERLESS_API_TOKEN in settings. Generate a new token in Paperless-ngx Settings > API Tokens."
- If a document is not found (404): the document may have been deleted
- If upload times out: large files may take longer; the document might still be processing
