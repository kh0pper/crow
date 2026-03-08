---
title: Storage API Reference
---

# Storage API Reference

Complete reference for the Crow Storage API — MCP tools, HTTP endpoints, and the s3-client module.

## MCP Tools

### crow_upload_file

Upload a file to storage.

**Parameters:**

| Name | Type | Required | Max Length | Description |
|---|---|---|---|---|
| `file_path` | string | One of `file_path` or `content` | 500 | Absolute path to the file on disk |
| `content` | string | One of `file_path` or `content` | 50000 | Base64-encoded file content |
| `filename` | string | Yes | 255 | Target filename (e.g., `photo.jpg`) |
| `folder` | string | No | 255 | Subfolder path (e.g., `images/blog`) |

**Returns:**

```json
{
  "key": "images/blog/photo.jpg",
  "original_name": "photo.jpg",
  "mime_type": "image/jpeg",
  "size_bytes": 245760,
  "uploaded_at": "2026-03-08T12:00:00Z"
}
```

**Errors:**
- Quota exceeded — returns current usage and limit
- Invalid MIME type — lists allowed types
- File not found (when using `file_path`)

---

### crow_list_files

List files in storage with optional filtering.

**Parameters:**

| Name | Type | Required | Max Length | Description |
|---|---|---|---|---|
| `folder` | string | No | 255 | Filter by folder prefix |
| `mime_type` | string | No | 100 | Filter by MIME type prefix (e.g., `image/`) |
| `limit` | number | No | — | Max results (default: 50, max: 200) |
| `offset` | number | No | — | Skip first N results |

**Returns:**

```json
{
  "files": [
    {
      "key": "images/photo.jpg",
      "original_name": "photo.jpg",
      "mime_type": "image/jpeg",
      "size_bytes": 245760,
      "uploaded_at": "2026-03-08T12:00:00Z"
    }
  ],
  "total": 42
}
```

---

### crow_get_file_url

Generate a temporary presigned URL for accessing a file.

**Parameters:**

| Name | Type | Required | Max Length | Description |
|---|---|---|---|---|
| `key` | string | Yes | 500 | The file's storage key |
| `expiry_seconds` | number | No | — | URL validity (default: 3600, max: 86400) |

**Returns:**

```json
{
  "url": "http://minio:9000/crow-storage/images/photo.jpg?X-Amz-...",
  "expires_at": "2026-03-08T13:00:00Z"
}
```

---

### crow_delete_file

Permanently delete a file from storage and the database.

**Parameters:**

| Name | Type | Required | Max Length | Description |
|---|---|---|---|---|
| `key` | string | Yes | 500 | The file's storage key |

**Returns:**

```json
{
  "deleted": true,
  "key": "images/photo.jpg"
}
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

The `servers/storage/s3-client.js` module wraps the MinIO SDK for use by the storage server and gateway.

### createS3Client(config)

Create a configured MinIO client.

```js
import { createS3Client } from '../storage/s3-client.js';

const client = createS3Client({
  endPoint: process.env.MINIO_ENDPOINT,
  port: parseInt(process.env.MINIO_PORT),
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
  useSSL: process.env.MINIO_USE_SSL === 'true',
});
```

### uploadObject(client, bucket, key, buffer, metadata)

Upload a buffer to S3. `metadata` is an object with `Content-Type` and any custom headers.

### getPresignedUrl(client, bucket, key, expiry)

Generate a presigned GET URL. `expiry` is in seconds (default: 3600).

### deleteObject(client, bucket, key)

Delete an object from S3.

### listObjects(client, bucket, prefix)

List objects matching a prefix. Returns an array of `{ name, size, lastModified }`.

### getBucketSize(client, bucket)

Calculate total size of all objects in a bucket. Returns `{ totalSize, objectCount }`.
