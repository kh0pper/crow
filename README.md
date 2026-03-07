# Crow AI Platform

Persistent memory, research pipeline, and 15+ integrations for your AI assistant. Built on the open [Model Context Protocol](https://modelcontextprotocol.io) standard.

```
┌───────────────────────────────────────────────────────────────────────┐
│       AI Client (Claude, ChatGPT, Gemini, Grok, Cursor, etc.)       │
└────────┬──────────────────────┬──────────────────────┬───────────────┘
         │                      │                      │
   /memory/mcp            /research/mcp          /tools/mcp
         │                      │                      │
┌────────┴──────────────────────┴──────────────────────┴───────────────┐
│  Crow Gateway (Express + OAuth 2.1)                                  │
│  ├── crow-memory (persistent memory + full-text search)              │
│  ├── crow-research (research pipeline + APA citations)               │
│  └── proxy → GitHub, Slack, Notion, Gmail, Trello, Discord, etc.     │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                         ┌─────┴─────┐
                         │  SQLite   │
                         │ (Turso)   │
                         └───────────┘
```

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
- [Architecture](https://kh0pper.github.io/crow/architecture/) — System design, server APIs, gateway details
- [Skills](https://kh0pper.github.io/crow/skills/) — 17 behavioral prompts for AI workflows
- [Troubleshooting](https://kh0pper.github.io/crow/troubleshooting)

## License

MIT
