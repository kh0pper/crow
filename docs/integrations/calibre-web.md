---
title: Calibre-Web
---

# Calibre-Web

Connect Crow to Calibre-Web for a rich web-based ebook reading experience with shelves, reading progress, and library management.

## What You Get

- Search and browse your ebook library
- Manage bookshelves and collections
- Track reading status (read, reading, to-read)
- Download books in multiple formats
- Read books directly in the browser via the web UI

## Setup

Crow supports two modes for Calibre-Web: self-hosting via Docker or connecting to an existing instance.

### Option A: Docker (self-hosted)

Install Calibre-Web as a Crow bundle. This runs Calibre-Web in Docker alongside your Crow gateway.

> "Crow, install the Calibre-Web bundle"

Or install from the **Extensions** panel in the Crow's Nest.

After installation, set the path to the directory containing your `metadata.db`:

```bash
# In your .env file
CALIBRE_WEB_DB_PATH=/path/to/calibre/library
```

Restart the bundle for changes to take effect:

> "Crow, restart the Calibre-Web bundle"

Calibre-Web will be available at `http://your-server:8083`. Create an initial admin account through the web UI on first launch.

### Option B: Connect to existing Calibre-Web

If you already run a Calibre-Web instance, connect Crow to it directly.

#### Step 1: Get your API key

1. Open your Calibre-Web interface
2. Go to **Settings** (admin menu)
3. Generate or copy your API key

#### Step 2: Add to Crow

Set the following in your `.env` file or via **Crow's Nest** > **Settings** > **Integrations**:

```bash
CALIBRE_WEB_URL=http://your-calibre-web:8083
CALIBRE_WEB_API_KEY=your-api-key-here
```

## AI Tools

Once connected, you can interact with Calibre-Web through your AI:

> "Search my books for fantasy novels"

> "Add this book to my Reading shelf"

> "What am I currently reading?"

> "Show me my to-read list"

> "Download that book as PDF"

## Troubleshooting

### "Connection refused" or timeout

Make sure the `CALIBRE_WEB_URL` is reachable from the machine running Crow. If Calibre-Web is on a different machine, use the correct IP or hostname.

### API key not working

Regenerate the API key from Calibre-Web's admin settings. Make sure you copied the full key without extra whitespace.

### "metadata.db not found"

Verify that `CALIBRE_WEB_DB_PATH` points to the directory containing your Calibre `metadata.db` file. Calibre-Web requires an existing Calibre library database to function.
