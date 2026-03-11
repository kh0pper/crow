# Docker Setup

::: tip Don't want to manage infrastructure?
Try [managed hosting](./managed-hosting) — $15/mo, no setup required.
:::

Run the Crow gateway in Docker for self-hosted deployments.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose installed
- Uses local SQLite by default — no database setup needed. [Turso](https://turso.tech) is optional for Render cloud deploys.

## Cloud Profile

Exposes the gateway on port 3001:

```bash
docker compose --profile cloud up --build
```

Set environment variables in a `.env` file or pass them directly:

```env
# No database config needed — Crow uses local SQLite automatically.
# For Render cloud deploys only:
# TURSO_DATABASE_URL=libsql://your-db.turso.io
# TURSO_AUTH_TOKEN=your-token
```

## Local Profile

Runs the gateway with a Cloudflare Tunnel for remote access:

```bash
docker compose --profile local up --build
```

This creates a public URL via Cloudflare that you can use to connect from mobile/web AI clients.

## Environment Variables

The gateway reads all integration API keys from environment variables. See the [Integrations](../integrations/) page for the full list.

> **Security note**: If you're exposing the gateway to the internet, always use a reverse proxy (nginx, Caddy, or Cloudflare Tunnel) with HTTPS. Never expose port 3001 directly to the public internet without TLS encryption. The `--no-auth` flag should never be used in internet-facing deployments.

## Health Check

Verify the gateway is running:

```bash
curl http://localhost:3001/health
```

Visit `http://localhost:3001/setup` to see integration status and endpoint URLs.

## Dashboard Password

The first time you visit `/dashboard`, you'll be prompted to set a password. You can also set it from the `/setup` page or by asking your AI: "Set my dashboard password."

## Connect Your AI

Once the gateway is running, connect your AI platform:

[Claude](/platforms/claude) · [ChatGPT](/platforms/chatgpt) · [All platforms](/platforms/)

**Try it out** — after connecting, say:

> "Remember that today is my first day using Crow"
> "What do you remember?"
