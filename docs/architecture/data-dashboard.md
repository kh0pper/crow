---
title: Data Dashboard Architecture
description: Technical architecture of the Data Dashboard bundle — query engine, MCP tools, panel structure, and blog publishing pipeline.
---

# Data Dashboard Architecture

The Data Dashboard is an add-on bundle that provides database exploration, SQL querying, charting, and case study publishing. This page covers the internal architecture.

For usage instructions, see the [Data Dashboard Guide](../guide/data-dashboard).

## Bundle Structure

```
bundles/data-dashboard/
  manifest.json           — Add-on metadata, dependencies, panel/skill declarations
  docker-compose.yml      — No containers required (runs in-process)
  server.js               — createDataDashboardServer() factory → McpServer
  index.js                — stdio transport entry point
  panel/
    data-dashboard.js     — Nest panel: 4-tab UI (schema, editor, charts, case studies)
    chart-renderer.js     — Server-side Chart.js rendering
  skills/
    data-exploration.md   — AI workflow for exploring and querying databases
    case-study.md         — AI workflow for building case studies
```

The bundle registers:
- An MCP server with 10 tools
- A Crow's Nest panel with 4 tabs
- Two skill files for AI-guided workflows

## Query Engine

The query engine executes SQL against registered [data backends](../guide/data-backends). It enforces safety at multiple levels.

### First-Token Validation

Before executing any query, the engine extracts the first SQL token and checks it against an allowlist:

```
Allowed (read-only mode): SELECT, WITH, EXPLAIN, PRAGMA
Allowed (write mode):     SELECT, WITH, EXPLAIN, PRAGMA, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP
```

Queries starting with any other token are rejected. This catches `ATTACH`, `DETACH`, `.import`, and other potentially dangerous operations.

### Path Restrictions

For SQLite backends, the database file path must be within an allowed directory:

- `~/.crow/data/`
- Any path explicitly registered via `crow_register_backend`
- Bundle-specific data directories (`~/.crow/bundles/*/data/`)

Symlinks are resolved before checking. Paths outside the allowlist are rejected.

### Timeouts

Every query runs with a 30-second timeout. The timeout is enforced at the database driver level — the connection is interrupted if the query exceeds the limit. This prevents accidental `SELECT *` on million-row tables from locking the system.

### Write Mode

Write mode is disabled by default. Users can enable it per-database through the Nest settings panel or by asking the AI:

```
"Enable write access on my analytics database"
```

Write mode requires explicit confirmation. The AI will warn before enabling it and confirm the specific database.

## MCP Tools

The Data Dashboard server exposes 10 tools:

| Tool | Description |
|---|---|
| `crow_list_databases` | List all registered data backends with schema summaries |
| `crow_explore_schema` | Get tables, columns, types, and relationships for a database |
| `crow_run_query` | Execute a SQL query and return results |
| `crow_save_query` | Save a query with name and description |
| `crow_list_saved_queries` | List saved queries, optionally filtered by database |
| `crow_delete_saved_query` | Delete a saved query |
| `crow_create_chart` | Create a chart configuration from query results |
| `crow_create_case_study` | Create a new case study |
| `crow_update_case_study` | Add/remove/reorder sections in a case study |
| `crow_publish_case_study` | Convert a case study to a blog post |

All tools follow the standard Crow server factory pattern — `createDataDashboardServer(dbPath?, options?)` returns an `McpServer` instance.

## Case Study to Blog Pipeline

Publishing a case study converts it into a Crow blog post:

1. **Gather sections** — Query the case study's sections (narrative, queries, charts) in order
2. **Execute queries** — Re-run each query section to get fresh results
3. **Render charts** — Generate chart images server-side using Chart.js (Node canvas)
4. **Compose Markdown** — Assemble narrative text, result tables (as Markdown tables), and chart images (as inline base64 or uploaded to storage)
5. **Create blog post** — Call `crow_create_post` with the composed Markdown, tagged with `case-study`
6. **Publish** — Optionally call `crow_publish_post` to make it public immediately

The original case study is preserved. Republishing regenerates the blog post with updated data.

## Panel Architecture

The Nest panel follows the standard [panel pattern](../developers/creating-panels). It registers four tabs as sub-routes:

- `/dashboard/data-dashboard` — Schema Explorer (default)
- `/dashboard/data-dashboard?tab=editor` — SQL Editor
- `/dashboard/data-dashboard?tab=charts` — Charts
- `/dashboard/data-dashboard?tab=cases` — Case Studies

Charts are rendered client-side using Chart.js loaded from CDN. The editor uses a `<textarea>` with basic syntax highlighting via CSS — no heavy editor dependency.

## Next Steps

- [Data Dashboard Guide](../guide/data-dashboard) — User-facing documentation
- [Extending the Dashboard](../developers/data-dashboard) — Add chart types and exporters
- [Creating Panels](../developers/creating-panels) — General panel development guide
