---
title: Kavita
---

# Kavita

Connect Crow to Kavita to browse manga, comics, and ebooks, track reading progress, and manage your reading list through your AI assistant.

## What You Get

- Search manga, comics, and ebooks
- Browse series with filters and pagination
- Track reading progress per series
- Manage a want-to-read list
- View recently added content
- Browse library statistics

## Setup

Crow supports two modes for Kavita: self-hosting via Docker or connecting to an existing instance.

### Option A: Docker (self-hosted)

Install Kavita as a Crow bundle. This runs Kavita in Docker alongside your Crow gateway.

> "Crow, install the Kavita bundle"

Or install from the **Extensions** panel in the Crow's Nest.

After installation, set the path to your library:

```bash
# In your .env file
KAVITA_LIBRARY_PATH=/path/to/your/manga-comics-ebooks
```

Restart the bundle for changes to take effect:

> "Crow, restart the Kavita bundle"

Kavita will be available at `http://your-server:5000`. Create an admin account through the web UI on first launch.

::: tip Port note
Port 5000 is commonly used by other services. If you have a conflict, remap the port in the bundle's `docker-compose.yml`.
:::

### Option B: Connect to existing Kavita

If you already run a Kavita instance, connect Crow to it directly.

#### Step 1: Note your credentials

Crow authenticates with Kavita using your username and password. It handles JWT token management automatically.

#### Step 2: Add to Crow

Set the following in your `.env` file or via **Crow's Nest** > **Settings** > **Integrations**:

```bash
KAVITA_URL=http://your-kavita-server:5000
KAVITA_USERNAME=your-username
KAVITA_PASSWORD=your-password
```

## AI Tools

Once connected, you can interact with Kavita through your AI:

> "Search my manga for One Piece"

> "What have I been reading lately?"

> "Add this series to my want-to-read list"

> "Show me recently added comics"

> "What's my reading progress on that series?"

## Troubleshooting

### "Connection refused" or timeout

Make sure the `KAVITA_URL` is reachable from the machine running Crow. If Kavita is on a different machine, use the correct IP or hostname.

### Login failed

Verify that `KAVITA_USERNAME` and `KAVITA_PASSWORD` are correct. Try logging in through the Kavita web UI with the same credentials to confirm they work.

### Port 5000 conflict

If another service is already using port 5000, edit the bundle's `docker-compose.yml` to remap the port (e.g., `5001:5000`), then update `KAVITA_URL` accordingly.
