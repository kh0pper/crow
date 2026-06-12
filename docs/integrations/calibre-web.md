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

#### Step 1: Pick a Calibre-Web user

The integration authenticates with **OPDS Basic auth** — a normal Calibre-Web user account (stock Calibre-Web has no API keys). Use an existing account or create a dedicated one in **Admin → Users**.

#### Step 2: Add to Crow

Set the following in your `.env` file or via **Crow's Nest** > **Settings** > **Integrations**:

```bash
CALIBRE_WEB_URL=http://your-calibre-web:8083
CALIBRE_WEB_USERNAME=your-user
CALIBRE_WEB_PASSWORD=your-password
```

::: info Two actions stay in the web UI
Searching, listing, book details, shelf listing, and download links all work over OPDS. Adding a book to a shelf and setting reading status are session-only routes in stock Calibre-Web — the AI will tell you to do those in the Calibre-Web web UI (they work programmatically only behind an authenticating reverse proxy).
:::

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

### Authentication failed

Check `CALIBRE_WEB_USERNAME` and `CALIBRE_WEB_PASSWORD` — they are the same credentials you use to log into the Calibre-Web web UI. If the account uses an external auth provider (LDAP/OAuth), make sure it also has a local password OPDS can accept.

### "metadata.db not found"

Verify that `CALIBRE_WEB_DB_PATH` points to the directory containing your Calibre `metadata.db` file. Calibre-Web requires an existing Calibre library database to function.
