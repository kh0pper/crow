---
title: Storage
---

# Storage

Store files, images, and attachments alongside your Crow data. Storage uses S3-compatible object storage (MinIO) so your files stay on your own infrastructure.

## What is this?

Crow Storage gives your AI assistant the ability to save and retrieve files. It connects to a MinIO instance (or any S3-compatible service) running alongside your Crow server.

Files are organized by type — images, documents, audio, attachments — and accessible through MCP tools, HTTP endpoints, or the dashboard file browser.

## Why would I want this?

- **Project attachments** — Save PDFs, datasets, and images alongside your projects
- **Blog assets** — Upload images for blog posts without needing a separate hosting service
- **File sharing** — Share files with connected peers through the existing P2P sharing system
- **Backup** — Keep important files in a self-hosted storage layer you control

## Setup

Storage requires a MinIO instance. The easiest way is Docker:

```bash
docker compose --profile full up --build
```

This starts MinIO alongside the gateway. For standalone MinIO:

```bash
docker run -d \
  --name minio \
  -p 9000:9000 \
  -p 9001:9001 \
  -v minio-data:/data \
  -e MINIO_ROOT_USER=crowadmin \
  -e MINIO_ROOT_PASSWORD=your-secure-password \
  minio/minio server /data --console-address ":9001"
```

Then add these to your `.env`:

```bash
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=crowadmin
MINIO_SECRET_KEY=your-secure-password
MINIO_BUCKET=crow-storage
MINIO_USE_SSL=false
```

Run `npm run mcp-config` to regenerate your MCP configuration.

## Uploading Files

### Through your AI

Ask Crow to upload a file:

> "Upload this image to storage"

> "Save the PDF at ~/Downloads/paper.pdf to my research files"

Crow uses the `crow_upload_file` tool behind the scenes.

### Through HTTP

Upload via the gateway's HTTP endpoint:

```bash
curl -X POST http://localhost:3001/storage/upload \
  -F "file=@photo.jpg" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Through the dashboard

Open the **Files** panel in the dashboard and use the upload button. You can drag and drop files directly.

## Browsing Files

Ask Crow to list your files:

> "Show me my stored files"

> "List all images in storage"

Or browse them visually in the dashboard's Files panel.

## Getting File URLs

To use a stored file (for example, in a blog post or shared document):

> "Get the URL for header-image.jpg"

Crow generates a presigned URL that expires after a configurable period (default: 1 hour). This keeps your files private while allowing temporary access.

## Storage Quotas

Crow enforces a configurable storage quota (default: 5 GB / 5120 MB). Check your usage:

> "How much storage am I using?"

The `crow_storage_stats` tool returns current usage, file count, and remaining quota. Adjust the quota in your `.env`:

```bash
CROW_STORAGE_QUOTA_MB=2048
```

## Supported File Types

Storage uses a blocklist approach — most file types are accepted, and only executable types are blocked. This means you can upload virtually any file format, including:

- **Images**: JPEG, PNG, GIF, WebP, SVG, TIFF, BMP, ICO
- **Documents**: PDF, plain text, Markdown, HTML, Office documents (DOCX, PPTX, XLSX)
- **Data**: JSON, CSV, XML, YAML
- **Audio**: MP3, WAV, OGG, FLAC, AAC
- **Video**: MP4, WebM, AVI, MKV
- **Archives**: ZIP, TAR, GZ, 7z, RAR

Files with unknown or unrecognized MIME types are also allowed.

The following executable MIME types are blocked:

- `application/x-executable`
- `application/x-msdos-program`
- `application/x-msdownload`
- `application/x-sh`
- `application/x-shellscript`
- `application/x-bat`
- `application/x-msi`

## Deleting Files

> "Delete the file old-draft.pdf from storage"

Deletion is permanent. Files are removed from both MinIO and the database index.
