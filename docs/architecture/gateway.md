# Gateway

The gateway (`servers/gateway/`) is an Express server that makes Crow's MCP servers accessible over HTTP with OAuth 2.1 authentication.

## Modular Route Structure

The gateway uses a modular route architecture. Core MCP transport logic is in `routes/mcp.js`, which exports the `mountMcpServer()` helper. Other route modules handle specific concerns:

| Module | Purpose |
|---|---|
| `routes/mcp.js` | `mountMcpServer()` — mounts Streamable HTTP + SSE transports for any MCP server |
| `routes/storage-http.js` | File upload (multipart) and download (presigned redirect) HTTP routes |
| `routes/blog-public.js` | Public blog pages, tag pages, RSS and Atom feeds (no auth) |
| `dashboard/` | Crow's Nest UI panels and auth system |
| `session-manager.js` | Consolidated session storage for all MCP servers (replaces per-server Maps) |

## Transports

### mountMcpServer() Helper

All MCP servers are mounted via the `mountMcpServer(router, prefix, createServer, sessionManager, authMiddleware)` function from `routes/mcp.js`. It registers both Streamable HTTP and SSE endpoints for a given server factory, using the consolidated `SessionManager` for session tracking.

### Streamable HTTP (Primary)

Modern MCP transport used by most clients.

| Endpoint | Server |
|---|---|
| `POST\|GET\|DELETE /memory/mcp` | crow-memory |
| `POST\|GET\|DELETE /projects/mcp` | crow-projects |
| `POST\|GET\|DELETE /research/mcp` | crow-projects (legacy alias) |
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
| `GET /projects/sse` | Open SSE stream |
| `POST /projects/messages` | Send messages |
| `GET /research/sse` | Open SSE stream (legacy alias) |
| `POST /research/messages` | Send messages (legacy alias) |
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

Run without auth for local development only:
```bash
node servers/gateway/index.js --no-auth
```

> **Safety guard:** The gateway refuses to start with `--no-auth` if `CROW_GATEWAY_URL` contains a public domain (e.g., `.ts.net`, `.onrender.com`, `.fly.dev`). This prevents accidental exposure of unauthenticated MCP endpoints via Tailscale Funnel or cloud hosting.

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

- **Never use `--no-auth` in production** — it disables all authentication. The gateway refuses `--no-auth` when `NODE_ENV=production` or when `CROW_GATEWAY_URL` contains a public domain
- **Always deploy behind HTTPS** — Render and Railway provide this automatically. If self-hosting, use a reverse proxy (nginx, Caddy) with TLS, or Tailscale Funnel
- The **`/setup` page** is unauthenticated by design — it only shows a password form (no secrets). Gate it with `CROW_SETUP_TOKEN` for hosted instances
- **`/api/health`** is protected by dashboard session auth — it exposes system metrics (RAM, disk, CPU). The public **`/health`** endpoint returns only server status (no system info)
- **OAuth tokens** are stored in the SQLite database and persist across restarts
- **Rate limiting** is built in — 200 requests per 15 minutes (general) and 20 requests per 15 minutes (auth endpoints: `/authorize`, `/token`, `/register`). For high-traffic deployments, add additional rate limiting via your reverse proxy or hosting provider
- **Content Security Policy** restricts resource loading — allows Google Fonts (dashboard), same-origin scripts, and podcast media sources
- The **`/crow.md` endpoint** is protected by OAuth when auth is enabled, since it exposes behavioral context

