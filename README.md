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
| **crow-memory** | Persistent, searchable memory across sessions | `crow_store_memory`, `crow_search_memories`, `crow_recall_by_context`, `crow_list_memories`, `crow_update_memory`, `crow_delete_memory`, `crow_memory_stats` |
| **crow-research** | Research pipeline with APA citations | `crow_create_project`, `crow_add_source`, `crow_add_note`, `crow_search_sources`, `crow_verify_source`, `crow_generate_bibliography`, `crow_research_stats` |

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

1. Go to [turso.tech](https://turso.tech) and sign up for a free account
2. Once logged in, click **Create Database**
3. Name it `crow` and pick any region close to you
4. After it's created, click on your `crow` database
5. You'll need two things from Turso — **keep this tab open**, you'll paste these in the next step:
   - **Database URL** — shown at the top of the database page. It looks like `libsql://crow-yourname.turso.io`
   - **Auth Token** — click **Generate Token**, then click the copy button next to it

### Step 2: Deploy to Render (one click)

Click this button to deploy Crow to the cloud for free:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/kh0pper/crow)

1. If you don't have a Render account, sign up at [render.com](https://render.com) (free — no credit card needed)
2. After clicking the Deploy button above, Render shows a form with two fields to fill in:
   - **TURSO_DATABASE_URL** — paste the database URL you copied from Turso (starts with `libsql://`)
   - **TURSO_AUTH_TOKEN** — paste the auth token you copied from Turso
3. Click **Apply** at the bottom and wait ~3 minutes for the build to finish
4. Once the build is done, Render shows your service page. Your URL is at the top of the page — it looks like `https://crow-gateway-xxxx.onrender.com`. **Copy this URL.**
5. Open a new browser tab and go to `https://your-url/health` (replace `your-url` with your actual Render URL). You should see `{"status":"ok"}` — this means Crow is running!

### Step 3: Connect Crow to Claude

This step connects Crow's tools to your Claude account. You'll add two integrations — one for memory, one for research. Works on both [claude.ai](https://claude.ai) in the browser and the Claude mobile app.

1. Go to [claude.ai/settings](https://claude.ai/settings)
2. Click **Integrations** in the left sidebar (on mobile, it may be called **Connectors**)
3. Click **Add Custom Integration** (or **Add Custom Connector** on mobile)
4. **Add your memory tools:**
   - **Name:** `Crow Memory`
   - **URL:** `https://your-url/memory/mcp` (replace `your-url` with your Render URL from Step 2)
   - Click **Add** → then click **Connect** → then click **Allow**
5. **Go back and add your research tools the same way:**
   - Click **Add Custom Integration** again
   - **Name:** `Crow Research`
   - **URL:** `https://your-url/research/mcp` (same Render URL, but `/research/mcp` this time)
   - Click **Add** → **Connect** → **Allow**
6. You're done! Start a new chat on [claude.ai](https://claude.ai) or the Claude mobile app.

> **Try it out!** Say: *"Use crow_store_memory to remember that my favorite color is blue"* — then open a **new chat** and ask *"What's my favorite color?"* (Claude will use crow_recall_by_context to find it.)

### Troubleshooting

| Problem | Solution |
|---------|----------|
| **"Connection failed" when adding integration** | Double-check your URL — it should start with `https://` and end with `/memory/mcp` or `/research/mcp`. Make sure there's no trailing slash. |
| **Health check shows an error page** | Go to your Render dashboard, click on your service, and check the **Logs** tab for error messages. Make sure your Turso URL and token are correct. |
| **Tools work but are slow the first time** | Render's free tier puts your service to sleep after 15 minutes of inactivity. The first request after it sleeps takes ~30 seconds to wake up. This is normal — subsequent requests are fast. |
| **Claude doesn't seem to use Crow tools** | Start a **new chat** (existing chats don't pick up new integrations). You can also try saying the tool name directly, e.g., *"Use crow_memory_stats to check my memory count."* |
| **"Not authorized" error** | Crow's gateway uses OAuth for security. When you click **Connect** in Claude's settings, you should see an authorization page — click **Allow**. If you skipped this, remove the integration and add it again. |

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
