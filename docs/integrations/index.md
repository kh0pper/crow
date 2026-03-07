# Integrations

Crow connects to 15+ external services through MCP servers. The two built-in servers (Memory and Research) work out of the box. External integrations need API keys added to your environment.

## Built-in Servers

These are always available — no API keys needed:

| Server | Tools | Description |
|---|---|---|
| **crow-memory** | 7 tools | Persistent memory: store, search, recall, list, update, delete, stats |
| **crow-research** | 12 tools | Research pipeline: projects, sources, notes, citations, bibliography |

## External Integrations

Add API keys to enable these. For cloud deployments, add keys in your [Render dashboard](https://dashboard.render.com) under Environment.

| Integration | Env Variables | Description | Get API Key |
|---|---|---|---|
| **GitHub** | `GITHUB_PERSONAL_ACCESS_TOKEN` | Repos, issues, PRs, code search | [GitHub Settings](https://github.com/settings/tokens) |
| **Brave Search** | `BRAVE_API_KEY` | Web search, local search | [Brave API](https://brave.com/search/api/) |
| **Slack** | `SLACK_BOT_TOKEN` | Messages, channels, threads | [Slack Apps](https://api.slack.com/apps) |
| **Notion** | `NOTION_TOKEN` | Pages, databases, comments | [Notion Integrations](https://www.notion.so/my-integrations) |
| **Trello** | `TRELLO_API_KEY`, `TRELLO_TOKEN` | Boards, cards, lists | [Trello Power-Ups](https://trello.com/power-ups/admin) |
| **Discord** | `DISCORD_BOT_TOKEN` | Servers, channels, messages | [Discord Developer Portal](https://discord.com/developers/applications) |
| **Google Workspace** | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Gmail, Calendar, Drive, Docs, Sheets, Slides, Chat | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) |
| **Canvas LMS** | `CANVAS_API_TOKEN`, `CANVAS_BASE_URL` | Courses, assignments, grades | Canvas account settings |
| **Microsoft Teams** | `TEAMS_CLIENT_ID`, `TEAMS_CLIENT_SECRET`, `TEAMS_TENANT_ID` | Messages, channels, teams | [Azure Portal](https://portal.azure.com) |
| **Zotero** | `ZOTERO_API_KEY`, `ZOTERO_USER_ID` | Citations, library management | [Zotero Settings](https://www.zotero.org/settings/keys) |
| **arXiv** | *(none)* | Academic paper search, full text | Works out of the box |
| **Render** | `RENDER_API_KEY` | Deployment management | [Render API Keys](https://dashboard.render.com/account/api-keys) |

## How Integration Proxy Works

When deployed via the gateway, external integrations are available through the `/tools/mcp` endpoint. The gateway:

1. Reads which API keys are set in the environment
2. Spawns only the configured MCP servers as child processes
3. Aggregates all their tools into a single `/tools/mcp` endpoint
4. Prefixes tool names to avoid conflicts

This means you add one MCP connection from your AI client (the `/tools/mcp` URL) and get access to all configured external services.

## Adding a New Integration

See the [Architecture > Gateway](../architecture/gateway) page for details on how the proxy system works and how to add new integrations.
