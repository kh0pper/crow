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

### AI Skills (17 total)

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
| `mobile-access.md` | Remote/mobile access via HTTP gateway |
| **`skill-writing.md`** | **Dynamic skill creation** — AI writes new skills with user consent |

---

## Use Crow from Claude.ai (Web & Mobile)

**This is the easiest way to use Crow.** No coding required. Works from any browser or the Claude mobile app.

You'll set up two free accounts (Render + Turso), click a few buttons, and you're done. Takes about 10 minutes.

### Step 1: Create a free database

Crow needs a place to store your memories and research. Turso gives you a free cloud database.

1. Go to [turso.tech](https://turso.tech) and sign up (free)
2. Once logged in, click **Create Database**
3. Name it `crow` and pick any region close to you
4. After it's created, click on your `crow` database
5. You'll need two things from Turso (keep this tab open):
   - **Database URL** — looks like `libsql://crow-yourname.turso.io`
   - **Auth Token** — click **Generate Token** to create one, then copy it

### Step 2: Deploy to Render (one click)

Click this button to deploy Crow to the cloud for free:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/kh0pper/crow)

1. Sign up for [Render](https://render.com) if you don't have an account (free)
2. After clicking the button, Render will ask you to fill in two values:
   - **TURSO_DATABASE_URL** — paste the database URL from Step 1
   - **TURSO_AUTH_TOKEN** — paste the auth token from Step 1
3. Click **Apply** and wait ~3 minutes for the build to finish
4. When it's done, copy your service URL — it looks like `https://crow-gateway-xxxx.onrender.com`
5. Visit `https://your-url/health` in your browser to confirm it says `{"status":"ok"}`

### Step 3: Connect to Claude

1. Go to [claude.ai/settings](https://claude.ai/settings) → **Integrations** (or **Connectors**)
2. Click **Add Custom Integration** (or **Add Custom Connector**)
3. Add your **memory** tools:
   - Name: `Crow Memory`
   - URL: `https://your-url/memory/mcp`
   - Click **Connect** → **Allow**
4. Add your **research** tools:
   - Name: `Crow Research`
   - URL: `https://your-url/research/mcp`
   - Click **Connect** → **Allow**
5. Start a new chat on [claude.ai](https://claude.ai) or the Claude mobile app — your memory and research tools are now available!

> **That's it!** Try saying: *"Store a memory that my favorite color is blue"* — then in a new chat, say *"What's my favorite color?"*

---

## Quick Start — Desktop App (Claude Desktop)

If you want to run Crow locally with the Claude Desktop app:

1. Download this repository as a ZIP (green "Code" button → "Download ZIP")
2. Unzip it anywhere on your computer
3. **macOS**: Double-click `start.command`
   **Windows**: Double-click `start.bat`
   **Linux**: Double-click `start.sh` (or run `./start.sh`)
4. The setup wizard opens in your browser — follow the step-by-step instructions
5. Open Claude Desktop — all tools are ready

> **Need Node.js?** The launcher will detect if it's missing and open the download page for you.

## Quick Start — Developer

```bash
cd crow
npm run setup          # Install deps, init database
npm run wizard         # Open web wizard for API keys
claude                 # Start Claude Code
```

Claude automatically loads `CLAUDE.md` (system context) and `.mcp.json` (MCP server configs).

## Self-Hosted Gateway (Docker)

For advanced users who want to host the gateway themselves:

```bash
# Cloud VPS
docker compose --profile cloud up --build

# Local with Cloudflare Tunnel
docker compose --profile local up --build
```

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
