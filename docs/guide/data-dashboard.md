---
title: Data Dashboard
description: Explore databases, run queries, build charts, and publish case studies — all from the Crow's Nest.
---

# Data Dashboard

The Data Dashboard is an add-on bundle that turns Crow into a lightweight data exploration platform. Browse database schemas, write SQL queries, visualize results with charts, and publish findings as blog posts.

## Overview

Install the Data Dashboard bundle to get a new panel in the Crow's Nest with four tabs:

| Tab | Purpose |
|---|---|
| **Schema Explorer** | Browse tables, columns, types, and relationships across connected databases |
| **SQL Editor** | Write and run queries with syntax highlighting and result tables |
| **Charts** | Build visualizations from query results (bar, line, pie, scatter) |
| **Case Studies** | Combine queries, charts, and narrative into publishable case studies |

## Getting Started

Install the bundle:

```
"Install the data dashboard"
```

Or via CLI:

```bash
crow bundle install data-dashboard
crow bundle start data-dashboard
```

The Data Dashboard panel appears in the Nest sidebar after installation.

## Schema Explorer

The Schema Explorer shows every database registered as a [data backend](./data-backends). Select a database from the dropdown to see its tables, columns, data types, and foreign key relationships.

Use it to understand unfamiliar datasets before writing queries. The explorer reads schema metadata only — it never touches your data.

## SQL Editor

Write SQL queries against any registered database. Features:

- **Syntax highlighting** and basic autocompletion
- **Result table** with sortable columns and row counts
- **Save queries** with a name and description for reuse
- **Export** results as CSV or JSON

```sql
SELECT county, COUNT(*) as filings
FROM tax_returns
WHERE year = 2025
GROUP BY county
ORDER BY filings DESC
LIMIT 20;
```

Run the query with the Execute button or `Ctrl+Enter`.

### Saved Queries

Saved queries persist in the Crow database. Access them from the SQL Editor's sidebar. Each saved query records:

- Name and description
- The SQL text
- Which database it targets
- When it was last run

## Charts

Select a saved query or run an ad-hoc query, then switch to the Charts tab to visualize the results.

Supported chart types:

- **Bar** — Compare categories (e.g., filings by county)
- **Line** — Show trends over time (e.g., monthly submissions)
- **Pie** — Show proportions (e.g., credit type distribution)
- **Scatter** — Explore relationships between two numeric columns

Charts are rendered with Chart.js. Configure axis labels, colors, and titles in the chart editor. Save charts alongside their source queries.

## Case Studies

A case study combines multiple queries, charts, and written analysis into a single document. Use case studies to tell a data story.

### Creating a Case Study

1. Run your queries and build your charts
2. Open the Case Studies tab and click **New Case Study**
3. Add sections — each section can be narrative text (Markdown), a saved query with its result table, or a chart
4. Arrange sections by dragging them into order
5. Preview the rendered case study

### Publishing to Blog

Case studies can be published directly to your Crow blog:

```
"Publish my tax analysis case study to the blog"
```

The AI converts the case study into a blog post, embedding charts as images and query results as formatted tables. The original case study remains editable — republish after updates.

## Safety Model

The Data Dashboard enforces strict safety boundaries:

- **Read-only by default** — Only `SELECT` queries are allowed. `INSERT`, `UPDATE`, `DELETE`, and DDL statements are blocked unless you explicitly enable write mode for a specific database.
- **Path restrictions** — SQLite databases must be within allowed directories (`~/.crow/data/`, registered backend paths). No access to system databases or files outside the sandbox.
- **Query timeouts** — Queries are killed after 30 seconds to prevent runaway operations.
- **No remote execution** — Queries run locally against registered backends. Federation queries go through the gateway proxy with the same safety checks on the remote side.

## Next Steps

- [Data Backends](./data-backends) — Register external databases
- [Data Sharing](./data-sharing) — Share databases with other Crow users
- [Data Dashboard Architecture](../architecture/data-dashboard) — Technical deep dive
- [Extending the Dashboard](../developers/data-dashboard) — Add chart types and exporters
