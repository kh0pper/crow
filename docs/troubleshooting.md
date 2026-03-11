# Troubleshooting

Common issues and solutions when setting up or using Crow.

## Gateway Issues

### Gateway won't start

| Symptom | Cause | Fix |
|---|---|---|
| `TURSO_DATABASE_URL not set` | Missing database config (Render cloud deploys only) | Only needed for Render cloud deploys. Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. For local/Docker/Pi setups, this error shouldn't appear — Crow uses local SQLite automatically. |
| `Port already in use` | Another process on port 3001 | Set `PORT` env var to a different port |
| `Module not found` | Dependencies not installed | Run `npm install` in the project root |

### Health check fails

Visit `https://your-gateway.onrender.com/health` — if it returns JSON with `"status": "ok"`, the gateway is running. If not:

- Check Render logs for startup errors
- Verify environment variables are set correctly
- Ensure the database is accessible

### OAuth flow fails

| Symptom | Fix |
|---|---|
| Redirect URI mismatch | Ensure `CROW_GATEWAY_URL` matches your actual public URL |
| Token expired | Re-authorize the connection from your AI client |
| Client not registered | The client should auto-register — check gateway logs for registration errors |

## Integration Issues

### External tools not appearing

1. Visit `/setup` to check which integrations are connected
2. Verify the API key is set in your environment variables
3. Check Render logs for connection errors from the proxy
4. The proxy only starts integrations with valid API keys

### Tool call errors

| Error | Cause | Fix |
|---|---|---|
| `401 Unauthorized` | Invalid or expired API key | Update the API key in environment variables |
| `403 Forbidden` | Insufficient permissions | Check the API key's scope/permissions |
| `Tool not found` | Integration not connected | Check `/setup` page, ensure API key is set |

## Database Issues

### Tables not created

Run `npm run init-db` to initialize the database schema. For cloud deployments, run this via the Render shell.

### FTS search not working

The FTS5 virtual tables and sync triggers are created by `init-db`. If search returns no results:

1. Check that the FTS tables exist: `memories_fts`, `sources_fts`
2. Run `npm run init-db` to recreate them
3. Note: Existing data will need to be re-indexed

## Platform-Specific Issues

### Claude: "Integration not responding"

- Check gateway health endpoint
- Render free tier services spin down after inactivity — the first request may take 30-60 seconds
- Verify the URL in Claude settings matches your gateway URL exactly

### ChatGPT: Connection fails

- ChatGPT uses **SSE** transport — make sure you're using the `/sse` endpoint, not `/mcp`
- Example: `https://your-gateway.onrender.com/memory/sse`

### Cursor/Windsurf/Cline: MCP server offline

- For local stdio: ensure `node` is in PATH and the server path is absolute
- For remote HTTP: ensure the gateway URL is correct and accessible
- Check the IDE's output/log panel for MCP-related errors

## Context & Performance Issues

| Symptom | Cause | Fix |
|---|---|---|
| Responses seem slow or low quality | Too many tools loaded, consuming context window | Check tool count via `/health`. Switch to the `/router/mcp` endpoint or `crow-core` to consolidate tools. |
| Too many tools loaded | Each server exposes its full tool set | Use `/router/mcp` (gateway) or `crow-core` (stdio) to reduce from 49+ tools to 7 category tools. See the [Context & Performance guide](/guide/context-performance). |
| Tool not found in router mode | The router uses category tools that dispatch to underlying servers | Use `crow_discover` to check available actions within a category. The tool may be accessible via a different category name. |

## Still Stuck?

If you're spending more time on infrastructure than on your actual work, consider [managed hosting](./getting-started/managed-hosting) — a pre-configured Crow instance with zero setup for $15/mo.

## Getting Help

- Check the [GitHub Issues](https://github.com/kh0pper/crow/issues) for known problems
- Open a new issue with your gateway logs and the error message
- Include which platform and transport you're using
