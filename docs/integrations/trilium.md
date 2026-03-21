---
title: TriliumNext
---

# TriliumNext

Connect Crow to TriliumNext to search, create, and organize notes in your personal knowledge base through your AI assistant.

## What You Get

- Search notes by content, title, or attributes
- Create and edit notes with rich text or markdown
- Browse the note tree structure
- Clip web pages into notes
- Access and create day notes (daily journal)
- Export notes in various formats

## Setup

Crow supports two modes: self-hosting TriliumNext via Docker or connecting to an existing instance.

### Option A: Docker (self-hosted)

Install TriliumNext as a Crow bundle:

> "Crow, install the TriliumNext bundle"

Or install from the **Extensions** panel in the Crow's Nest.

TriliumNext will be available at `http://your-server:8080` after installation. Complete the initial setup in the web UI to set your password.

### Option B: Connect to existing TriliumNext

If you already run a TriliumNext server, connect Crow to it directly.

#### Step 1: Get your ETAPI token

1. Open your TriliumNext web interface
2. Go to **Options** (top-right menu) > **ETAPI**
3. Click **Create new ETAPI token**
4. Name it (e.g., "Crow")
5. Copy the generated token

#### Step 2: Add to Crow

Set the following in your `.env` file or via **Crow's Nest** > **Settings** > **Integrations**:

```bash
TRILIUM_URL=http://your-trilium-server:8080
TRILIUM_ETAPI_TOKEN=your-etapi-token-here
```

## AI Tools

Once connected, interact with TriliumNext through your AI:

> "Search my notes for 'project planning'"

> "Create a note called 'Meeting Notes — March 21' under my Work folder"

> "Show me today's day note"

> "Clip this article into TriliumNext: https://example.com/article"

> "Browse my note tree"

> "Export my Research folder as HTML"

## Workflows

### Research capture

Combine TriliumNext with Crow's research tools:

> "Save these research findings to a TriliumNext note and add the source to my Crow project"

Notes created this way are linked to your Crow research project for cross-referencing.

### Knowledge organization

Use your AI to restructure notes:

> "Move all my meeting notes from 2025 into an Archive folder"

> "Create a table of contents note for my Cooking Recipes folder"

### Daily journal

TriliumNext's day notes work well with Crow's session protocol:

> "Add a summary of today's session to my day note"

## Docker Compose Reference

If you prefer manual Docker setup:

```yaml
services:
  trilium:
    image: triliumnext/notes:latest
    container_name: crow-trilium
    ports:
      - "8080:8080"
    volumes:
      - trilium-data:/home/node/trilium-data
    restart: unless-stopped

volumes:
  trilium-data:
```

## Troubleshooting

### "Connection refused" or timeout

Make sure the `TRILIUM_URL` is reachable from the machine running Crow. TriliumNext defaults to port 8080.

### "401 Unauthorized"

The ETAPI token may have been deleted. Create a new one from Options > ETAPI in the TriliumNext web UI.

### Notes not found in search

TriliumNext's search indexes may need to rebuild. Open the TriliumNext web UI and check Options > Advanced for re-indexing options.

### Day notes not working

Day notes require a specific note structure in TriliumNext. Make sure you have a "Journal" note with the `#calendarRoot` attribute. TriliumNext creates this automatically during first-time setup.
