# Gateway

The gateway (`servers/gateway/`) is an Express server that makes Crow's MCP servers accessible over HTTP with OAuth 2.1 authentication.

## Modular Route Structure

The gateway uses a modular route architecture. Core MCP transport logic is in `routes/mcp.js`, which exports the `mountMcpServer()` helper. Other route modules handle specific concerns:

| Module | Purpose |
|---|---|
| `routes/mcp.js` | `mountMcpServer()` — mounts Streamable HTTP + SSE transports for any MCP server |
| `routes/storage-http.js` | File upload (multipart) and download (presigned redirect) HTTP routes |
| `routes/blog-public.js` | Public blog pages, tag pages, RSS and Atom feeds (no auth) |
| `dashboard/` | Dashboard UI panels and auth system |
| `session-manager.js` | Consolidated session storage for all MCP servers (replaces per-server Maps) |

## Transports

### mountMcpServer() Helper

All MCP servers are mounted via the `mountMcpServer(router, prefix, createServer, sessionManager, authMiddleware)` function from `routes/mcp.js`. It registers both Streamable HTTP and SSE endpoints for a given server factory, using the consolidated `SessionManager` for session tracking.

### Streamable HTTP (Primary)

Modern MCP transport used by most clients.

| Endpoint | Server |
|---|---|
| `POST\|GET\|DELETE /memory/mcp` | crow-memory |
| `POST\|GET\|DELETE /research/mcp` | crow-research |
| `POST\|GET\|DELETE /sharing/mcp` | crow-sharing |
| `POST\|GET\|DELETE /storage/mcp` | crow-storage (conditional, requires MinIO) |
| `POST\|GET\|DELETE /blog-mcp/mcp` | crow-blog |
| `POST\|GET\|DELETE /tools/mcp` | External tool proxy |
| `POST\|GET\|DELETE /mcp` | crow-memory (compatibility alias) |

Sessions are managed via the `mcp-session-id` header. New sessions are created on `initialize` requests. Each transport gets an in-memory `EventStore` for resumability.

### SSE (Legacy)

Legacy transport for ChatGPT and older clients.

| Endpoint | Purpose |
|---|---|
| `GET /memory/sse` | Open SSE stream + create session |
| `POST /memory/messages` | Send messages to session |
| `GET /research/sse` | Open SSE stream |
| `POST /research/messages` | Send messages |
| `GET /sharing/sse` | Open SSE stream |
| `POST /sharing/messages` | Send messages |
| `GET /storage/sse` | Open SSE stream (conditional) |
| `POST /storage/messages` | Send messages (conditional) |
| `GET /blog-mcp/sse` | Open SSE stream |
| `POST /blog-mcp/messages` | Send messages |
| `GET /tools/sse` | Open SSE stream |
| `POST /tools/messages` | Send messages |

Sessions are identified by `sessionId` query parameter on message endpoints.

## OAuth 2.1

The gateway implements OAuth 2.1 with Dynamic Client Registration:

| Route | Purpose |
|---|---|
| `GET /.well-known/oauth-authorization-server` | OAuth metadata discovery |
| `GET /.well-known/oauth-protected-resource` | Protected resource metadata |
| `POST /register` | Dynamic client registration |
| `GET /authorize` | Authorization endpoint |
| `POST /token` | Token endpoint |
| `POST /introspect` | Token introspection |

OAuth is backed by SQLite tables (`oauth_clients`, `oauth_tokens`) for persistence across restarts.

Run without auth for development:
```bash
node servers/gateway/index.js --no-auth
```

## Integration Proxy

The proxy system (`proxy.js` + `integrations.js`) aggregates external MCP servers into the `/tools/mcp` endpoint:

1. On startup, reads which API keys are present in environment variables
2. For each configured integration, spawns the MCP server as a child process
3. Connects via stdio transport and discovers available tools
4. Prefixes tool names with the integration ID (e.g., `github_create_issue`)
5. Exposes all tools through a single MCP endpoint

### Adding a New Integration

Edit `servers/gateway/integrations.js`:

```js
{
  id: "my-service",
  name: "My Service",
  description: "What it does",
  command: "npx",
  args: ["-y", "mcp-server-my-service"],
  envVars: ["MY_SERVICE_API_KEY"],
  keyUrl: "https://example.com/api-keys",
  keyInstructions: "How to get the key.",
}
```

## Setup Page

`GET /setup` serves a mobile-friendly HTML page showing:

- Connected integrations (green) with tool counts
- Available integrations (gray) with setup links
- MCP endpoint URLs for all supported transports
- Quick setup instructions for each AI platform

No authentication required — doesn't expose secrets.

## Security Considerations

- **Never use `--no-auth` in production** — it disables all authentication. The gateway will refuse to start with `--no-auth` when `NODE_ENV=production`
- **Always deploy behind HTTPS** — Render and Railway provide this automatically. If self-hosting, use a reverse proxy (nginx, Caddy) with TLS
- The **`/setup` page** is unauthenticated by design — it shows which integrations are connected and endpoint URLs, but never exposes API keys or secrets
- **OAuth tokens** are stored in the SQLite database and persist across restarts
- **Rate limiting** is not built into the gateway — rely on your hosting provider or a reverse proxy for rate limiting in production
- The **`/crow.md` endpoint** is protected by OAuth when auth is enabled, since it exposes behavioral context

## Health Check

`GET /health` returns JSON status:

```json
{
  "status": "ok",
  "servers": ["crow-memory", "crow-research", "crow-sharing", "crow-storage", "crow-blog"],
  "externalServers": [{"id": "github", "name": "GitHub", "tools": 15}],
  "auth": true
}
```
