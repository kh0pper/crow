# Crow AI Platform

An AI-enabled project management and research platform powered by Claude. Crow connects project management, communication, development tools, learning management, Google Workspace, and a research pipeline into a unified AI assistant with persistent memory.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Claude Code (AI)                      │
│                                                           │
│  CLAUDE.md (system prompt) + skills/*.md (15 workflows)   │
│  superpowers.md (auto-routing) + reflection.md (meta)     │
└─────────┬──────────────────────────────────┬──────────────┘
          │           MCP Protocol           │
    ┌─────┴─────┐                    ┌───────┴────────┐
    │  Custom    │                   │  External       │
    │  Servers   │                   │  Servers (13)   │
    ├───────────┤                   ├─────────────────┤
    │ Memory    │                   │ Trello          │
    │ Research  │                   │ Canvas LMS      │
    └─────┬─────┘                   │ Google Workspace│
          │                         │ Notion          │
    ┌─────┴─────┐                   │ Slack / Discord │
    │  SQLite   │                   │ MS Teams        │
    │  Database │                   │ GitHub          │
    └───────────┘                   │ Brave Search    │
                                    │ MCP Research    │
                                    │ Zotero          │
                                    │ Filesystem      │
                                    └─────────────────┘
```

## Components

### Custom MCP Servers (built-in)

| Server | Purpose | Tools |
|--------|---------|-------|
| **crow-memory** | Persistent, searchable memory across sessions | store, search, recall, list, update, delete, stats |
| **crow-research** | Research pipeline with APA citations | projects, sources, notes, search, verify, bibliography |

### External MCP Servers (pre-configured)

| Server | Purpose | Setup Required |
|--------|---------|----------------|
| **Trello** | Board/card management | API key + token |
| **Canvas LMS** | Course/assignment management | API token + base URL |
| **Google Workspace** | Gmail, Calendar, Sheets, Docs, Slides, Chat | OAuth credentials |
| **MCP Research** | Academic search (arXiv, Semantic Scholar) | None |
| **Zotero** | Citation management | API key + user ID |
| **Notion** | Wiki pages, databases, knowledge base | Integration token |
| **Slack** | Team messaging and channels | Bot token |
| **Discord** | Community servers and channels | Bot token |
| **Microsoft Teams** | Teams chats and channels (experimental) | Azure AD credentials |
| **GitHub** | Repos, issues, pull requests, code | Personal access token |
| **Brave Search** | Web search for research | API key |
| **Filesystem** | Local file system access | None |

### AI Skills (15 total)

| Skill | Description |
|-------|-------------|
| **`superpowers.md`** | Auto-activation routing — maps user intent to the right tools |
| **`reflection.md`** | Session summary + self-evaluation with friction analysis |
| `memory-management.md` | How to store, categorize, and retrieve memories |
| `research-pipeline.md` | Research documentation, APA citations, verification |
| `session-context.md` | Session start/end protocols for continuity |
| `project-management.md` | Trello + Canvas integration workflows |
| `google-workspace.md` | Gmail, Calendar, Docs workflows |
| `google-chat.md` | Google Chat spaces and messaging |
| `slack.md` | Slack messaging workflows |
| `discord.md` | Discord server messaging |
| `microsoft-teams.md` | Microsoft Teams (experimental) |
| `github.md` | GitHub repos, issues, PRs |
| `notion.md` | Notion wiki and database management |
| `web-search.md` | Brave Search for research and fact-checking |
| `filesystem.md` | Local file management |

## Quick Start

### For Developers (Claude Code)

```bash
# 1. Clone and enter the directory
cd crow

# 2. Run setup (installs deps, initializes DB)
npm run setup

# 3. Edit .env with your API keys (see .env.example)
#    Or run the interactive wizard:
node scripts/wizard.js

# 4. Start Claude Code
claude
```

Claude automatically loads `CLAUDE.md` (system context) and `.mcp.json` (MCP server configs).

### For Claude Desktop Users

```bash
# Option A: Interactive wizard (recommended)
cd crow
node scripts/wizard.js

# Option B: One-line installer
curl -fsSL https://raw.githubusercontent.com/YOUR_USER/crow/main/scripts/install.sh | bash

# Option C: Manual config generation
node scripts/generate-desktop-config.js
```

The wizard will:
1. Ask which integrations you want to enable
2. Walk you through getting API keys (with links)
3. Generate and install `claude_desktop_config.json` automatically

### For Non-Technical Users

1. Download and install [Claude Desktop](https://claude.ai/download)
2. Download the `.mcpb` extension files from the `dist/` folder
3. Double-click each `.mcpb` file to install in Claude Desktop
4. Restart Claude Desktop

## Database Schema

### Persistent Memory
- **memories** — Categorized, tagged, importance-ranked facts with full-text search
- Categories: general, project, preference, person, process, decision, learning, goal

### Research Pipeline
- **research_projects** — Organize research into named projects with status tracking
- **research_sources** — Every source with full metadata, APA citation, verification status
- **research_notes** — Quotes, summaries, analysis, questions, and insights linked to sources

## API Keys Setup

### Trello
1. Get API key: https://trello.com/power-ups/admin
2. Generate token: https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=YOUR_KEY

### Canvas LMS
1. Go to Canvas → Account → Settings → New Access Token

### Google Workspace (includes Google Chat)
1. Create project: https://console.cloud.google.com
2. Enable APIs: Gmail, Calendar, Sheets, Docs, Slides
3. Create OAuth 2.0 credentials

### Notion
1. Create an integration: https://www.notion.so/my-integrations
2. Share your pages/databases with the integration

### Slack
1. Create an app: https://api.slack.com/apps
2. Add scopes: channels:history, channels:read, chat:write, users:read
3. Install to workspace, copy Bot Token

### Discord (optional)
1. Create a bot: https://discord.com/developers/applications
2. Enable Message Content Intent
3. Add bot to your server

### Microsoft Teams (optional, experimental)
1. Register app: https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps
2. Add Graph permissions: Chat.Read, ChannelMessage.Read.All, ChannelMessage.Send

### GitHub
1. Generate token: https://github.com/settings/tokens
2. Recommended scopes: repo, read:org, read:user

### Brave Search
1. Get API key: https://brave.com/search/api/

### Zotero (optional)
1. Get API key: https://www.zotero.org/settings/keys

## Extending

### Add a new MCP server
1. Add config to `.mcp.json`
2. Add env vars to `.env.example`
3. Create a skill file in `skills/`
4. Update `CLAUDE.md` with the new server's description
5. Update the trigger table in `skills/superpowers.md`

### Building Desktop Extensions
```bash
bash scripts/build-extensions.sh
# Outputs .mcpb files to dist/
```
