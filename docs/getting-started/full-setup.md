---
title: Full Setup
---

# Full Setup

::: tip Don't want to manage infrastructure?
Try [managed hosting](./managed-hosting) — $15/mo, no setup required.
:::

Run the complete Crow platform — gateway, MinIO storage, blog, and Crow's Nest — with a single Docker Compose command.

## What is this?

The full setup profile starts all Crow services together: the MCP gateway, MinIO for file storage, and the Crow's Nest. This is the recommended way to run Crow if you want every feature available.

## Why would I want this?

- **Everything at once** — One command to start the full platform
- **File storage included** — MinIO runs alongside the gateway, no separate setup needed
- **Blog ready** — Start publishing immediately after setup
- **Crow's Nest access** — Visual management from your browser

## Prerequisites

- Docker and Docker Compose installed
- Git (to clone the repository)
- A machine with at least 1 GB of RAM

## Step 1: Clone and Configure

```bash
git clone https://github.com/kh0pper/crow.git
cd crow
cp .env.example .env
```

## Step 2: Edit Environment Variables

Open `.env` and set the required values:

```bash
# MinIO (file storage)
MINIO_ENDPOINT=minio          # Use "minio" for Docker, "localhost" for local
MINIO_PORT=9000
MINIO_ROOT_USER=crowadmin
MINIO_ROOT_PASSWORD=change-this-to-a-secure-password
MINIO_USE_SSL=false

# Storage quota (in MB)
STORAGE_QUOTA_MB=1024
```

When running inside Docker Compose, set `MINIO_ENDPOINT=minio` (the Docker service name). For local (non-Docker) setups, use `MINIO_ENDPOINT=localhost` instead. Blog settings are managed via the `crow_blog_settings` MCP tool or the Crow's Nest — no env vars needed.

## Step 3: Start Everything

```bash
docker compose --profile full up --build
```

This starts:

- **Gateway** on port `3001` — MCP server, blog, and API
- **MinIO** on port `9000` (API) and `9001` (console) — file storage
- **Crow's Nest** at `/dashboard` on the gateway

On first run, Docker downloads images and builds the gateway. Subsequent starts are faster.

## Step 4: Initialize the Database

In a separate terminal:

```bash
docker compose exec gateway npm run init-db
```

This creates the SQLite database with all required tables.

## Step 5: Access Your Services

| Service | URL |
|---|---|
| Gateway health check | `http://localhost:3001/health` |
| Crow's Nest | `http://localhost:3001/dashboard` |
| Blog | `http://localhost:3001/blog` |
| MinIO Console | `http://localhost:9001` |

The MinIO console lets you browse stored files directly. Log in with your `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`.

## Step 6: Generate MCP Config

To use the storage server with Claude or other AI platforms:

```bash
npm run mcp-config
```

This regenerates `.mcp.json` with the storage server included (only if MinIO env vars are set).

## Running in the Background

To keep services running after you close the terminal:

```bash
docker compose --profile full up --build -d
```

View logs:

```bash
docker compose logs -f gateway
docker compose logs -f minio
```

Stop everything:

```bash
docker compose --profile full down
```

## Persisted Data

Data is stored in Docker volumes:

- **crow-data** — SQLite database, identity files
- **minio-data** — All uploaded files

These persist across container restarts. To fully reset:

```bash
docker compose --profile full down -v
```

This deletes all data. Use with caution.

## Adding Tailscale

For secure remote access, install Tailscale on the host machine (not inside Docker). See the [Tailscale Setup guide](/getting-started/tailscale-setup).

## Crow's Nest Password

The first time you visit the Crow's Nest (`/dashboard`), you'll be prompted to set a password. You can also set it from the `/setup` page or by asking your AI: "Set my Crow's Nest password."

## Connect Your AI

Visit `http://localhost:3001/setup` to see integration status and endpoint URLs.

[Claude](/platforms/claude) · [ChatGPT](/platforms/chatgpt) · [All platforms](/platforms/)

**Try it out** — after connecting your AI platform, say:

> "Remember that today is my first day using Crow"
> "What do you remember?"

::: tip Chain multiple instances
Docker instances can be chained with other Crow installations — cloud VMs, desktops, or Raspberry Pis. Memories sync automatically via P2P. See [Multi-Device Quick Start](./multi-device).
:::

## Next Steps

- [Storage guide](/guide/storage) — Learn how to upload and manage files
- [Blog guide](/guide/blog) — Start writing and publishing posts
- [Crow's Nest guide](/guide/crows-nest) — Explore the visual control panel
