# Getting Started

Crow can be set up in several ways depending on your use case:

## Choose Your Path

### Managed Hosting (Easiest)

Pre-configured Crow instance — no setup, no maintenance. Your own subdomain at `username.crow.maestro.press` with dashboard, blog, AI integrations, daily backups, and SSL included.

> [Managed Hosting Guide](./managed-hosting)

### Cloud Deploy (Quickest)

Deploy Crow to [Render](https://render.com) for access from any device — web, mobile, or desktop. Free tier available.

→ [Cloud Deploy Guide](./cloud-deploy)

### Raspberry Pi (Crow OS)

Turn a Raspberry Pi into a dedicated Crow appliance with one command. No SSH required after setup.

→ [Raspberry Pi Guide](./raspberry-pi)

### Free Hosting Options

Compare free hosting providers — Render, Oracle Cloud Always Free, and Raspberry Pi.

→ [Free Hosting Guide](./free-hosting)

### Desktop Only

Run Crow locally as stdio MCP servers connected directly to Claude Desktop. No cloud needed, but only works on that machine.

→ [Desktop Setup Guide](./desktop-setup)

### Docker

Self-host the gateway with Docker Compose. Best for developers who want full control.

→ [Docker Guide](./docker)

## What You'll Get

After setup, your AI assistant will have:

- **Persistent memory** — remembers across conversations
- **Research pipeline** — manages sources, generates APA citations
- **20+ integrations** — Gmail, GitHub, Slack, Notion, Trello, and more
- **Full-text search** — find anything stored in memory or research
- **Encrypted P2P sharing** — share memories and research with other Crow users
- **File storage** — upload and manage files with S3-compatible storage
- **Blog platform** — publish posts with Markdown, RSS feeds, and themes
- **Dashboard** — visual web interface for managing your Crow instance

## Requirements

- A free [Render](https://render.com) account (for cloud deploy)
- A free [Turso](https://turso.tech) database (only needed for Render cloud deploy)
- Node.js 18+ (for desktop/local setup)
- Raspberry Pi 4+ with 4 GB RAM (for Crow OS)
- An account on at least one AI platform (Claude, ChatGPT, Gemini, etc.)
