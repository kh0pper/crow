---
title: CrowClaw Architecture
---

# CrowClaw

CrowClaw is a Crow bundle (`type: "mcp-server"`) that provides bot management through 20 MCP tools and a dashboard panel. It runs as a child process of the Crow gateway, sharing the same `crow.db` database.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Crow's Nest Dashboard                                            │
│  └── Bots Panel (/dashboard/bots)                                 │
│      ├── Bot list (status, health, controls)                      │
│      ├── Create / configure / deploy / delete                     │
│      └── Messages integration (bot chat)                          │
├──────────────────────────────────────────────────────────────────┤
│  CrowClaw MCP Server (20 tools)                                   │
│  ├── Bot Lifecycle (7): create, configure, deploy, start/stop/restart, delete │
│  ├── Monitoring (3): status, logs, health                         │
│  ├── User Profiles (4): create, update, list, delete              │
│  └── Workspace & Skills (6): templates, workspace files, skills   │
├──────────────────────────────────────────────────────────────────┤
│  BYOAI Bridge                                                     │
│  └── Crow AI profiles → bot models.json (auto on deploy)          │
├──────────────────────────────────────────────────────────────────┤
│  Bot Chat Routes                                                  │
│  └── REST API: GET messages, POST message (polling), POST new-session │
├──────────────────────────────────────────────────────────────────┤
│  crow.db (SQLite, WAL mode, shared by 6+ processes)               │
│  └── Tables: crowclaw_bots, crowclaw_user_profiles,               │
│      crowclaw_workspace_files, crowclaw_deployments,              │
│      crowclaw_skills, crowclaw_safety_events, crowclaw_bot_messages │
└──────────────────────────────────────────────────────────────────┘
         │                              │
    systemctl --user              OpenClaw Engine
    (bot services)                (per-bot gateway)
