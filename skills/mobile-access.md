# Mobile Access Skill

## Description
Guides setup and troubleshooting of remote access to Crow's memory and research tools from Claude mobile apps (Android/iOS) and Claude.ai web interface via MCP Connectors.

## When to Use
- User wants to access Crow tools from their phone
- Setting up remote/cloud deployment of Crow servers
- Troubleshooting connector issues or OAuth authentication
- User asks about using Crow outside of their desktop

## Architecture

```
Claude Mobile App / claude.ai
        │
        ▼ (HTTPS + OAuth 2.1)
  Crow Gateway (servers/gateway/index.js)
   ├── /memory/mcp   → crow-memory (Streamable HTTP)
   ├── /projects/mcp  → crow-projects (Streamable HTTP)
   ├── /health         → health check
   └── OAuth routes    → Dynamic Client Registration
        │
        ▼
  SQLite Database (data/crow.db)
```

## Deployment Options

### Option 1: Oracle Cloud Free Tier (Recommended)
- Free VM that never sleeps, local SQLite, no external DB needed
- Set up Tailscale for private access, or Caddy for public HTTPS
- Add as connector: `https://your-crow-server/memory/mcp` and `https://your-crow-server/projects/mcp`

### Option 2: Self-Hosted Docker
- `docker compose --profile cloud up --build` for VPS deployment
- `docker compose --profile local up --build` for home network + tunnel
- Requires HTTPS reverse proxy (Caddy, nginx) or Cloudflare Tunnel

## Connector Setup (claude.ai)

1. Go to claude.ai → Settings → Connectors
2. Click "Add Custom Connector"
3. Enter the gateway URL + `/memory/mcp`
4. Complete OAuth authorization
5. Repeat for `/research/mcp` if desired
6. Connectors auto-sync to Claude mobile apps

## Troubleshooting

### "Connection refused" or timeout
- Verify the gateway is running: `curl https://your-url/health`
- Check the server logs for errors
- Ensure port 3001 is exposed and accessible

### OAuth errors
- Tokens stored in `data/crow.db` (oauth_tokens table)
- Tokens expire after 24 hours; refresh tokens last 30 days
- If stuck: clear browser cookies for the gateway URL and re-authorize

### "Session not found" errors
- Sessions are stored in memory and don't survive server restarts
- After restarting the gateway, clients reconnect automatically
- If persistent: check that the `Mcp-Session-Id` header is being forwarded

## Best Practices
- Use cloud deployment for reliable mobile access
- Keep the gateway URL in `.env` as `CROW_GATEWAY_URL` for reference
- Memory stored on mobile is the same database as desktop (shared SQLite)
- Test with `/health` endpoint before adding as connector
