---
title: Storage Server
---

# Storage Server

The storage server (`servers/storage/`) provides S3-compatible file storage through MCP tools and HTTP endpoints. It connects to MinIO (or any S3-compatible service) for object storage and tracks file metadata in SQLite.

> User-facing walkthrough (setup, uploading, quotas): [Storage guide](/guide/storage). This page covers internals.

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

## Who opens the settings (and who never does)

The S3 credentials live in `dashboard_settings` as `storage.shared.*`, with the access key and
secret sealed by `secret-box` — opening them needs the instance identity file. Two paths, one
decision, taken by `adoptHostStorage()` in `s3-client.js` off the env var
`CROW_STORAGE_FROM_HOST`:

| Process | `CROW_STORAGE_FROM_HOST` | What it does |
|---|---|---|
| The gateway | — | `initStorage({ db, identity })` in-process |
| An owner's own stdio server (the generated `~/.pi/agent` config) | absent | reads the identity (`loadIdentityIfPresent`), opens the config, keeps only that |
| A bot's MCP child | `1` | uses the OPENED settings the bot engine piped into its block (`S3_ENDPOINT`, `S3_USE_SSL`, `S3_REGION`, `S3_BUCKET_PREFIX`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`); never reads the identity |
| A bot's MCP child on a file-delivery turn | `0` | NO shared storage at all — a file cannot carry credentials, so the child refuses instead of falling back to an inherited endpoint |
| A bot's MCP child whose block declares no shared storage | `0` | NO shared storage and no identity read: such a child never receives settings, so marker-less (the owner path) must never reach it |

Who declares the need, and who is actually granted it. The core `crow-storage` server is
GRANTED by its registry entry (`needs: ["shared-storage"]` in `scripts/server-registry.js`) —
that is code in this repo. A bundle is granted only when **both** halves hold: its **installed**
manifest declares `"needs": ["shared-storage"]` **and** its id is on the reviewed, code-held
allow-list `STORAGE_ENV_CONSUMERS` in `servers/gateway/addon-env.js` (`isStorageEnvConsumer()`,
today `studio`, `sunvox-studio`, `data-dashboard`, `artifacts`). A declaration alone grants
nothing: the installed manifest is operator-writable, and an add-on from the store is not
reviewed code, so honouring the declaration by itself would hand this instance's storage
credentials to any add-on that typed `"needs": ["shared-storage"]`. A bundle that declares the
need and is not on the list is storage-**OFF** — the marker `0` and no credentials, like any
other block — plus one warning naming it (`<id>: its manifest declares shared storage, but <id>
is not a reviewed storage consumer, so <id> has no shared storage`). The bot engine's
owner-side hydration is in `scripts/pi-bots/mcp_writer.mjs` (`sharedStorageUnreviewed` carries
the refused ids out of the catalog); it pipes only the opened config, never the seed or the seal
key, and it says so in the spawn log — `shared storage: over fd`, `shared storage: off (file
delivery)`, `shared storage: off (no Shared Storage settings on this instance)` or
`shared storage: off (the Shared Storage settings could not be read)`.

Two rules make "only the six S3_* names" true rather than aspirational:

- **No bot block keeps a storage credential name.** Before the marker or the hydration is
  added — in BOTH delivery modes, for EVERY block of every kind (core, bundle, sealed add-on,
  canonical copy) — every `MINIO_*` name and the six `S3_*` names are stripped. The core
  registry's `mcpEnv` template resolves those out of the repo `.env`, where on a MinIO install
  they are the instance's ROOT credential; a bot's only storage credentials are the scoped
  settings the engine opens and pipes for that turn.
- **There is no env fallback for a bot.** No Shared Storage settings (an env-only install, no
  identity) means storage is OFF with one warning; settings that exist but cannot be read (an
  unopenable crow.db, a sealed value that would not open, an identity file that will not open)
  are OFF with a different warning and boot line, because that is a fault rather than a normal
  state.
- **Every active bot stdio block carries the marker.** `1` on the blocks the engine hydrated,
  `0` on every other one — including a bundle that imports `s3-client` without declaring
  `needs`, an installed copy from before its declaration, and a bundle that declared `needs`
  but whose id is not on the reviewed allow-list above. Marker-less IS the owner path, so
  leaving one unmarked would let such a child open the instance identity inside a bot. A
  `{url, headers}` block spawns no child and is left alone.

Tests: `tests/pibot-shared-storage-hydrate.test.js` (the writer, each child, and a planted
repo-style `.env` full of MINIO_*/S3_* credentials in both modes) and
`tests/pi-contain-shared-storage.test.js` (a real bubblewrap sandbox: the identity reads empty
while the child is configured from the pipe). `tests/bot-seed-import-guard.test.js` walks the
static import graph TRANSITIVELY from every bot entry and fails on any chain that reaches
`servers/sharing/identity.js` or `secret-box.js` (reporting the chain), plus any bot-reachable
file with a non-literal import specifier unless a reviewed entry says why it cannot reach the
seed. Its limit is stated in the test header: it follows literal specifiers inside this repo's
bot-reachable trees only.

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
│  │           └── s3_key stored in message record        │
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


### AI Chat Attachments

For BYOAI AI Chat, image attachments are passed as multimodal content parts to the AI provider:

- **OpenAI-compatible**: `image_url` content part with presigned S3 URL
- **Anthropic**: `image` content part with presigned S3 URL

This requires the configured AI model to support vision (e.g., GPT-4o, Claude Sonnet).
