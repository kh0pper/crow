# Crow AI Platform

Persistent memory, research pipeline, encrypted P2P sharing, and 15+ integrations for your AI assistant. Built on the open [Model Context Protocol](https://modelcontextprotocol.io) standard.

**Share memories, research, and messages directly between Crow users** — end-to-end encrypted, no central server, no accounts. The first AI platform where your assistant can securely collaborate with other people's assistants.

```
┌───────────────────────────────────────────────────────────────────────┐
│       AI Client (Claude, ChatGPT, Gemini, Grok, Cursor, etc.)       │
└────────┬──────────────────────┬──────────────────────┬───────────────┘
         │                      │                      │
   /memory/mcp            /research/mcp          /tools/mcp
   /sharing/mcp           /sharing/sse           /relay/*
         │                      │                      │
┌────────┴──────────────────────┴──────────────────────┴───────────────┐
│  Crow Gateway (Express + OAuth 2.1)                                  │
│  ├── crow-memory (persistent memory + full-text search)              │
│  ├── crow-research (research pipeline + APA citations)               │
│  ├── crow-sharing (P2P encrypted sharing + Nostr messaging)          │
│  └── proxy → GitHub, Slack, Notion, Gmail, Trello, Discord, etc.     │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                         ┌─────┴─────┐
                         │  SQLite   │
                         │ (Turso)   │
                         └───────────┘

## P2P Sharing — A First for AI Platforms

Crow is the first AI platform with built-in encrypted peer-to-peer sharing. No cloud middleman, no accounts to create — just your Crow ID.

- **Share memories and research** — Send a memory or an entire research project to a friend's Crow, encrypted end-to-end
- **Collaborate on projects** — Grant read or read-write access to research projects that stay in sync automatically
- **Encrypted messaging** — Send messages between Crow users via the Nostr protocol with full sender anonymity
- **Works offline** — Shares queue up and deliver when both peers are online. Peer relays handle async delivery.
- **Zero trust** — No central server sees your data. Invite codes, safety numbers, and NaCl encryption throughout.

> *"Share my thesis project with Alice, read-write"* — that's it. Crow handles the cryptography, discovery, and sync.

Learn more: **[Sharing Guide](https://kh0pper.github.io/crow/guide/sharing)** · **[Architecture](https://kh0pper.github.io/crow/architecture/sharing-server)**

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

## Documentation

Full documentation at **[kh0pper.github.io/crow](https://kh0pper.github.io/crow/)**

- [Platform Guides](https://kh0pper.github.io/crow/platforms/) — Setup for Claude, ChatGPT, Gemini, Grok, Cursor, Windsurf, Cline
- [Integrations](https://kh0pper.github.io/crow/integrations/) — All 15+ services with API key setup instructions
- [Sharing & Social](https://kh0pper.github.io/crow/guide/sharing) — P2P encrypted sharing, messaging, and collaboration
- [Architecture](https://kh0pper.github.io/crow/architecture/) — System design, server APIs, gateway details
- [Skills](https://kh0pper.github.io/crow/skills/) — 24 behavioral prompts for AI workflows
- [Security](SECURITY.md) — API key safety, deployment security, and what to do if a key leaks
- [Troubleshooting](https://kh0pper.github.io/crow/troubleshooting)

## License

MIT
