# Crow AI Platform

An AI-enabled project management and research platform powered by Claude. Crow connects project management tools, learning management systems, Google Workspace, and a research pipeline into a unified AI assistant with persistent memory.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Claude Code (AI)                   │
│                                                      │
│  CLAUDE.md (system prompt) + skills/*.md (workflows) │
└──────────┬──────────────────────────────┬────────────┘
           │         MCP Protocol         │
     ┌─────┴─────┐                  ┌─────┴─────┐
     │  Custom    │                  │ External   │
     │  Servers   │                  │ Servers    │
     ├───────────┤                  ├────────────┤
     │ Memory    │                  │ Trello     │
     │ Research  │                  │ Canvas LMS │
     └─────┬─────┘                  │ Google WS  │
           │                        │ MCP Research│
     ┌─────┴─────┐                  │ Zotero     │
     │  SQLite   │                  └────────────┘
     │  Database │
     └───────────┘
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
| **Google Workspace** | Gmail, Calendar, Sheets, Docs, Slides | OAuth credentials |
| **MCP Research** | Academic search (arXiv, Semantic Scholar) | None |
| **Zotero** | Citation management | API key + user ID |

### AI Skills

| Skill | Description |
|-------|-------------|
| `memory-management.md` | How to store, categorize, and retrieve memories |
| `research-pipeline.md` | Research documentation, APA citations, verification |
| `project-management.md` | Trello + Canvas integration workflows |
| `google-workspace.md` | Gmail, Calendar, Docs workflows |
| `session-context.md` | Session start/end protocols for continuity |

## Quick Start

```bash
# 1. Clone and enter the directory
cd crow

# 2. Run setup (installs deps, initializes DB)
npm run setup

# 3. Edit .env with your API keys
#    (see .env.example for what's needed)

# 4. Start Claude Code
claude
```

Claude will automatically load `CLAUDE.md` (system context) and `.mcp.json` (MCP server configs).

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

### Google Workspace
1. Create project: https://console.cloud.google.com
2. Enable APIs: Gmail, Calendar, Sheets, Docs, Slides
3. Create OAuth 2.0 credentials

### Zotero (optional)
1. Get API key: https://www.zotero.org/settings/keys

## Extending

### Add a new MCP server
1. Add config to `.mcp.json`
2. Add env vars to `.env.example`
3. Create a skill file in `skills/`
4. Update `CLAUDE.md` with the new server's description

### Suggested expansions
- **Notion** — `notion-mcp` for wiki/docs
- **Slack** — `mcp-server-slack` for team communication
- **GitHub** — `github-mcp-server` (official) for repos/issues/PRs
- **Brave Search** — `@anthropic/mcp-server-brave-search` for web search
- **Filesystem** — `@anthropic/mcp-server-filesystem` for local file access
