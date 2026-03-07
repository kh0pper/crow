# Crow AI Platform

An AI-enabled project management and research platform powered by Claude. Crow connects project management, communication, development tools, learning management, Google Workspace, and a research pipeline into a unified AI assistant with persistent memory.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                 Claude (Web / Mobile / Desktop)                     │
└─────────┬────────────────────┬────────────────────┬────────────────┘
          │                    │                    │
    /memory/mcp          /research/mcp        /tools/mcp
          │                    │                    │
┌─────────┴────────────────────┴────────────────────┴────────────────┐
│  Crow Gateway (Render)                                              │
│  ├── crow-memory server (persistent memory + search)                │
│  ├── crow-research server (research pipeline + APA citations)       │
│  └── proxy server → spawns external tools on demand                 │
│       ├── GitHub, Brave Search, Slack, Notion, Trello               │
│       ├── Discord, Canvas LMS, Microsoft Teams                      │
│       └── Google Workspace, Zotero, MCP Research                    │
└─────────────────────────────┬──────────────────────────────────────┘
                              │
                        ┌─────┴─────┐
                        │  SQLite   │
                        │ (Turso)   │
                        └───────────┘
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
| **arXiv** | Academic paper search and full-text retrieval | None |
| **Render** | Manage your Render deployment from Claude | API key |
| **Zotero** | Citation management | API key + user ID |
| **Notion** | Wiki pages, databases, knowledge base | Integration token |
| **Slack** | Team messaging and channels | Bot token |
| **Discord** | Community servers and channels | Bot token |
| **Microsoft Teams** | Teams chats and channels (experimental) | Azure AD credentials |
| **GitHub** | Repos, issues, pull requests, code | Personal access token |
| **Brave Search** | Web search for research | API key |
| **Filesystem** | Local file system access (Desktop only) | None |

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
2. After clicking the Deploy button above, Render shows a form. Fill in the first two fields:
   - **TURSO_DATABASE_URL** — paste the database URL you copied from Turso (starts with `libsql://`)
   - **TURSO_AUTH_TOKEN** — paste the auth token you copied from Turso
3. You'll also see fields for GitHub, Slack, Notion, etc. — **you can skip these for now** and add them later (see Step 4). Just fill in Turso and leave the rest blank.
4. Click **Apply** at the bottom and wait ~3 minutes for the build to finish
5. Once the build is done, Render shows your service page. Your URL is at the top of the page — it looks like `https://crow-gateway-xxxx.onrender.com`. **Copy this URL.**
6. Open a new browser tab and go to `https://your-url/health` (replace `your-url` with your actual Render URL). You should see `{"status":"ok"}` — this means Crow is running!

### Step 3: Connect Crow to Claude

