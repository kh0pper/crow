# Crow AI Platform

Persistent memory, research pipeline, encrypted P2P sharing, and 20+ integrations for your AI assistant. Built on the open [Model Context Protocol](https://modelcontextprotocol.io) standard.

Published by [Maestro Press](https://maestro.press) | [Product Page](https://maestro.press/software/crow/)

**Share memories, research, and messages directly between Crow users** — end-to-end encrypted, no central server, no accounts. The first AI platform where your assistant can securely collaborate with other people's assistants.

```
┌───────────────────────────────────────────────────────────────────────┐
│       AI Client (Claude, ChatGPT, Gemini, Grok, Cursor, etc.)       │
└────────┬──────────────────────┬──────────────────────┬───────────────┘
         │                      │                      │
   /memory/mcp            /research/mcp          /tools/mcp
   /sharing/mcp           /storage/mcp           /blog-mcp/mcp
   /sharing/sse           /relay/*
         │                      │                      │
┌────────┴──────────────────────┴──────────────────────┴───────────────┐
│  Crow Gateway (Express + OAuth 2.1)                                  │
│  ├── crow-memory (persistent memory + full-text search)              │
│  ├── crow-research (research pipeline + APA citations)               │
│  ├── crow-sharing (P2P encrypted sharing + Nostr messaging)          │
│  ├── crow-storage (S3-compatible file storage + quotas)              │
│  ├── crow-blog (publishing platform + RSS/Atom feeds)                │
│  └── proxy → GitHub, Slack, Notion, Gmail, Trello, Discord, etc.     │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                      ┌────────┴────────┐
                      │     SQLite       │
                      │ (local or Turso) │
                      └─────────────────┘

## P2P Sharing — A First for AI Platforms

Crow is the first AI platform with built-in encrypted peer-to-peer sharing. No cloud middleman, no accounts to create — just your Crow ID.

- **Share memories and research** — Send a memory or an entire research project to a friend's Crow, encrypted end-to-end
- **Collaborate on projects** — Grant read or read-write access to research projects that stay in sync automatically
- **Encrypted messaging** — Send messages between Crow users via the Nostr protocol with full sender anonymity
- **Works offline** — Shares queue up and deliver when both peers are online. Peer relays handle async delivery.
- **Zero trust** — No central server sees your data. Invite codes, safety numbers, and NaCl encryption throughout.

> *"Share my thesis project with Alice, read-write"* — that's it. Crow handles the cryptography, discovery, and sync.

Learn more: **[Sharing Guide](https://kh0pper.github.io/crow/guide/sharing)** · **[Architecture](https://kh0pper.github.io/crow/architecture/sharing-server)**

## Dashboard

Server-rendered web UI with Dark Editorial design. Password-protected, session-based auth. Built-in panels for Messages, Blog, Files, Extensions, and Settings. Third-party panels can be installed from `~/.crow/panels/`.

> **[Dashboard Guide](https://kh0pper.github.io/crow/guide/dashboard)** · **[Architecture](https://kh0pper.github.io/crow/architecture/dashboard)**

## Blog Platform

Create, edit, and publish blog posts through your AI assistant. Markdown rendering, customizable themes, RSS/Atom feeds, and shareable public URLs via the gateway.

> **[Blog Guide](https://kh0pper.github.io/crow/guide/blog)** · **[Architecture](https://kh0pper.github.io/crow/architecture/blog-server)**

## Works With

| Claude | ChatGPT | Gemini | Grok | Cursor | Windsurf | Cline | Claude Code |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Web, Mobile, Desktop | Apps/Connectors | CLI, AI Studio | Remote MCP | IDE | IDE | VS Code | CLI |

## Quick Start

### Cloud Deploy (any platform)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/kh0pper/crow)

1. Create a free [Turso](https://turso.tech) database
2. Click the Deploy button → paste your Turso credentials
3. Connect from your AI platform using the endpoint URLs shown at `/setup`

→ **[Full cloud deploy guide](https://kh0pper.github.io/crow/getting-started/cloud-deploy)**

### Desktop (Claude Desktop)

```bash
git clone https://github.com/kh0pper/crow.git && cd crow
npm run setup
npm run desktop-config  # Copy output to Claude Desktop config
```

→ **[Desktop setup guide](https://kh0pper.github.io/crow/getting-started/desktop-setup)**

### Developer (Claude Code)

```bash
cd crow
npm run setup
claude  # Loads .mcp.json + CLAUDE.md automatically
```

→ **[Claude Code guide](https://kh0pper.github.io/crow/platforms/claude-code)**

### Raspberry Pi / Self-Hosted (Crow OS)

```bash
curl -fsSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh | bash
crow status
```

Installs Crow as a persistent service with the `crow` CLI for managing bundles and updates. Supports Raspberry Pi, Debian, and Ubuntu.

→ **[Full setup guide](https://kh0pper.github.io/crow/getting-started/full-setup)**

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
- **Core Tools** — Add MCP tools to crow-memory, crow-research, crow-sharing, crow-storage, or crow-blog
- **Self-Hosted Bundles** — Create Docker Compose configs for specific use cases

→ **[Developer Docs](https://kh0pper.github.io/crow/developers/)** · **[Community Directory](https://kh0pper.github.io/crow/developers/directory)** · **[CONTRIBUTING.md](CONTRIBUTING.md)**

## Documentation

Full documentation at **[kh0pper.github.io/crow](https://kh0pper.github.io/crow/)**

- [Maestro Press Product Page](https://maestro.press/software/crow/) — Overview, vision, and quick start
- [Platform Guides](https://kh0pper.github.io/crow/platforms/) — Setup for Claude, ChatGPT, Gemini, Grok, Cursor, Windsurf, Cline
- [Integrations](https://kh0pper.github.io/crow/integrations/) — All 20+ services with API key setup instructions
- [Sharing & Social](https://kh0pper.github.io/crow/guide/sharing) — P2P encrypted sharing, messaging, and collaboration
- [Storage](https://kh0pper.github.io/crow/guide/storage) — S3-compatible file storage with quotas and presigned URLs
- [Blog](https://kh0pper.github.io/crow/guide/blog) — AI-driven publishing with themes, RSS, and public sharing
- [Dashboard](https://kh0pper.github.io/crow/guide/dashboard) — Web UI with panels for messages, files, blog, and extensions
- [Architecture](https://kh0pper.github.io/crow/architecture/) — System design, server APIs, gateway details
- [Skills](https://kh0pper.github.io/crow/skills/) — 30 behavioral prompts for AI workflows
- [Security](SECURITY.md) — API key safety, deployment security, and what to do if a key leaks
- [Troubleshooting](https://kh0pper.github.io/crow/troubleshooting)

## License

MIT