```

## Bundle Registration

CrowClaw must be registered in three places for Crow to discover it:

| File | Purpose |
|------|---------|
| `~/.crow/installed.json` | Bundle entry with `id: "crowclaw"` |
| `~/.crow/mcp-addons.json` | MCP server config with `cwd` pointing to bundle dir |
| `~/.crow/panels.json` | Panel ID `"bots"` (routes to `/dashboard/bots`) |

The panel ID is `"bots"` (not `"crowclaw"`). The extension proxy route is `/proxy/crowclaw/`.

## MCP Tools

### Bot Lifecycle (7)

| Tool | Description |
|------|-------------|
| `crow_create_bot` | Create a new bot with name, platform credentials, AI config |
| `crow_configure_bot` | Update bot settings (model, skills, safety) |
| `crow_deploy_bot` | Deploy bot config, generate models.json, start service |
| `crow_start_bot` | Start the bot's systemd service |
| `crow_stop_bot` | Stop the bot's systemd service |
| `crow_restart_bot` | Restart the bot's systemd service |
| `crow_delete_bot` | Remove bot, config files, and service (confirm gate) |

### Monitoring (3)

| Tool | Description |
|------|-------------|
| `crow_bot_status` | Status of all bots or a specific bot (running, stopped, errors) |
| `crow_bot_logs` | Recent journal logs for a bot's systemd service |
| `crow_bot_health` | Health metrics: uptime, error rate, last activity |

### User Profiles (4)

| Tool | Description |
|------|-------------|
| `crow_create_user_profile` | Create a user profile (name, platform IDs, permissions) |
| `crow_update_user_profile` | Update profile fields |
| `crow_list_user_profiles` | List all profiles |
| `crow_delete_user_profile` | Remove a profile (confirm gate) |

### Workspace & Skills (6)

| Tool | Description |
|------|-------------|
| `crow_list_workspace_templates` | List available bot workspace templates |
| `crow_update_workspace_file` | Write a file to a bot's workspace |
| `crow_get_workspace_file` | Read a file from a bot's workspace |
| `crow_list_bot_skills` | List skills deployed to a bot |
| `crow_deploy_skill` | Push a SKILL.md file to a bot (confirm gate) |
| `crow_remove_skill` | Remove a skill from a bot (confirm gate) |

## Confirm Gate

Destructive operations require a two-call confirmation pattern (`server/confirm.js`):

1. **First call**: Returns a confirmation token and description of what will happen
2. **Second call**: Same parameters plus the confirmation token — executes the operation

This prevents accidental deletions from a single misrouted tool call. Protected operations: deploy, delete bot, delete profile, remove skill.

## Database Tables

All tables live in Crow's shared `crow.db` (WAL mode, `busy_timeout = 5000`).

| Table | Purpose |
|-------|---------|
| `crowclaw_bots` | Bot definitions: name, platform, AI config, status |
| `crowclaw_user_profiles` | Platform user profiles and permissions |
| `crowclaw_workspace_files` | Bot workspace file contents |
| `crowclaw_deployments` | Deployment history and timestamps |
| `crowclaw_skills` | Skills deployed to each bot |
| `crowclaw_safety_events` | Content moderation and safety audit log |
| `crowclaw_bot_messages` | Bot chat messages (with attachments JSON column) |

Schema is defined in `server/init-tables.js` and runs `CREATE TABLE IF NOT EXISTS` on every startup.

## BYOAI Bridge

`server/byoai-bridge.js` generates a bot's `models.json` from Crow's AI profiles stored in `dashboard_settings.ai_profiles`.

### Provider Mapping

The bridge maps base URLs to OpenClaw provider namespaces using `openclawProviderFromBaseUrl()`. Provider keys in `models.json` must match OpenClaw's auth profile names (`zai`, `qwen-portal`, `meta`, etc.) — not arbitrary names. Mismatches cause silent auth failures.

### Vision Detection

`isVisionModel()` is a heuristic (regex patterns for known vision model names). When a vision model is detected, the bridge outputs a provider-qualified `imageModel` (e.g., `zai/glm-4.6v`) and configures `tools.media.models` with the appropriate timeout.

### Path Discovery

Uses `openclaw config file` CLI with `OPENCLAW_CONFIG_PATH` env var to find the bot's state directory. The CLI may return tilde paths — these are expanded before `resolve()`.

### Deploy Trigger

When `deployBot()` runs for a bot with `ai_source: "byoai"`, it calls `generateModelsJson()` which writes the bot's `models.json`. This merges ALL Crow AI profiles into one file.

## Bot Chat

`server/bot-chat.js` provides REST routes for the Messages panel:

| Route | Method | Purpose |
|-------|--------|---------|
| `/bot-chat/:botId/messages` | GET | Fetch message history |
| `/bot-chat/:botId/message` | POST | Send message to bot (polls for response) |
| `/bot-chat/:botId/new-session` | POST | Start a new conversation session |

All routes require `dashboardAuth` middleware.

### Vision Pipeline

When an image is attached to a bot message:

1. Image downloaded from S3 to a temp file
2. Vision model called directly via API (config from `openclaw.json` → `tools.media.models`)
3. API credentials resolved from Crow's AI profiles
4. Text description injected as `[Image N analysis]` context before the user's message
5. Combined message sent to bot via `openclaw agent` CLI
6. Temp files cleaned up after the bot responds

This bypasses the limitation that `openclaw agent` has no `--media` flag and the gateway WebSocket protocol doesn't support inline images with non-vision primary models.

## Panel

The dashboard panel (`panel/crowclaw.js`) serves at `/dashboard/bots`. It renders the bot management UI including:

- Bot list with status indicators
- Create/configure/deploy forms
- Real-time log viewer
- Messages integration for bot chat

The OpenClaw Control UI is proxied through Crow at `/proxy/crowclaw/` with the gateway token auto-injected via URL hash.

## Systemd Integration

Each bot runs as a user-level systemd service (`systemctl --user`). CrowClaw manages the service lifecycle:

- `crow_start_bot` → `systemctl --user start openclaw-gateway.service`
- `crow_stop_bot` → `systemctl --user stop openclaw-gateway.service`
- `crow_bot_logs` → `journalctl --user -u openclaw-gateway.service`

## Related

- [Bot Management Guide](/guide/bot-management) — User-facing guide for bot setup and management
- [Integration Overview](/guide/integration-overview) — How bots fit into Crow's connection patterns
- [OpenClaw Platform Guide](/platforms/openclaw) — OpenClaw setup and configuration
- [Storage Server](/architecture/storage-server) — File storage and attachment handling
