# Getting Started

Crow can be set up in several ways depending on your use case:

## Choose Your Path

### Oracle Cloud Free Tier (Recommended Free) :star:

A permanent cloud server that never sleeps, never expires, and costs nothing. Uses local SQLite — no external database needed.

> [Oracle Cloud Setup Guide](./oracle-cloud)

### Home Server (Pi / Always-On Machine)

Run Crow on a Raspberry Pi, old laptop, NUC, or any always-on Linux box. One-command install.

> [Home Server Guide](./home-server)

### Desktop Install (Personal Machine)

Run Crow locally, connected directly to Claude Desktop, Claude Code, Cursor, and other tools. No cloud needed.

> [Desktop Install Guide](./desktop-install)

### Managed Hosting (Easiest)

Pre-configured Crow instance — no setup, no maintenance. Your own subdomain at `username.crow.maestro.press` with Crow's Nest, blog, AI integrations, daily backups, and SSL included.

> [Managed Hosting Guide](./managed-hosting)

### Other Options

- **[Docker](./docker)** — Self-host the gateway with Docker Compose. Best for developers who want full control.
- **[Cloud Deploy (Legacy)](./cloud-deploy)** — Deploy to Render with Turso. Still works, but Oracle Cloud is recommended for new deployments.

## What You'll Get

After setup, your AI assistant will have:

- **Persistent memory** — remembers across conversations
- **Project management** — organize research, data connectors, sources, and auto-generated APA citations
- **20+ integrations** — Gmail, GitHub, Slack, Notion, Trello, and more
- **Full-text search** — find anything stored in memory or projects
- **Encrypted P2P sharing** — share memories and projects with other Crow users
- **File storage** — upload and manage files with S3-compatible storage
- **Blog platform** — publish posts with Markdown, RSS feeds, and themes
- **Crow's Nest** — visual web interface for managing your Crow instance
- **Self-hosting add-ons** — install Ollama, Nextcloud, Immich, Obsidian, and Home Assistant from the Extensions panel

**What's public?** Your blog is the only thing visible to the outside world, and only posts you explicitly publish with `public` visibility appear there. Your Crow's Nest, data, and MCP endpoints are private by default. See the [Security Guide](https://github.com/kh0pper/crow/blob/main/SECURITY.md#whats-public-by-default) for the full breakdown.

::: tip Running many integrations?
See the [Context & Performance guide](/guide/context-performance) for ways to optimize tool loading and reduce context window usage.
:::

## Requirements

- Node.js 18+ (for all self-hosted options)
- A free [Oracle Cloud](https://cloud.oracle.com) account (for cloud deploy)
- Raspberry Pi 4+ with 4 GB RAM (for Crow OS)
- An account on at least one AI platform (Claude, ChatGPT, Gemini, etc.)
