---
name: storage
description: File storage management — upload, organize, retrieve, quota monitoring
triggers:
  - upload file
  - store file
  - save image
  - download file
  - storage space
  - file management
tools:
  - crow-storage
---

# Storage Management

## When to Activate

- User wants to upload, store, or manage files
- User asks about storage space or quota
- User references an image or attachment for a blog post or research source
- User wants a download link for a file

## Workflow

### Upload a File

1. Check if storage is available: `crow_storage_stats`
2. For small files (<1MB): Use `crow_upload_file` with base64 data
3. For larger files: Use `crow_upload_file` without data to get a presigned upload URL, or direct the user to `POST /storage/upload`
4. Link files to other items using `reference_type` and `reference_id` (e.g., `blog_post`, `research_source`)

### Find and Share Files

1. `crow_list_files` — filter by MIME type, reference, or bucket
2. `crow_get_file_url` — generate a presigned download URL (configurable expiry)
3. Share the URL with the user

### Monitor Usage

1. `crow_storage_stats` — check quota usage
2. If approaching quota, suggest deleting unused files
3. `crow_delete_file` — remove files no longer needed

## Tips

- Always set `reference_type` when uploading files for blog posts (`blog_post`) or research (`research_source`)
- Use descriptive file names — they're preserved in the database
- Presigned URLs expire (default 1 hour) — generate fresh ones when needed
- MIME type validation blocks executables for security
- The Files panel in the Crow's Nest provides a visual file browser at `/dashboard/files`

## Safety

Destructive actions (file deletion, bulk operations) require user confirmation. See `skills/safety-guardrails.md` for the full checkpoint protocol.

## Error Handling

- If storage is not configured, tools return setup instructions — relay these to the user
- If quota is exceeded, suggest deleting old files before uploading new ones