For the full public/private access model, see the [Security Guide](https://github.com/kh0pper/crow/blob/main/SECURITY.md#whats-public-by-default).

## Router Mode

The `/router/mcp` endpoint exposes 7 consolidated category tools instead of the full 49+ tools from all servers. This reduces context window usage by approximately 75%.

Each category tool (`crow_memory`, `crow_projects`, `crow_sharing`, `crow_storage`, `crow_blog`, `crow_tools`, `crow_discover`) dispatches to the underlying server via an in-process MCP Client. The `crow_discover` tool returns full schemas on demand, so clients can inspect available actions without loading all tool definitions upfront. The `crow_research` name is accepted as a backward-compatible alias for `crow_projects`.

Router mode is backward compatible — existing per-server endpoints (`/memory/mcp`, `/research/mcp`, etc.) remain unchanged and continue to work as before. The router is an additional endpoint, not a replacement.

To disable router mode, set the environment variable `CROW_DISABLE_ROUTER=1`.

For the full reference, see [Context Management](/architecture/context-management).

## Chat API

The gateway includes a built-in AI Chat system (`/api/chat/*`) that turns Crow into an AI client. This powers the BYOAI Chat feature in the Crow's Nest. All chat routes are protected by dashboard session auth (cookie-based).

### Routes

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/chat/conversations` | Create a new conversation |
| `GET` | `/api/chat/conversations` | List conversations (paginated) |
| `GET` | `/api/chat/conversations/:id` | Get conversation with all messages |
| `DELETE` | `/api/chat/conversations/:id` | Delete conversation (cascades to messages) |
| `POST` | `/api/chat/conversations/:id/messages` | Send message, receive SSE stream |
| `POST` | `/api/chat/conversations/:id/cancel` | Cancel in-progress generation |
| `GET` | `/api/chat/providers` | List available providers and current config |
| `POST` | `/api/chat/providers/test` | Test provider connection |

### Provider Adapter Pattern

The AI provider layer (`ai/provider.js`) uses a registry of lazy-loaded adapters:

| Provider | Adapter | API Format |
|---|---|---|
| `openai` | `ai/adapters/openai.js` | OpenAI Chat Completions (also OpenRouter, vLLM, LM Studio) |
| `anthropic` | `ai/adapters/anthropic.js` | Anthropic Messages API |
| `google` | `ai/adapters/google.js` | Google Gemini REST API |
| `ollama` | `ai/adapters/ollama.js` | Ollama native `/api/chat` |

Each adapter implements a `chatStream(messages, tools, options)` method that returns an async iterator yielding events: `content_delta` (text chunks), `tool_call` (function calls), and `done` (usage stats). Provider config is hot-reloaded from `.env` with a 5-second cache.

### Tool Executor Pattern

When the AI responds with tool calls, the tool executor (`ai/tool-executor.js`) dispatches them to Crow's MCP servers:

1. The executor maintains a pool of lazy in-process MCP Clients, one per server category
2. Each client connects to its server factory via `InMemoryTransport` (same pattern as the tool router)
3. Tool calls are resolved by category — `crow_memory` routes to the memory server, `crow_projects` to the project server, etc.
4. The AI sees the 7 category tools from the router pattern, plus `crow_discover` for schema lookup
5. Results are truncated to 2000 characters to prevent context overflow
6. Up to 10 tool call rounds per message turn (the AI can call tools, get results, and call more tools)

```
User Message
  → AI Provider API (streaming)
    → content_delta events → SSE to browser
    → tool_call events → Tool Executor
      → InMemoryTransport → MCP Server → Database
      → result → back to AI for next round
  → done event → SSE to browser
```

Tool results and assistant messages are persisted to `chat_messages` with token counts. Conversations track total tokens for usage monitoring.

### Rate Limiting

Chat messages are rate-limited to 10 messages per minute per session (separate from the gateway's general rate limiter). Active generations can be cancelled via the cancel endpoint or by the client disconnecting.

## Health Check

`GET /health` returns JSON status:

```json
{
  "status": "ok",
  "servers": ["crow-memory", "crow-projects", "crow-sharing", "crow-storage", "crow-blog"],
  "externalServers": [{"id": "github", "name": "GitHub", "tools": 15}]
}
```

System resource metrics (RAM, disk, CPU) are available at `GET /api/health`, protected by dashboard session auth.

## Federation

The gateway can proxy tool calls to remote Crow instances via HTTP. When an instance is registered in the `crow_instances` table with a `gateway_url`, the proxy layer connects using the MCP SDK's `StreamableHTTPClientTransport` and makes remote tools available through the `crow_tools` router action with an `instance_id` parameter. See [Multi-Instance Architecture](./instances) for sync, conflict resolution, and security details.
