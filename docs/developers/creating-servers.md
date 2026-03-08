---
title: Creating MCP Servers
---

# Creating MCP Servers

Add a new MCP server to the Crow platform, following the same patterns used by the built-in memory, research, sharing, storage, and blog servers.

## What is this?

An MCP server exposes tools that AI assistants can call. Crow's built-in servers handle memory, research, sharing, storage, and blogging. You can add your own server for any domain — task management, analytics, home automation, or anything else.

## Why would I want this?

- **Custom tools** — Give your AI new capabilities tailored to your workflow
- **Consistent architecture** — Follow the same factory pattern so your server works with both stdio and HTTP transports
- **Database access** — Use the shared SQLite/Turso database for persistence
- **Community sharing** — Publish your server as an add-on for other Crow users

## The Factory Pattern

Every Crow MCP server follows the same structure:

```
servers/your-server/
  server.js    # Factory function with tool definitions
  index.js     # Stdio transport binding
```

### server.js

The factory function creates and returns a configured `McpServer` instance:

```js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDbClient, sanitizeFtsQuery, escapeLikePattern } from '../db.js';

export function createYourServer(dbPath) {
  const server = new McpServer({
    name: 'crow-your-server',
    version: '1.0.0',
  });

  const db = getDbClient(dbPath);

  server.tool(
    'crow_your_tool',
    'Description of what this tool does',
    {
      input: z.string().max(500).describe('What this parameter is for'),
      optional_param: z.string().max(200).optional().describe('Optional parameter'),
    },
    async ({ input, optional_param }) => {
      // Tool logic here
      const result = await db.execute({
        sql: 'SELECT * FROM your_table WHERE column = ?',
        args: [input],
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(result.rows) }],
      };
    }
  );

  return server;
}
```

### index.js

The stdio entry point is minimal:

```js
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createYourServer } from './server.js';

const server = createYourServer();
const transport = new StdioServerTransport();
await server.connect(transport);
```

## Zod Schema Constraints

All string parameters must include `.max()` constraints to prevent abuse:

```js
// Good
z.string().max(500).describe('Search query')
z.string().max(50000).describe('Content body')

// Bad — no size limit
z.string().describe('Search query')
```

Recommended limits:
- Short fields (names, IDs, queries): `.max(500)`
- Content fields (body text, notes): `.max(50000)`
- Numeric limits: use `.min()` and `.max()` on `z.number()`

## Database Tables

If your server needs its own tables, add them to `scripts/init-db.js`:

```js
await db.execute(`
  CREATE TABLE IF NOT EXISTS your_table (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);
```

Then run `npm run init-db` to create the tables.

### FTS5 Indexes

If your table needs full-text search, add an FTS5 virtual table and sync triggers:

```js
await db.execute(`
  CREATE VIRTUAL TABLE IF NOT EXISTS your_table_fts USING fts5(
    name, content,
    content='your_table',
    content_rowid='id'
  )
`);

// Insert trigger
await db.execute(`
  CREATE TRIGGER IF NOT EXISTS your_table_ai AFTER INSERT ON your_table BEGIN
    INSERT INTO your_table_fts(rowid, name, content)
    VALUES (new.id, new.name, new.content);
  END
`);

// Update trigger
await db.execute(`
  CREATE TRIGGER IF NOT EXISTS your_table_au AFTER UPDATE ON your_table BEGIN
    INSERT INTO your_table_fts(your_table_fts, rowid, name, content)
    VALUES ('delete', old.id, old.name, old.content);
    INSERT INTO your_table_fts(rowid, name, content)
    VALUES (new.id, new.name, new.content);
  END
`);

// Delete trigger
await db.execute(`
  CREATE TRIGGER IF NOT EXISTS your_table_ad AFTER DELETE ON your_table BEGIN
    INSERT INTO your_table_fts(your_table_fts, rowid, name, content)
    VALUES ('delete', old.id, old.name, old.content);
  END
`);
```

Use `sanitizeFtsQuery()` from `servers/db.js` for any FTS5 MATCH queries:

```js
import { sanitizeFtsQuery } from '../db.js';

const safeQuery = sanitizeFtsQuery(userInput);
const results = await db.execute({
  sql: `SELECT * FROM your_table WHERE id IN (
    SELECT rowid FROM your_table_fts WHERE your_table_fts MATCH ?
  )`,
  args: [safeQuery],
});
```

Use `escapeLikePattern()` for LIKE queries:

```js
import { escapeLikePattern } from '../db.js';

const safePattern = escapeLikePattern(userInput);
const results = await db.execute({
  sql: `SELECT * FROM your_table WHERE name LIKE ? ESCAPE '\\'`,
  args: [`%${safePattern}%`],
});
```

## Register in server-registry.js

Add your server to `scripts/server-registry.js` so `npm run mcp-config` includes it:

```js
{
  name: 'crow-your-server',
  command: 'node',
  args: ['servers/your-server/index.js'],
  envVars: [],  // Required env vars (empty = always included)
}
```

If your server requires environment variables (e.g., API keys), list them in `envVars`. The server will only be included in `.mcp.json` when those vars are set.

## Add to the Gateway

Import your factory in `servers/gateway/index.js` and wire it alongside the existing servers:

```js
import { createYourServer } from '../your-server/server.js';
// ... then add HTTP transport binding
```

## Create a Skill File

Write a skill file in `skills/` that describes your server's capabilities and guides the AI on when and how to use the tools:

```markdown
# Your Feature

## When to activate
- User asks about [your domain]
- User wants to [your use case]

## Available tools
- `crow_your_tool` — Does this thing
- `crow_your_other_tool` — Does that thing

## Workflow
1. Step one
2. Step two
```

Add a trigger row in `skills/superpowers.md` so the skill auto-activates.

## Testing

Verify your server starts without errors:

```bash
node servers/your-server/index.js
# Should start and wait for stdio input (Ctrl-C to stop)
```

Run `npm run mcp-config` and check `.mcp.json` to confirm your server appears.
