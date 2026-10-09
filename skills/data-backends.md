# Data Backends — Knowledge Capture Workflow

## Description
Guides connecting external data systems (Postgres, APIs, SaaS) through MCP servers and capturing query results into Crow's knowledge graph.

## When to Activate
- User wants to connect to a database, API, or external data system
- User asks to register or manage data backends
- User queries an external backend and results should be captured as sources

## Registration Workflow

There are two kinds of backend (`backend_type`):

- **`mcp_server`** (default) — an external MCP server Crow starts as a command. `connection_ref`: `{"command":"npx","args":["-y","mcp-server-postgres"],"envVars":["POSTGRES_URL"]}`.
- **`sqlite`** — a SQLite dataset Crow reads read-only. `connection_ref`: `{"path":"<absolute path>"}`; the file must be in the data folder's `datasets/` or a project's `databases/` folder, never one of Crow's own databases.

1. **Ask what they want to connect**
   - For `mcp_server`: the MCP server package and the credential env var NAMES (never values)
   - For `sqlite`: where the file is (it must be moved into `datasets/` first if it is elsewhere)

2. **Register the backend**
   ```
   crow_register_backend
     name: "Production Postgres"
     connection_ref: '{"command":"npx","args":["-y","mcp-server-postgres"],"envVars":["POSTGRES_URL"]}'
   ```
   This auto-creates a `data_connector` project if no `project_id` is given.

3. **Tell the user an `mcp_server` backend needs their approval**
   - It is registered as *pending approval* and does not run until the owner approves the exact command in Crow's Nest › Projects › the project › Data Backends
   - You cannot approve it; never claim it is running before the user has approved it
   - It gets only basic environment variables plus the ones named in `envVars` — never the gateway's secrets. Approval also pins the files it runs (launcher, script arguments); editing one needs a new approval
   - The user adds the credential values to `.env`

4. **Verify connection**
   - Use `crow_list_backends` to check status (`pending_approval` → waiting for the user)
   - Use `crow_backend_schema` to see discovered tools once it is connected

## Knowledge Capture Protocol

When querying data through an external backend:

1. **Before querying**: Show transparency checkpoint
   *[crow checkpoint: Querying backend "Production Postgres" via crow_tools. Significant results will be offered for capture. Say "no capture" to skip.]*

2. **After receiving results**: Evaluate significance
   - Is this a dataset, report, or analytical finding worth preserving?
   - Would the user benefit from having this in their knowledge graph?

3. **If significant**: Offer to capture
   *[crow: Query returned 47 rows. Would you like me to capture a summary as a source linked to this backend?]*

4. **Capture as source** (with user consent):
   ```
   crow_add_source
     title: "Q1 Revenue by Region"
     source_type: "dataset"
     project_id: <backend's project>
     backend_id: <backend id>
     content_summary: <summary of results>
     retrieval_method: "SQL query via mcp-server-postgres"
   ```

5. **Add analytical notes** for insights:
   ```
   crow_add_note
     content: "Revenue growth strongest in APAC region (+23% YoY)"
     note_type: "analysis"
     project_id: <backend's project>
   ```

## Best Practices

- **Never auto-capture** without user consent — always show the checkpoint first
- **Summarize, don't dump** — capture analytical summaries, not raw query results
- **Track provenance** — always set `backend_id` on captured sources
- **Use appropriate source types**: `dataset` for query results, `api_data` for API responses
- **Tag consistently** — use the backend name as a tag for easy filtering

## Security Reminders

- Credentials live in `.env` only — never in the database
- `connection_ref` stores env var **names** (e.g., `"envVars": ["POSTGRES_URL"]"`), not values
- Backend registrations are never copied from peers; a shared project carries only a description
- Registering a command never runs it — only the owner's approval in Crow's Nest does
