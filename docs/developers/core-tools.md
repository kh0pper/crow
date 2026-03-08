# Adding Core Server Tools

This guide explains how to add new MCP tools to Crow's core servers: crow-memory, crow-research, or crow-sharing.

## Server Factory Pattern

Each server has a factory function in `server.js` that returns a configured `McpServer`:

```
servers/memory/server.js    → createMemoryServer()
servers/research/server.js  → createResearchServer()
servers/sharing/server.js   → createSharingServer()
```

Tool logic lives in `server.js`. Transport wiring (`index.js`) and gateway mounting (`servers/gateway/index.js`) are separate — you only need to modify `server.js`.

## Adding a Tool

Use the `server.tool()` pattern:

```js
server.tool(
  "tool_name",
  "Description of what this tool does",
  {
    param1: z.string().max(500).describe("What this parameter is"),
    param2: z.number().optional().describe("Optional numeric parameter"),
  },
  async ({ param1, param2 }) => {
    const db = createDbClient();
    try {
      // Your logic here
      const result = await db.execute({
        sql: "SELECT * FROM table WHERE col = ?",
        args: [param1],
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
      };
    } finally {
      db.close();
    }
  }
);
```

## Conventions

### Zod Schemas

All parameters must use Zod with `.max()` constraints:

```js
z.string().max(50000)   // Content fields
z.string().max(500)     // Short fields (titles, tags)
z.number().int().min(1).max(100)  // Numeric limits
```

### Database Queries

Use parameterized queries — never interpolate user input:

```js
// Good
db.execute({ sql: "SELECT * FROM memories WHERE id = ?", args: [id] });

// Bad — SQL injection risk
db.execute({ sql: `SELECT * FROM memories WHERE id = ${id}` });
```

### FTS5 Queries

Use the `sanitizeFtsQuery()` utility for full-text search:

```js
import { sanitizeFtsQuery, escapeLikePattern } from "../db.js";

// FTS5 MATCH
const safeQuery = sanitizeFtsQuery(userInput);
db.execute({
  sql: "SELECT * FROM memories_fts WHERE memories_fts MATCH ?",
  args: [safeQuery],
});

// LIKE pattern
const safePattern = escapeLikePattern(userInput);
db.execute({
  sql: "SELECT * FROM memories WHERE title LIKE ? ESCAPE '\\'",
  args: [`%${safePattern}%`],
});
```

### Schema Changes

If your tool needs new DB tables or columns:

1. Add the schema to `scripts/init-db.js` using the `initTable()` helper
2. If adding FTS, create the virtual table AND insert/update/delete triggers
3. Run `npm run init-db` to apply

## Testing

```bash
# Verify the server starts
node servers/memory/index.js   # (or research/sharing)

# Verify the gateway starts
node servers/gateway/index.js --no-auth
```

## Submit

1. Fork the repo and implement your tool
2. Submit a PR with the checklist from the PR template