This step connects Crow's tools to your Claude account. You'll add three integrations — one for memory, one for research, and one for external tools. Works on both [claude.ai](https://claude.ai) in the browser and the Claude mobile app.

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
6. **Add external tools (GitHub, Slack, etc.):**
   - Click **Add Custom Integration** again
   - **Name:** `Crow Tools`
   - **URL:** `https://your-url/tools/mcp` (same Render URL, but `/tools/mcp` this time)
   - Click **Add** → **Connect** → **Allow**
7. You're done! Start a new chat on [claude.ai](https://claude.ai) or the Claude mobile app.

> **Try it out!** Say: *"Use crow_store_memory to remember that my favorite color is blue"* — then open a **new chat** and ask *"What's my favorite color?"* (Claude will use crow_recall_by_context to find it.)

### Step 4: Add your other integrations (optional)

Crow can connect to GitHub, Slack, Notion, and more — right from your phone or browser. Each integration needs an API key from that service. You paste the key into Render, and Crow handles the rest.

**How to add an integration:**

1. **Get your API key** from the service (see the table below for links and instructions)
2. **Go to your Render dashboard** → click on your `crow-gateway` service → click **Environment** in the left sidebar
3. **Click "Add Environment Variable"** → type the variable name exactly as shown in the table below → paste your API key as the value → click **Save Changes**
4. Render will automatically restart your service (takes about 1 minute)
5. Start a new chat in Claude — your new tools are available!

> **You only need to add the `/tools/mcp` connector once** (you did this in Step 3). After that, any time you add a new API key in Render, the new tools automatically appear — no need to add another connector.

> **Check your setup anytime:** Visit `https://your-url/setup` in your browser to see which integrations are connected (green) and which still need API keys.

**Available integrations:**

| Integration | What it does | Variable(s) to add in Render | Where to get your key |
|-------------|-------------|------------------------------|----------------------|
| **GitHub** | Manage repos, issues, pull requests | `GITHUB_PERSONAL_ACCESS_TOKEN` | [github.com/settings/tokens](https://github.com/settings/tokens) — Generate new token (classic) with `repo`, `read:org`, `read:user` scopes |
| **Brave Search** | Search the web | `BRAVE_API_KEY` | [brave.com/search/api](https://brave.com/search/api/) — sign up, copy key from dashboard |
| **Slack** | Read and send messages | `SLACK_BOT_TOKEN` | [api.slack.com/apps](https://api.slack.com/apps) — Create app, add scopes, install, copy Bot Token (`xoxb-...`) |
| **Notion** | Manage wiki pages and databases | `NOTION_TOKEN` | [notion.so/my-integrations](https://www.notion.so/my-integrations) — Create integration, copy secret (`ntn_...`), share pages with it |
| **Trello** | Manage boards and cards | `TRELLO_API_KEY` and `TRELLO_TOKEN` | [trello.com/power-ups/admin](https://trello.com/power-ups/admin) — copy API key, then generate token |
| **Discord** | Read and send messages | `DISCORD_BOT_TOKEN` | [discord.com/developers](https://discord.com/developers/applications) — New Application, Bot tab, copy token |
| **Canvas LMS** | Course and assignment management | `CANVAS_API_TOKEN` and `CANVAS_BASE_URL` | Canvas — Account → Settings → New Access Token |
| **Google Workspace** | Gmail, Calendar, Docs, Sheets | `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` | [console.cloud.google.com](https://console.cloud.google.com) — Create OAuth Client ID (Desktop App type) |
| **Zotero** | Citation management | `ZOTERO_API_KEY` and `ZOTERO_USER_ID` | [zotero.org/settings/keys](https://www.zotero.org/settings/keys) — Create private key, note user ID |
| **arXiv** | Academic paper search | *(none — works automatically)* | No setup needed |
| **Microsoft Teams** | Team messaging (experimental) | `TEAMS_CLIENT_ID`, `TEAMS_CLIENT_SECRET`, `TEAMS_TENANT_ID` | [Azure Portal](https://portal.azure.com) — App registrations |
| **Render** | Manage your Render deployment | `RENDER_API_KEY` | [dashboard.render.com/account/api-keys](https://dashboard.render.com/account/api-keys) — Create API Key, copy it |

### Troubleshooting

| Problem | Solution |
|---------|----------|
| **"Connection failed" when adding integration** | Double-check your URL — it should start with `https://` and end with `/memory/mcp`, `/research/mcp`, or `/tools/mcp`. Make sure there's no trailing slash. |
| **Health check shows an error page** | Go to your Render dashboard, click on your service, and check the **Logs** tab for error messages. Make sure your Turso URL and token are correct. |
| **Tools work but are slow the first time** | Render's free tier puts your service to sleep after 15 minutes of inactivity. The first request after it sleeps takes ~30 seconds to wake up. This is normal — subsequent requests are fast. |
| **Claude doesn't seem to use Crow tools** | Start a **new chat** (existing chats don't pick up new integrations). You can also try saying the tool name directly, e.g., *"Use crow_memory_stats to check my memory count."* |
| **"Not authorized" error** | Crow's gateway uses OAuth for security. When you click **Connect** in Claude's settings, you should see an authorization page — click **Allow**. If you skipped this, remove the integration and add it again. |
| **Not sure which integrations are connected** | Visit `https://your-url/setup` — it shows which are active (green) and which need API keys (with links to get them). |
| **Added an API key but tools didn't appear** | After adding an env var in Render, wait ~1 minute for the service to restart. Then start a **new chat** in Claude. |

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

## Adding External Integrations — Desktop Users

If you're using **Claude Desktop** (not the web/mobile setup above), external integrations are configured locally through API keys stored in a `.env` file on your computer.

> **Important**: You only need to set up the integrations you actually use. Everything is optional. Crow's memory and research tools work without any of these.

### How it works

Each integration needs an API key or token. Here's what happens:

1. You get an API key from the service's website (instructions below)
2. You paste it into Crow's setup wizard or `.env` file
3. Claude Desktop reads the key and connects to the service

### The easy way: Setup Wizard

The setup wizard gives you a visual form where you paste each API key — no file editing required.

```bash
npm run wizard    # Opens a browser page with fields for each integration
```

The wizard saves everything to a `.env` file in the project folder. Done!

### The manual way: Edit the `.env` file

If you prefer, copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

Then open `.env` in any text editor and paste your keys next to the matching variable names. For example, if you have a GitHub token, find the `GITHUB_PERSONAL_ACCESS_TOKEN=` line and paste your token after the `=`:

```
GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

Save the file. Next time you open Claude Desktop, the integration will be active.

---

### Where to get each API key

Every integration below tells you: (1) where to get the key, (2) what to copy, and (3) which `.env` variable to paste it into.

#### Trello
1. Go to https://trello.com/power-ups/admin → copy your **API Key**
2. Then visit: `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=YOUR_API_KEY` (replace `YOUR_API_KEY` with the key you just copied) → copy the **Token** shown on the page
3. Paste into `.env`:
   - `TRELLO_API_KEY=your-api-key`
   - `TRELLO_TOKEN=your-token`

#### Canvas LMS
1. In Canvas, go to **Account** → **Settings** → scroll down → **New Access Token** → copy the token
2. Also note your Canvas URL (e.g., `https://your-school.instructure.com`)
3. Paste into `.env`:
   - `CANVAS_API_TOKEN=your-token`
   - `CANVAS_BASE_URL=https://your-school.instructure.com`

#### Google Workspace (Gmail, Calendar, Sheets, Docs, Slides, Chat)
1. Go to https://console.cloud.google.com → create a project (or select existing)
2. Go to **APIs & Services** → **Library** → enable: Gmail API, Google Calendar API, Google Sheets API, Google Docs API, Google Slides API
3. Go to **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth Client ID**
4. Set application type to **Desktop App**, click **Create**
5. Copy the **Client ID** and **Client Secret**
6. Paste into `.env`:
   - `GOOGLE_CLIENT_ID=your-client-id`
   - `GOOGLE_CLIENT_SECRET=your-client-secret`

#### Notion
1. Go to https://www.notion.so/my-integrations → **Create new integration**
2. Give it a name (e.g., "Crow"), select your workspace, click **Submit**
3. Copy the **Internal Integration Secret** (starts with `ntn_`)
4. **Important**: Go to each Notion page/database you want Crow to access → click `...` → **Connections** → add your integration
5. Paste into `.env`:
   - `NOTION_TOKEN=ntn_your-token`

#### Slack
1. Go to https://api.slack.com/apps → **Create New App** → **From Scratch**
2. Go to **OAuth & Permissions** → scroll to **Bot Token Scopes** → add: `channels:history`, `channels:read`, `chat:write`, `users:read`
3. Click **Install to Workspace** at the top → **Allow**
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`)
5. Paste into `.env`:
   - `SLACK_BOT_TOKEN=xoxb-your-token`

#### Discord (optional)
1. Go to https://discord.com/developers/applications → **New Application**
2. Go to **Bot** tab → click **Reset Token** → copy the token
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**
4. To add the bot to your server: go to **OAuth2** → **URL Generator** → check `bot` scope → check needed permissions → open the generated URL
5. Paste into `.env`:
   - `DISCORD_BOT_TOKEN=your-token`

#### GitHub
1. Go to https://github.com/settings/tokens → **Generate new token (classic)**
2. Select scopes: `repo`, `read:org`, `read:user`
3. Click **Generate token** → copy it immediately (you can't see it again)
4. Paste into `.env`:
   - `GITHUB_PERSONAL_ACCESS_TOKEN=ghp_your-token`

#### Brave Search
1. Go to https://brave.com/search/api/ → sign up for a free API key
2. Copy your API key from the dashboard
3. Paste into `.env`:
   - `BRAVE_API_KEY=your-api-key`

#### Zotero (optional)
1. Go to https://www.zotero.org/settings/keys → **Create new private key**
2. Check "Allow library access"
3. Copy the **API key** and note your **User ID** (shown at the top of the page)
4. Paste into `.env`:
   - `ZOTERO_API_KEY=your-key`
   - `ZOTERO_USER_ID=your-user-id`

#### Microsoft Teams (optional, experimental)
1. Go to https://portal.azure.com → **Azure Active Directory** → **App registrations** → **New registration**
2. Add API permissions: `Chat.Read`, `ChannelMessage.Read.All`, `ChannelMessage.Send`
3. Go to **Certificates & secrets** → **New client secret** → copy the value
4. Paste into `.env`:
   - `TEAMS_CLIENT_ID=your-app-client-id`
   - `TEAMS_CLIENT_SECRET=your-client-secret`
   - `TEAMS_TENANT_ID=your-tenant-id`

#### MCP Research & Filesystem
These two require **no setup** — they work out of the box with no API keys.

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
