/**
 * Crow Persistent Memory — Server Factory
 *
 * Creates a configured McpServer with all memory tools registered.
 * Transport-agnostic: used by both stdio (index.js) and HTTP (gateway).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Database from "better-sqlite3";
import { z } from "zod";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createMemoryServer(dbPath) {
  const DB_PATH = dbPath || process.env.CROW_DB_PATH || resolve(__dirname, "../../data/crow.db");

  if (!existsSync(DB_PATH)) {
    throw new Error(`Database not found at ${DB_PATH}. Run 'npm run init-db' first.`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const server = new McpServer({
    name: "crow-memory",
    version: "0.1.0",
  });

  // --- Tools ---

  server.tool(
    "store_memory",
    "Store a new piece of information in persistent memory. Use this whenever you learn something important about the user, their projects, preferences, or any context that should persist across sessions.",
    {
      content: z.string().describe("The information to remember"),
      category: z.string().default("general").describe("Category: general, project, preference, person, process, decision, learning, goal"),
      context: z.string().optional().describe("Additional context about when/why this was stored"),
      tags: z.string().optional().describe("Comma-separated tags for filtering"),
      source: z.string().optional().describe("Where this information came from"),
      importance: z.number().min(1).max(10).default(5).describe("1-10 importance rating"),
    },
    async ({ content, category, context, tags, source, importance }) => {
      const stmt = db.prepare(`
        INSERT INTO memories (content, category, context, tags, source, importance)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(content, category, context, tags, source, importance);
      return {
        content: [
          {
            type: "text",
            text: `Memory stored (id: ${result.lastInsertRowid}, category: ${category}, importance: ${importance})`,
          },
        ],
      };
    }
  );

  server.tool(
    "search_memories",
    "Search persistent memory using full-text search. Returns memories ranked by relevance. Use this to recall information from previous sessions.",
    {
      query: z.string().describe("Search query (supports FTS5 syntax: AND, OR, NOT, phrases)"),
      category: z.string().optional().describe("Filter by category"),
      min_importance: z.number().min(1).max(10).optional().describe("Minimum importance threshold"),
      limit: z.number().default(10).describe("Maximum results to return"),
    },
    async ({ query, category, min_importance, limit }) => {
      let sql = `
        SELECT m.*, rank
        FROM memories_fts fts
        JOIN memories m ON m.id = fts.rowid
        WHERE memories_fts MATCH ?
      `;
      const params = [query];

      if (category) {
        sql += " AND m.category = ?";
        params.push(category);
      }
      if (min_importance) {
        sql += " AND m.importance >= ?";
        params.push(min_importance);
      }

      sql += " ORDER BY rank LIMIT ?";
      params.push(limit);

      const rows = db.prepare(sql).all(...params);

      const updateStmt = db.prepare(`
        UPDATE memories SET accessed_at = datetime('now'), access_count = access_count + 1 WHERE id = ?
      `);
      for (const row of rows) {
        updateStmt.run(row.id);
      }

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No memories found matching that query." }] };
      }

      const formatted = rows
        .map(
          (r) =>
            `[#${r.id}] (${r.category}, importance: ${r.importance}) ${r.content}${r.context ? `\n  Context: ${r.context}` : ""}${r.tags ? `\n  Tags: ${r.tags}` : ""}${r.source ? `\n  Source: ${r.source}` : ""}`
        )
        .join("\n\n");

      return { content: [{ type: "text", text: `Found ${rows.length} memories:\n\n${formatted}` }] };
    }
  );

  server.tool(
    "recall_by_context",
    "Retrieve memories relevant to a given context. Uses full-text search across content, context, and tags to find the most relevant stored information.",
    {
      context: z.string().describe("Describe the current context or topic to find relevant memories"),
      limit: z.number().default(5).describe("Maximum results"),
    },
    async ({ context, limit }) => {
      const words = context
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .slice(0, 10)
        .map((w) => `"${w.replace(/"/g, "")}"`)
        .join(" OR ");

      if (!words) {
        return { content: [{ type: "text", text: "Context too short to search." }] };
      }

      const rows = db
        .prepare(
          `
        SELECT m.*, rank FROM memories_fts fts
        JOIN memories m ON m.id = fts.rowid
        WHERE memories_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `
        )
        .all(words, limit);

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No relevant memories found for this context." }] };
      }

      const formatted = rows
        .map((r) => `[#${r.id}] (${r.category}) ${r.content}`)
        .join("\n\n");

      return {
        content: [{ type: "text", text: `Relevant memories for "${context}":\n\n${formatted}` }],
      };
    }
  );

  server.tool(
    "list_memories",
    "List memories with optional filtering by category, tags, or importance. Good for browsing what's stored.",
    {
      category: z.string().optional().describe("Filter by category"),
      tag: z.string().optional().describe("Filter by tag (partial match)"),
      min_importance: z.number().min(1).max(10).optional().describe("Minimum importance"),
      sort_by: z.enum(["recent", "importance", "accessed"]).default("recent").describe("Sort order"),
      limit: z.number().default(20).describe("Max results"),
    },
    async ({ category, tag, min_importance, sort_by, limit }) => {
      let sql = "SELECT * FROM memories WHERE 1=1";
      const params = [];

      if (category) {
        sql += " AND category = ?";
        params.push(category);
      }
      if (tag) {
        sql += " AND tags LIKE ?";
        params.push(`%${tag}%`);
      }
      if (min_importance) {
        sql += " AND importance >= ?";
        params.push(min_importance);
      }

      const sortMap = {
        recent: "created_at DESC",
        importance: "importance DESC, created_at DESC",
        accessed: "accessed_at DESC",
      };
      sql += ` ORDER BY ${sortMap[sort_by]} LIMIT ?`;
      params.push(limit);

      const rows = db.prepare(sql).all(...params);

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No memories found with those filters." }] };
      }

      const formatted = rows
        .map(
          (r) =>
            `[#${r.id}] ${r.category} | imp:${r.importance} | ${r.created_at}\n  ${r.content}${r.tags ? `\n  Tags: ${r.tags}` : ""}`
        )
        .join("\n\n");

      return { content: [{ type: "text", text: `${rows.length} memories:\n\n${formatted}` }] };
    }
  );

  server.tool(
    "update_memory",
    "Update an existing memory's content, category, tags, or importance.",
    {
      id: z.number().describe("Memory ID to update"),
      content: z.string().optional().describe("New content"),
      category: z.string().optional().describe("New category"),
      tags: z.string().optional().describe("New tags (replaces existing)"),
      importance: z.number().min(1).max(10).optional().describe("New importance"),
      context: z.string().optional().describe("Updated context"),
    },
    async ({ id, content, category, tags, importance, context }) => {
      const existing = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
      if (!existing) {
        return { content: [{ type: "text", text: `Memory #${id} not found.` }] };
      }

      const updates = [];
      const params = [];
      if (content !== undefined) { updates.push("content = ?"); params.push(content); }
      if (category !== undefined) { updates.push("category = ?"); params.push(category); }
      if (tags !== undefined) { updates.push("tags = ?"); params.push(tags); }
      if (importance !== undefined) { updates.push("importance = ?"); params.push(importance); }
      if (context !== undefined) { updates.push("context = ?"); params.push(context); }

      if (updates.length === 0) {
        return { content: [{ type: "text", text: "No updates provided." }] };
      }

      updates.push("updated_at = datetime('now')");
      params.push(id);

      db.prepare(`UPDATE memories SET ${updates.join(", ")} WHERE id = ?`).run(...params);

      return { content: [{ type: "text", text: `Memory #${id} updated.` }] };
    }
  );

  server.tool(
    "delete_memory",
    "Delete a memory by ID.",
    { id: z.number().describe("Memory ID to delete") },
    async ({ id }) => {
      const result = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      return {
        content: [
          {
            type: "text",
            text: result.changes > 0 ? `Memory #${id} deleted.` : `Memory #${id} not found.`,
          },
        ],
      };
    }
  );

  server.tool(
    "memory_stats",
    "Get statistics about stored memories - counts by category, total count, importance distribution.",
    {},
    async () => {
      const total = db.prepare("SELECT COUNT(*) as count FROM memories").get();
      const byCategory = db.prepare("SELECT category, COUNT(*) as count FROM memories GROUP BY category ORDER BY count DESC").all();
      const byImportance = db.prepare("SELECT importance, COUNT(*) as count FROM memories GROUP BY importance ORDER BY importance DESC").all();
      const recent = db.prepare("SELECT id, category, substr(content, 1, 80) as preview, created_at FROM memories ORDER BY created_at DESC LIMIT 5").all();

      let text = `Memory Statistics:\n`;
      text += `  Total memories: ${total.count}\n\n`;
      text += `By Category:\n${byCategory.map((r) => `  ${r.category}: ${r.count}`).join("\n")}\n\n`;
      text += `By Importance:\n${byImportance.map((r) => `  Level ${r.importance}: ${r.count}`).join("\n")}\n\n`;
      text += `Recent:\n${recent.map((r) => `  [#${r.id}] ${r.category} - ${r.preview}...`).join("\n")}`;

      return { content: [{ type: "text", text }] };
    }
  );

  // --- Resources ---

  server.resource("memory-categories", "memory://categories", async (uri) => {
    const categories = db
      .prepare("SELECT DISTINCT category, COUNT(*) as count FROM memories GROUP BY category ORDER BY count DESC")
      .all();
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(categories, null, 2),
        },
      ],
    };
  });

  return server;
}
