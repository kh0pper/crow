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
4. Link files to other items using `reference_type` and `reference_id` (e.g., `research_source`). Only the owner attaches files to blog posts (`blog_post`): a bot's upload with that reference type is refused.

### Find and Share Files

1. `crow_list_files` — filter by MIME type, reference, or bucket
2. `crow_get_file_url` — generate a presigned download URL (configurable expiry)
3. Share the URL with the user

### Monitor Usage

1. `crow_storage_stats` — check quota usage
2. If approaching quota, suggest deleting unused files
3. `crow_delete_file` — remove files no longer needed

## Tips

- Set `reference_type` when uploading files for research (`research_source`). `blog_post` is the owner's to set: a bot asking for it is refused ("Only the owner can attach files to blog posts."), because it is how a file becomes public.
- A `blog_post` file is served at `/blog/media/<key>` only once a published public post uses it — as its cover image, or linked in its text (`/blog/media/<key>` or `storage:<key>`). A `reference_id` alone publishes nothing: the uploader supplies it. Until a post uses the file, the URL is a 404.
- What comes back inline is a raster image, audio, video or a `.sunvox` project. Anything else (HTML, SVG, PDF) is served as a download, so hosting a page on the blog origin is not a thing a file upload can do.
- Use descriptive file names — they're preserved in the database
- Presigned URLs expire (default 1 hour) — generate fresh ones when needed
- MIME type validation blocks executables for security
- The Files panel in the Crow's Nest provides a visual file browser at `/dashboard/files`

## Safety

Destructive actions (file deletion, bulk operations) require user confirmation. See `skills/safety-guardrails.md` for the full checkpoint protocol.

## Error Handling

- If storage is not configured, tools return setup instructions — relay these to the user
- If quota is exceeded, suggest deleting old files before uploading new ones
