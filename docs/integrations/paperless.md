---
title: Paperless-ngx
---

# Paperless-ngx

Connect Crow to Paperless-ngx to search, upload, tag, and organize your digitized documents through your AI assistant. Full-text OCR search included.

## What You Get

- Full-text search across all documents (OCR content)
- Browse and filter by tags, correspondents, and document types
- Upload new documents for OCR processing
- Download original or archived versions
- Manage tags and correspondents
- Update document metadata

## Setup

Crow supports two modes for Paperless-ngx: self-hosting via Docker or connecting to an existing instance.

### Option A: Docker (self-hosted)

Install Paperless-ngx as a Crow bundle. This runs Paperless-ngx in Docker alongside your Crow gateway.

> "Crow, install the Paperless bundle"

Or install from the **Extensions** panel in the Crow's Nest.

After installation, set the database password:

```bash
# In your .env file
PAPERLESS_DB_PASSWORD=your-secure-password
```

Restart the bundle for changes to take effect:

> "Crow, restart the Paperless bundle"

Paperless-ngx will be available at `http://your-server:8000` for initial setup. Create a superuser account via the web UI, then generate an API token from **Administration** > **Users** > **Edit** > **Auth Tokens**.

### Option B: Connect to existing Paperless-ngx

If you already run a Paperless-ngx instance, connect Crow to it directly.

#### Step 1: Get your API token

1. Open your Paperless-ngx web interface
2. Go to **Administration** > **Users**
3. Edit your user account
4. Under **Auth Tokens**, generate a new token
5. Copy the token

#### Step 2: Add to Crow

Set the following in your `.env` file or via **Crow's Nest** > **Settings** > **Integrations**:

```bash
PAPERLESS_URL=http://your-paperless-server:8000
PAPERLESS_API_TOKEN=your-api-token-here
```

## AI Tools

Once connected, you can interact with Paperless-ngx through your AI:

> "Search my documents for tax return"

> "Show me all documents tagged 'receipts'"

> "Upload this document to Paperless"

> "Who are my correspondents?"

> "Tag that document as 'insurance'"

## Docker Compose Reference

If you prefer manual Docker setup instead of the bundle installer:

```yaml
services:
  paperless:
    image: ghcr.io/paperless-ngx/paperless-ngx:latest
    container_name: crow-paperless
    ports:
      - "8000:8000"
    volumes:
      - paperless-data:/usr/src/paperless/data
      - paperless-media:/usr/src/paperless/media
      - paperless-consume:/usr/src/paperless/consume
    environment:
      PAPERLESS_DBHOST: paperless-db
      PAPERLESS_REDIS: redis://paperless-redis:6379
    depends_on:
      - paperless-db
      - paperless-redis
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 1024M

  paperless-db:
    image: postgres:16
    container_name: crow-paperless-db
    volumes:
      - paperless-pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: paperless
      POSTGRES_USER: paperless
      POSTGRES_PASSWORD: ${PAPERLESS_DB_PASSWORD}
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 256M

  paperless-redis:
    image: redis:7-alpine
    container_name: crow-paperless-redis
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 128M

volumes:
  paperless-data:
  paperless-media:
  paperless-consume:
  paperless-pgdata:
```

## Troubleshooting

### "Connection refused" or timeout

Make sure the `PAPERLESS_URL` is reachable from the machine running Crow. If Paperless-ngx is on a different machine, use the correct IP or hostname.

### "401 Unauthorized" or invalid token

The API token may have been deleted or expired. Regenerate a new token from the Paperless-ngx admin panel under **Administration** > **Users** > **Edit** > **Auth Tokens**.

### OCR not working on uploaded documents

Check your language packs in the Paperless-ngx settings. By default, only English is installed. Add additional OCR languages from **Settings** > **OCR** in the Paperless-ngx web UI.

### Upload failing

Check that the consume directory has the correct permissions. The Paperless-ngx container needs write access to the consume volume.
