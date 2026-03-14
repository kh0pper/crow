---
name: openclaw
description: Manage your OpenClaw bot gateway — start, stop, configure chat platforms, check status
triggers:
  - openclaw
  - bot gateway
  - discord bot
  - telegram bot
  - chat bot
  - bot status
tools:
  - crow-memory
---

# OpenClaw Integration

## When to Activate

- User asks about OpenClaw, their bot, or bot status
- User wants to configure a chat platform (Discord, Telegram, WhatsApp, etc.)
- User wants to start, stop, or restart the OpenClaw gateway
- User asks about connecting Crow to OpenClaw

## How It Works

OpenClaw is an open-source personal AI assistant that runs locally and connects to messaging platforms (Discord, Telegram, WhatsApp, Slack, Signal, iMessage, and others). It acts as a conversational front-end while Crow provides persistent memory, project management, and structured tools via MCP.

**Gateway port:** 18789 (default)
**Config file:** `~/.openclaw/openclaw.json`
**Control UI:** `http://localhost:18789` (protected by gateway token)

## Workflow 1: Check Bot Status

Verify that the OpenClaw gateway is running and connected:

1. Check if the container is running:
   ```bash
   docker compose -f ~/.crow/bundles/openclaw/docker-compose.yml ps
   ```
2. Check gateway health:
   ```bash
   curl -s http://localhost:18789/health
   ```
3. Report which chat platforms are connected

## Workflow 2: Start / Stop / Restart

```bash
# Start
docker compose -f ~/.crow/bundles/openclaw/docker-compose.yml up -d

# Stop
docker compose -f ~/.crow/bundles/openclaw/docker-compose.yml down

# Restart
docker compose -f ~/.crow/bundles/openclaw/docker-compose.yml restart

# View logs
docker compose -f ~/.crow/bundles/openclaw/docker-compose.yml logs -f --tail=50
```

## Workflow 3: Configure a Chat Platform

### Discord

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) and create a new application
2. Under **Bot**, click **Reset Token** to get the bot token
3. Enable **Message Content Intent** under Privileged Gateway Intents
4. Add bot to your server with the OAuth2 URL (Bot scope + Send Messages permission)
5. Set these env vars:
   - `OPENCLAW_DISCORD_TOKEN` — the bot token
   - `OPENCLAW_DISCORD_SERVER_ID` — your server (guild) ID
   - `OPENCLAW_DISCORD_USER_ID` — your Discord user ID
6. Restart the OpenClaw container

### Telegram

1. Message [@BotFather](https://t.me/BotFather) on Telegram and create a new bot
2. Copy the bot token
3. Set `OPENCLAW_TELEGRAM_TOKEN` in your .env
4. Restart the OpenClaw container
5. DM your bot on Telegram to pair

## Workflow 4: Connect Crow to OpenClaw

Two options depending on deployment:

### Option A: HTTP (remote or Docker)

Set `CROW_GATEWAY_URL` in the OpenClaw env to point at the Crow gateway (e.g., `http://host.docker.internal:3001` when both run on the same Docker host). OpenClaw connects to Crow's MCP endpoints over HTTP with OAuth 2.1.

### Option B: stdio (local, same machine)

Mount the Crow installation into the container and add MCP server entries to `openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "crow-memory": {
        "command": "node",
        "args": ["/crow/servers/memory/index.js"]
      },
      "crow-projects": {
        "command": "node",
        "args": ["/crow/servers/research/index.js"]
      }
    }
  }
}
```

## Workflow 5: View OpenClaw Logs

When diagnosing issues:

```bash
# Last 100 lines
docker compose -f ~/.crow/bundles/openclaw/docker-compose.yml logs --tail=100

# Follow live
docker compose -f ~/.crow/bundles/openclaw/docker-compose.yml logs -f
```

Common issues:
- **Exit code 137**: Out of memory. Increase `mem_limit` in docker-compose.yml.
- **Connection refused on chat platform**: Token is wrong or platform-specific setup is incomplete.
- **MCP tools not available**: Check that Crow gateway is running and `CROW_GATEWAY_URL` is reachable from the container.

## Tips

- OpenClaw hot-reloads `openclaw.json` — most config changes take effect without restarting
- The Control UI at port 18789 lets you manage agents, view conversations, and test tools
- Store OpenClaw configuration preferences (preferred model, active platforms) in Crow memory
- For Raspberry Pi / ARM64: OpenClaw works on ARM but building from source takes longer
- Use `OPENCLAW_VERSION` env var to pin to a specific release tag instead of `main`

## Error Handling

- If gateway is unreachable: "OpenClaw doesn't seem to be running. Start it with `docker compose up -d` in the openclaw bundle directory."
- If a chat platform disconnects: "Check the bot token and platform configuration. View logs with `docker compose logs` for details."
- If Crow tools are missing: "Verify CROW_GATEWAY_URL is set correctly and the Crow gateway is running on port 3001."
