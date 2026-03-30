# Crow

AI-powered project management, persistent memory, encrypted P2P sharing, and 20+ integrations for your AI assistant. Built on the open [Model Context Protocol](https://modelcontextprotocol.io) standard.

Published by [Maestro Press](https://maestro.press) | [Product Page](https://maestro.press/software/crow/)

**Share memories, projects, and messages directly between Crow users** — end-to-end encrypted, no central server, no accounts. The first AI platform where your assistant can securely collaborate with other people's assistants.

```
┌───────────────────────────────────────────────────────────────────────┐
│       AI Client (Claude, ChatGPT, Gemini, Grok, Cursor, etc.)       │
└────────┬──────────────────────┬──────────────────────┬───────────────┘
         │                      │                      │
   /memory/mcp            /projects/mcp          /tools/mcp
   /sharing/mcp           /storage/mcp           /blog-mcp/mcp
   /sharing/sse           /relay/*
         │                      │                      │
┌────────┴──────────────────────┴──────────────────────┴───────────────┐
│  Crow Gateway (Express + OAuth 2.1)                                  │
│  ├── crow-memory (persistent memory + full-text search)              │
│  ├── crow-projects (project management + APA citations + data backends) │
│  ├── crow-sharing (P2P encrypted sharing + Nostr messaging)          │
│  ├── crow-storage (S3-compatible file storage + quotas)              │
│  ├── crow-blog (publishing platform + RSS/Atom feeds)                │
│  ├── CrowClaw (bot management: lifecycle, BYOAI bridge, skills)      │
│  └── proxy → GitHub, Slack, Notion, Gmail, Trello, Discord, etc.     │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                      ┌────────┴────────┐
                      │     SQLite       │
                      │   (local file)   │
                      └─────────────────┘

## P2P Sharing — A First for AI Platforms

Crow is the first AI platform with built-in encrypted peer-to-peer sharing. No cloud middleman, no accounts to create — just your Crow ID.

- **Share memories and projects** — Send a memory or an entire project to a friend's Crow, encrypted end-to-end
- **Collaborate on projects** — Grant read or read-write access to projects that stay in sync automatically
- **Encrypted messaging** — Send messages between Crow users via the Nostr protocol with full sender anonymity
- **Works offline** — Shares queue up and deliver when both peers are online. Peer relays handle async delivery.
- **Zero trust** — No central server sees your data. Invite codes, safety numbers, and NaCl encryption throughout.

> *"Share my project with Alice, read-write"* — that's it. Crow handles the cryptography, discovery, and sync.

Learn more: **[Sharing Guide](https://maestro.press/software/crow/guide/sharing)** · **[Architecture](https://maestro.press/software/crow/architecture/sharing-server)**

## Crow's Nest

Server-rendered web UI with Dark Editorial design. Password-protected, session-based auth. Built-in panels for Messages, Blog, Files, Extensions, and Settings. Third-party panels can be installed from `~/.crow/panels/`.

> **[Crow's Nest Guide](https://maestro.press/software/crow/guide/crows-nest)** · **[Architecture](https://maestro.press/software/crow/architecture/dashboard)**

## Blog & Songbook

Create, edit, and publish blog posts through your AI assistant. Markdown rendering, customizable themes, RSS/Atom feeds, and shareable public URLs via the gateway. The built-in **Songbook** lets you manage ChordPro chord charts, transpose songs, generate chord diagrams, and organize setlists.

> **[Blog Guide](https://maestro.press/software/crow/guide/blog)** · **[Songbook Guide](https://maestro.press/software/crow/guide/songbook)** · **[Architecture](https://maestro.press/software/crow/architecture/blog-server)**

## AI Chat Gateway (BYOAI)

Use the Crow's Nest as a chat frontend with your own AI provider — OpenAI, Anthropic, Google, Ollama, or any OpenAI-compatible endpoint. Tool calling routes through Crow's MCP servers, so your AI can access memories, projects, and files during conversations. No API keys leave your server.

> **[Chat Architecture](https://maestro.press/software/crow/architecture/gateway#chat-api)**

## Bot Management (CrowClaw)

Manage AI bots on Discord, WhatsApp, Telegram, and other chat platforms directly from the dashboard. The CrowClaw extension handles bot lifecycle, AI provider configuration, skill deployment, and monitoring. Bots share the same database as every other connection — memories, projects, files, and messages are all accessible from any platform.

- **Install and go** — CrowClaw auto-configures bot AI from Crow's existing providers (BYOAI bridge)
- **One inbox** — Bots appear in the Messages panel alongside peers and AI chat
- **Bots control Crow apps** — A bot can publish blog posts, organize files, manage projects, and control integrations via the same MCP tools available to Claude or ChatGPT
- **Message attachments** — Send images to bots with vision model analysis (when S3 storage is configured)

> **[Bot Management Guide](https://maestro.press/software/crow/guide/bot-management)** · **[Architecture](https://maestro.press/software/crow/architecture/crowclaw)**

## Works With

| Claude | ChatGPT | Gemini | Grok | Cursor | Windsurf | Cline | Claude Code |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Web, Mobile, Desktop | Apps/Connectors | CLI, AI Studio | Remote MCP | IDE | IDE | VS Code | CLI |

## Quick Start

### Managed Hosting (Easiest)

Pre-configured Crow instance at `username.crow.maestro.press` — no setup, no maintenance. $15/mo or $120/yr.

> **[Get managed hosting →](https://maestro.press/hosting/)**

### Oracle Cloud Free Tier (Recommended Free)

A permanent free server that never sleeps — local SQLite, no external database needed.

1. Create a free [Oracle Cloud](https://cloud.oracle.com) account
2. Launch an Always Free VM.Standard.E2.1.Micro instance (Ubuntu 22.04)
3. Install Crow + Tailscale, create a systemd service
4. Connect from any AI platform

→ **[Full Oracle Cloud guide](https://maestro.press/software/crow/getting-started/oracle-cloud)**

### Desktop (Claude Desktop)

```bash
git clone https://github.com/kh0pper/crow.git && cd crow
npm run setup
npm run desktop-config  # Copy output to Claude Desktop config
```

→ **[Desktop setup guide](https://maestro.press/software/crow/getting-started/desktop-setup)**

### Developer (Claude Code)

```bash
cd crow
npm run setup
claude  # Loads .mcp.json + CLAUDE.md automatically
```

→ **[Claude Code guide](https://maestro.press/software/crow/platforms/claude-code)**

### Raspberry Pi / Self-Hosted (Crow OS)

```bash
curl -fsSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh | bash
crow status
```

Installs Crow as a persistent service with the `crow` CLI for managing bundles and updates. Supports Raspberry Pi, Debian, and Ubuntu.

→ **[Full setup guide](https://maestro.press/software/crow/getting-started/full-setup)**

## Crow OS & Self-Hosting

Crow OS turns a Raspberry Pi or any Debian machine into a personal AI server. The `crow` CLI manages the platform and installable add-on bundles:

- **`crow status`** — Platform health, identity, and resource usage
- **`crow bundle install <id>`** — Install add-ons like Ollama, Nextcloud, or Immich
- **`crow bundle start/stop/remove`** — Lifecycle management for bundle containers

Self-hosting add-ons include local AI (Ollama), file sync (Nextcloud), photo management (Immich), smart home (Home Assistant), and knowledge management (Obsidian).

→ **[Crow OS Installer](scripts/crow-install.sh)** · **[Add-on Registry](registry/add-ons.json)**

## Developer Program

Crow is open to contributions! Build integrations, skills, tools, and deployment bundles for the ecosystem.

- **MCP Integrations** — Connect new services (Linear, Jira, Todoist, etc.)
- **Skills** — Write behavioral prompts that teach the AI new workflows (no code required)
- **Core Tools** — Add MCP tools to crow-memory, crow-projects, crow-sharing, crow-storage, or crow-blog
- **Self-Hosted Bundles** — Create Docker Compose configs for specific use cases

→ **[Developer Docs](https://maestro.press/software/crow/developers/)** · **[Community Directory](https://maestro.press/software/crow/developers/directory)** · **[CONTRIBUTING.md](CONTRIBUTING.md)**

## Documentation

Full documentation at **[maestro.press/software/crow](https://maestro.press/software/crow/)**

- [Managed Hosting](https://maestro.press/hosting/) — Pre-configured Crow instance, no setup required
- [Maestro Press Product Page](https://maestro.press/software/crow/) — Overview, vision, and quick start
- [Platform Guides](https://maestro.press/software/crow/platforms/) — Setup for Claude, ChatGPT, Gemini, Grok, Cursor, Windsurf, Cline
- [Integrations](https://maestro.press/software/crow/integrations/) — All 20+ services with API key setup instructions
- [Sharing & Social](https://maestro.press/software/crow/guide/sharing) — P2P encrypted sharing, messaging, and collaboration
- [Storage](https://maestro.press/software/crow/guide/storage) — S3-compatible file storage with quotas and presigned URLs
- [Blog](https://maestro.press/software/crow/guide/blog) — AI-driven publishing with themes, RSS, and public sharing
- [Crow's Nest](https://maestro.press/software/crow/guide/crows-nest) — Web UI with panels for messages, files, blog, and extensions
- [Architecture](https://maestro.press/software/crow/architecture/) — System design, server APIs, gateway details
- [Skills](https://maestro.press/software/crow/skills/) — 30 behavioral prompts for AI workflows
- [Security](SECURITY.md) — API key safety, deployment security, and what to do if a key leaks
- [Troubleshooting](https://maestro.press/software/crow/troubleshooting)

## License

MIT
