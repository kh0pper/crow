---
title: Vikunja
---

# Vikunja

Connect Crow to Vikunja to manage tasks, projects, labels, and due dates through your AI assistant. Supports kanban boards and team collaboration.

## What You Get

- List and browse projects
- Create and manage tasks with priorities and due dates
- Filter tasks (done, priority, project, overdue)
- Manage labels
- Create new projects
- Track task completion

## Setup

Crow supports two modes for Vikunja: self-hosting via Docker or connecting to an existing instance.

### Option A: Docker (self-hosted)

Install Vikunja as a Crow bundle. This runs Vikunja in Docker alongside your Crow gateway. Vikunja uses built-in SQLite, so no external database is needed.

> "Crow, install the Vikunja bundle"

Or install from the **Extensions** panel in the Crow's Nest.

Vikunja will be available at `http://your-server:3456` for initial setup. Create an account via the web UI, then generate an API token from **Settings** > **API Tokens**.

### Option B: Connect to existing Vikunja

If you already run a Vikunja instance, connect Crow to it directly.

#### Step 1: Get your API token

1. Open your Vikunja web interface
2. Go to **Settings** > **API Tokens**
3. Create a new token
4. Copy the generated token

#### Step 2: Add to Crow

Set the following in your `.env` file or via **Crow's Nest** > **Settings** > **Integrations**:

```bash
VIKUNJA_URL=http://your-vikunja-server:3456
VIKUNJA_API_TOKEN=your-api-token-here
```

## AI Tools

Once connected, you can interact with Vikunja through your AI:

> "Show me my open tasks"

> "Create a task: Review quarterly report, due Friday, high priority"

> "What tasks are overdue?"

> "Mark that task as done"

> "Create a new project called Home Renovation"

> "Show me tasks in the Marketing project"

## Docker Compose Reference

If you prefer manual Docker setup instead of the bundle installer:

```yaml
services:
  vikunja:
    image: vikunja/vikunja:latest
    container_name: crow-vikunja
    ports:
      - "3456:3456"
    volumes:
      - vikunja-data:/app/vikunja/files
      - vikunja-db:/db
    restart: unless-stopped

volumes:
  vikunja-data:
  vikunja-db:
```

## Troubleshooting

### "Connection refused" or timeout

Make sure the `VIKUNJA_URL` is reachable from the machine running Crow. If Vikunja is on a different machine, use the correct IP or hostname.

### "401 Unauthorized" or invalid token

The API token may have been deleted or expired. Regenerate a new token from Vikunja **Settings** > **API Tokens**.

### Tasks not appearing

Check the project permissions for the user associated with your API token. API tokens inherit the permissions of the user who created them. If projects were shared with restricted access, some tasks may not be visible through the API.
