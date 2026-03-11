---
title: Storage API Reference
---

# Storage API Reference

Complete reference for the Crow Storage API — MCP tools, HTTP endpoints, and the s3-client module.

## MCP Tools

### crow_upload_file

Upload a small file (base64, <1MB) or get an HTTP upload URL for larger files.

**Parameters:**

| Name | Type | Required | Max Length | Description |
|---|---|---|---|---|
| `file_name` | string | Yes | 500 | Original file name |
| `mime_type` | string | No | 200 | MIME type (e.g., `image/png`) |
| `data_base64` | string | No | 1500000 | Base64-encoded file data (for files <1MB) |
| `bucket` | string | No | 100 | Target bucket (default: `crow-files`) |
| `reference_type` | string | No | 100 | What this file is attached to (e.g., `blog_post`, `project_source`) |
| `reference_id` | number | No | — | ID of the referenced item |

When `data_base64` is provided, the file is uploaded directly. When omitted, a presigned upload URL is returned for larger files.

**Returns (direct upload):**

```
Uploaded "photo.jpg" (240.0KB)
Key: 1709900000000-photo.jpg
Download URL (1hr): https://...
```

**Returns (presigned URL):**

```
Upload URL generated for "photo.jpg":

PUT https://...presigned-url...

Content-Type: image/jpeg
Max size: 100MB
Expires in 1 hour.
```

**Errors:**
- Quota exceeded — returns quota limit
- Blocked MIME type — executable types are rejected
- File too large for base64 upload — suggests HTTP upload endpoint

---

### crow_list_files

List stored files with optional filtering.

**Parameters:**

| Name | Type | Required | Max Length | Description |
|---|---|---|---|---|
| `bucket` | string | No | 100 | Filter by bucket |
| `mime_type` | string | No | 200 | Filter by MIME type prefix (e.g., `image/`) |
| `reference_type` | string | No | 100 | Filter by reference type |
| `reference_id` | number | No | — | Filter by reference ID |
| `limit` | number | No | — | Max results (default: 50, max: 100) |

**Returns:**

```
3 file(s):

- photo.jpg (240.0KB, image/jpeg)
  Key: 1709900000000-photo.jpg | 2026-03-08T12:00:00Z
- doc.pdf (1024.0KB, application/pdf) [blog_post:5]
  Key: 1709900000001-doc.pdf | 2026-03-08T11:00:00Z
```
```

---

### crow_get_file_url

Get a presigned download URL for a file.

**Parameters:**

| Name | Type | Required | Max Length | Description |
|---|---|---|---|---|
| `s3_key` | string | Yes | 500 | S3 object key |
| `expiry` | number | No | — | URL expiry in seconds (default: 3600, min: 60, max: 86400) |
| `bucket` | string | No | 100 | Bucket name (default: `crow-files`) |

**Returns:**

```
Download URL (expires in 60 min):
http://minio:9000/crow-files/1709900000000-photo.jpg?X-Amz-...
```
```

---

### crow_delete_file

Delete a file from storage and the database.

**Parameters:**

| Name | Type | Required | Max Length | Description |
|---|---|---|---|---|
| `s3_key` | string | Yes | 500 | S3 object key to delete |
| `bucket` | string | No | 100 | Bucket name (default: `crow-files`) |

**Returns:**

```
Deleted: 1709900000000-photo.jpg
```
```

---

### crow_storage_stats

Get storage usage statistics.

**Parameters:** None.

**Returns:**

```json
{
  "total_files": 42,
  "total_size_bytes": 52428800,
  "total_size_human": "50.0 MB",
  "quota_bytes": 1073741824,
  "quota_human": "1.0 GB",
  "used_percent": 4.9,
  "by_type": {
    "image/jpeg": { "count": 20, "size_bytes": 30000000 },
    "application/pdf": { "count": 15, "size_bytes": 20000000 },
    "text/plain": { "count": 7, "size_bytes": 2428800 }
  }
}
```

## HTTP Endpoints

### POST /storage/upload

Upload a file via multipart form data.

**Headers:**
- `Authorization: Bearer <token>` (when OAuth is enabled)
- `Content-Type: multipart/form-data`

**Form fields:**
- `file` — The file to upload (required)
- `folder` — Subfolder path (optional)

**Response (200):**

```json
{
  "key": "images/photo.jpg",
  "original_name": "photo.jpg",
  "mime_type": "image/jpeg",
  "size_bytes": 245760
}
```

**Errors:**
- `400` — No file provided or invalid MIME type
- `413` — File exceeds size limit
- `507` — Storage quota exceeded

**Example:**

```bash
curl -X POST http://localhost:3001/storage/upload \
  -F "file=@photo.jpg" \
  -F "folder=images/blog"
```

---

### GET /storage/file/:key

Retrieve a file by redirecting to a presigned MinIO URL.

**Path parameters:**
- `key` — URL-encoded storage key (e.g., `images%2Fphoto.jpg`)

**Query parameters:**
- `expiry` — Presigned URL expiry in seconds (default: 3600)

**Response:**
- `302` redirect to the presigned MinIO URL
- `404` if the file key is not found

**Example:**

```bash
curl -L http://localhost:3001/storage/file/images%2Fphoto.jpg
```

## s3-client.js Exports

The `servers/storage/s3-client.js` module wraps the MinIO SDK for use by the storage server and gateway. It uses a singleton client configured via environment variables (`S3_ENDPOINT` / `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_USE_SSL`, `S3_ACCESS_KEY` / `MINIO_ROOT_USER`, `S3_SECRET_KEY` / `MINIO_ROOT_PASSWORD`).

### getClient()

Get or create the MinIO/S3 client singleton. Returns `null` if not configured (missing endpoint or secret key).

### isAvailable()

Check if the S3/MinIO backend is available and responding. Returns `boolean`.

### ensureBucket(bucket?)

Ensure a bucket exists, creating it if missing. Defaults to `"crow-files"`.

### uploadObject(key, data, opts?)

Upload a Buffer to S3. `opts` may include `bucket` (string) and `contentType` (string).

### getPresignedUrl(key, opts?)

Generate a presigned GET (download) URL. `opts` may include `bucket` and `expiry` (seconds, default: 3600).

### getPresignedUploadUrl(key, opts?)

Generate a presigned PUT (upload) URL for direct browser uploads. `opts` may include `bucket` and `expiry` (seconds, default: 3600).

### deleteObject(key, bucket?)

Delete an object from S3. `bucket` defaults to `"crow-files"`.

### listObjects(opts?)

List objects in a bucket. `opts` may include `bucket` and `prefix`. Returns an array of `{ name, size, lastModified }`.

### getBucketStats(bucket?)

Get bucket statistics. Returns `{ fileCount, totalSizeBytes }`.

### isAllowedMimeType(mimeType)

Validate that a MIME type is allowed for upload (blocks executable types). Returns `boolean`.
