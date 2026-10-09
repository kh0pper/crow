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

All rules live in `servers/shared/sqlite-datasets.js`, shared by the bundle, the GIS bundle and the public blog embed API.

### Read-only connections

A dataset is opened with better-sqlite3 `readonly` plus `PRAGMA query_only`, so SQLite itself refuses any write (including `PRAGMA` assignments and `WITH … DELETE`). The statement must be a single statement, read-only by SQLite's own account (`stmt.readonly`) and return rows; a first-keyword allowlist (`SELECT`, `WITH`, `EXPLAIN`, `PRAGMA`, `VALUES`) stays as defence in depth, which also refuses `ATTACH`.

### Path restrictions

The realpath of a dataset must sit under the instance data dir's `datasets/` or `projects/<id>/databases/` (compared segment by segment, not as a string prefix). Core databases — `crow.db`, `tasks.db`, `CROW_DB_PATH`, any `*.db` directly in the data dir — are refused by realpath and by device and inode, so links do not get around it.

### Row, size and time caps

Rows are read by stepping the statement and stop at the cap (5,000 rows, 8 MB serialized), whatever the SQL text says. Each query and schema read runs in a short-lived child process that is killed at its time limit (10 s); at most four run at once, and further queries are refused as busy. The child caps its V8 heap and SQLite's heap (`PRAGMA hard_heap_limit`, 128 MB), so one huge value fails there. Caller-supplied limits can only lower the caps.

The file is opened with `O_NOFOLLOW` while SQLite opens it, and the path must still resolve to the same inode afterwards.

### No write path

`crow_data_write` is disabled. The GIS batch geocoder is the only writer, and only for databases the dashboard created (`projects/<id>/databases/`), with quoted identifiers.

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
