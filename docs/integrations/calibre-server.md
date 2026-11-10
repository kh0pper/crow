---
title: Calibre Server
---

# Calibre Server

Connect Crow to Calibre's content server to search, browse, and download ebooks from your library through your AI assistant.

## What You Get

- Search books by title, author, or tag
- Browse by category (author, tag, series, publisher)
- Get book details and metadata
- Download books in any available format
- Browse your full Calibre library via OPDS

## Setup

Crow supports two modes for Calibre: self-hosting via Docker or connecting to an existing instance.

### Option A: Docker (self-hosted)

Install Calibre as a Crow bundle. This runs Calibre's **content server** in Docker alongside your Crow gateway — not the Calibre desktop app over a web browser, which this bundle used to expose.

> "Crow, install the Calibre Server bundle"

Or install from the **Extensions** panel in the Crow's Nest.

After installation, set the path to your Calibre library directory:

```bash
# In your .env file
CALIBRE_LIBRARY_PATH=/path/to/your/calibre/library
```

Restart the bundle for changes to take effect:

> "Crow, restart the Calibre Server bundle"

Calibre's content server will be available at `http://your-server:8081`.

#### The login

The content server needs a login: every page that shows your books and every download asks for it. Crow creates the `admin` account itself right after the install, generates its password and keeps it in **Settings → Passwords**; the bundle's `.env` gets the same `CALIBRE_USERNAME` and `CALIBRE_PASSWORD`, so Crow's tools log in with them. Change the password in Calibre's own web UI (**Settings → Passwords**) if you want another one.

An install that already had content-server users keeps them: Crow leaves those accounts alone and asks you to save the login you use on the Extensions card.

A library folder with no `metadata.db` is filled with an empty Calibre library on the first start, so the server has somewhere to run.

### Option B: Connect to existing Calibre

If you already run a Calibre content server, connect Crow to it directly.

#### Step 1: Note your server URL

Find the URL where your Calibre content server is running (usually `http://hostname:8080` or `http://hostname:8081`).

#### Step 2: Add to Crow

Set the following in your `.env` file or via **Crow's Nest** > **Settings** > **Integrations**:

```bash
CALIBRE_URL=http://your-calibre-server:8081

# Only needed if authentication is enabled
CALIBRE_USERNAME=your-username
CALIBRE_PASSWORD=your-password
```

## AI Tools

Once connected, you can interact with Calibre through your AI:

> "Search my ebooks for science fiction"

> "Show me books by Isaac Asimov"

> "Download that book as EPUB"

> "What categories are in my Calibre library?"

## Troubleshooting

### "Connection refused" or timeout

Make sure the `CALIBRE_URL` is reachable from the machine running Crow. If Calibre is on a different machine, use the correct IP or hostname.

### "401 Unauthorized"

Crow logs in to the content server with `CALIBRE_USERNAME` and `CALIBRE_PASSWORD` from the bundle's `.env`. The password Crow generated is in **Settings → Passwords**; copy it there, or change Calibre's password in its own web UI (**Settings → Passwords**).

### Books not appearing

Verify that `CALIBRE_LIBRARY_PATH` points to the directory containing your `metadata.db` file. This is the root of your Calibre library, not a subfolder within it.
