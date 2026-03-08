# Integrations

Crow connects to 20+ external services through MCP servers. The built-in servers (Memory, Research, Sharing, Blog, Storage) work out of the box. External integrations need API keys added to your environment.

## Built-in Servers

These are always available — no API keys needed:

| Server | Tools | Description |
|---|---|---|
| **crow-memory** | 7 tools | Persistent memory: store, search, recall, list, update, delete, stats |
| **crow-research** | 12 tools | Research pipeline: projects, sources, notes, citations, bibliography |

## Keeping Your Keys Safe

Each API key only grants access to that one service — a leaked GitHub key can't access your Gmail, for example. But you should still treat every key with care:

- **Only add keys for services you actually use** — fewer keys means less to manage and less risk
- **Never share keys** in screenshots, messages, or public repositories
- **If a key leaks**, revoke it immediately at the service's website and create a new one

For a complete, beginner-friendly security guide, see [SECURITY.md](https://github.com/kh0pper/crow/blob/main/SECURITY.md).

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
| **Obsidian** | `OBSIDIAN_VAULT_PATH` | Vault search, note sync | Local path to vault |
| **Home Assistant** | `HA_URL`, `HA_TOKEN` | Smart home device control | [HA Long-Lived Tokens](https://www.home-assistant.io/docs/authentication/) |
| **Render** | `RENDER_API_KEY` | Deployment management | [Render API Keys](https://dashboard.render.com/account/api-keys) |

## Self-Hosting Add-ons (Bundles)

These are installable add-ons with Docker Compose configurations. Install with `crow bundle install <id>` or ask your AI.

| Add-on | Type | Description |
|---|---|---|
| **Ollama** | Bundle (Docker) | Local AI models for embeddings, summarization, classification |
| **Nextcloud** | Bundle (Docker) | File sync via WebDAV mount (v1: files only) |
| **Immich** | Bundle (Docker + custom MCP) | Photo library search, album management |

## How Integration Proxy Works

When deployed via the gateway, external integrations are available through the `/tools/mcp` endpoint. The gateway:

1. Reads which API keys are set in the environment
2. Spawns only the configured MCP servers as child processes
3. Aggregates all their tools into a single `/tools/mcp` endpoint
4. Prefixes tool names to avoid conflicts

This means you add one MCP connection from your AI client (the `/tools/mcp` URL) and get access to all configured external services.

## Adding a New Integration

See the [Architecture > Gateway](../architecture/gateway) page for details on how the proxy system works and how to add new integrations.
