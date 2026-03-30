---
title: Storage Server
---

# Storage Server

The storage server (`servers/storage/`) provides S3-compatible file storage through MCP tools and HTTP endpoints. It connects to MinIO (or any S3-compatible service) for object storage and tracks file metadata in SQLite.

## Architecture

```
┌──────────────────────────────────────┐
│           MCP Tools Layer            │
│  crow_upload_file  crow_list_files   │
│  crow_get_file_url crow_delete_file  │
│  crow_storage_stats                  │
├──────────────────────────────────────┤
│          Gateway HTTP Layer          │
│  POST /storage/upload (multipart)    │
│  GET  /storage/file/:key (presigned) │
├──────────────────────────────────────┤
│           s3-client.js               │
│  MinIO SDK wrapper, presigned URLs   │
├──────────────────────────────────────┤
│  SQLite (storage_files)  │  MinIO    │
│  Metadata + index        │  Blobs    │
└──────────────────────────────────────┘
```

## Factory Pattern

Like all Crow servers, the storage server uses a factory function:

```js
// servers/storage/server.js
export function createStorageServer(dbPath) {
  const server = new McpServer({ name: "crow-storage", version: "1.0.0" });
  // ... tool registrations
  return server;
}
```

- `server.js` — Factory function with all tool definitions
- `index.js` — Wires the factory to stdio transport
- `s3-client.js` — MinIO/S3 client wrapper

The gateway imports `createStorageServer()` and wires it to HTTP transport alongside the other servers.

## s3-client.js

Wraps the MinIO SDK with Crow-specific defaults:

```js
import { Client } from 'minio';

export function createS3Client(config) {
  // Returns configured MinIO client
}

export async function uploadObject(client, bucket, key, buffer, metadata) { }
export async function getPresignedUrl(client, bucket, key, expiry) { }
export async function deleteObject(client, bucket, key) { }
export async function listObjects(client, bucket, prefix) { }
export async function getBucketSize(client, bucket) { }
```

Presigned URLs default to 1-hour expiry. The expiry is configurable per request.

## Database Table

```sql
CREATE TABLE storage_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  s3_key TEXT NOT NULL UNIQUE,       -- S3 object key (e.g., "1234567890-photo.jpg")
  original_name TEXT NOT NULL,       -- Original filename at upload
  mime_type TEXT,                    -- Validated MIME type
  size_bytes INTEGER,               -- File size
  bucket TEXT DEFAULT 'crow-files',  -- S3 bucket name
  uploaded_by TEXT,                  -- Who uploaded (optional)
  reference_type TEXT,              -- What this file is attached to (e.g., blog_post)
  reference_id INTEGER,             -- ID of the referenced item
  created_at TEXT DEFAULT (datetime('now'))
);
```

The `s3_key` column is the canonical identifier used across MCP tools and HTTP endpoints.

## MCP Tools

### crow_upload_file

Uploads a small file via base64 (under 1MB) or generates a presigned upload URL for larger files. Validates the MIME type, checks quota, uploads to MinIO, and inserts a metadata row.

**Parameters:**
- `file_name` (string, max 500) — Original file name
- `mime_type` (string, max 200, optional) — MIME type (e.g., `image/png`)
- `data_base64` (string, max 1500000, optional) — Base64-encoded file data (for files under 1MB)
- `bucket` (string, max 100, optional) — Target bucket (default: `crow-files`)
- `reference_type` (string, max 100, optional) — What this file is attached to (e.g., `blog_post`, `research_source`)
- `reference_id` (number, optional) — ID of the referenced item

### crow_list_files

Lists files with optional filtering by bucket, MIME type prefix, or reference.

**Parameters:**
- `bucket` (string, max 100, optional) — Filter by bucket
- `mime_type` (string, max 200, optional) — Filter by MIME type prefix (e.g., `image/`)
- `reference_type` (string, max 100, optional) — Filter by reference type
- `reference_id` (number, optional) — Filter by reference ID
- `limit` (number, min 1, max 100, optional, default 50)

### crow_get_file_url

Generates a presigned download URL for temporary access to a file.

**Parameters:**
- `s3_key` (string, max 500) — S3 object key
- `expiry` (number, min 60, max 86400, optional, default 3600) — URL expiry in seconds
- `bucket` (string, max 100, optional) — Bucket name (default: `crow-files`)

### crow_delete_file

Removes a file from both MinIO and the database.

**Parameters:**
- `s3_key` (string, max 500) — S3 object key to delete
- `bucket` (string, max 100, optional) — Bucket name (default: `crow-files`)

### crow_storage_stats

Returns storage usage summary: total files, total size, quota remaining. No parameters.

## Gateway HTTP Routes

### POST /storage/upload

Multipart file upload. Accepts `file` field and optional `folder` field. Returns the file key and metadata. Protected by OAuth when enabled.

### GET /storage/file/:key

Redirects to a presigned MinIO URL for the requested file. The key is URL-encoded in the path. Returns 404 if the file doesn't exist in the database.

## Quota Enforcement

Before every upload, the server queries total storage usage:

```sql
SELECT COALESCE(SUM(size_bytes), 0) as total FROM storage_files;
```

If `total + new_file_size > CROW_STORAGE_QUOTA_MB * 1024 * 1024`, the upload is rejected with a clear error message showing current usage and quota.

## MIME Validation

Uploads are validated against an allowlist of MIME types. The server checks both the file extension and the detected MIME type (using magic bytes when available). Mismatches are rejected.

Allowed categories:
- `image/*` — JPEG, PNG, GIF, WebP, SVG
- `application/pdf`
- `text/*` — Plain text, Markdown, HTML, CSV
- `application/json`, `application/xml`
- `audio/*` — MP3, WAV, OGG

Executables, scripts, and archive formats are rejected by default.

## Message Attachments

The Messages panel uses the storage server for file attachments across all conversation types (peer messages, AI chat, bot chat).

```
┌─────────────────────────────────────────────────────────┐
│  Messages Panel (attachment UI)                         │
│  ├── Select file → preview (thumbnail / file card)      │
│  ├── Send message                                       │
│  │   └── POST /storage/upload (multipart)               │
│  │       └── MinIO bucket (crow-files)                  │
│  │           └── s3_key stored in message record         │
│  └── Display message                                    │
│      └── Presigned URL generated on read                │
│          └── Inline image / download link               │
└─────────────────────────────────────────────────────────┘
```

### Flow

1. User selects a file via the attachment UI (shared component across all message types)
2. On send, the file is uploaded to MinIO via `POST /storage/upload`
3. The returned `s3_key`, `name`, `mime_type`, and `size` are stored as JSON in the message's `attachments` column
4. When messages are loaded, presigned URLs are generated from the stored `s3_key` for display
5. Images render inline; other file types show as download links

### Bot Vision Pipeline

When an image is attached to a bot message:

1. The image is downloaded from S3 to a temporary file
2. A vision model (configured in the bot's `openclaw.json`) analyzes the image via direct API call
3. The vision model's text description is injected as context before the user's message
4. The temporary file is cleaned up after the bot responds

This allows non-vision primary models (e.g., `glm-5`) to understand image content through a separate vision model (e.g., `glm-4.6v`).

### AI Chat Attachments

For BYOAI AI Chat, image attachments are passed as multimodal content parts to the AI provider:

- **OpenAI-compatible**: `image_url` content part with presigned S3 URL
- **Anthropic**: `image` content part with presigned S3 URL

This requires the configured AI model to support vision (e.g., GPT-4o, Claude Sonnet).
