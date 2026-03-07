/**
 * Crow Persistent Memory — Server Factory
 *
 * Creates a configured McpServer with all memory tools registered.
 * Transport-agnostic: used by both stdio (index.js) and HTTP (gateway).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDbClient } from "../db.js";
import { generateCrowContext, PROTECTED_SECTIONS } from "./crow-context.js";

export function createMemoryServer(dbPath) {
  const db = createDbClient(dbPath);

  const server = new McpServer({
    name: "crow-memory",
    version: "0.1.0",
  });

  // --- Tools ---

  server.tool(
    "crow_store_memory",
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
      const result = await db.execute({
        sql: "INSERT INTO memories (content, category, context, tags, source, importance) VALUES (?, ?, ?, ?, ?, ?)",
        args: [content, category, context ?? null, tags ?? null, source ?? null, importance],
      });
      return {
        content: [
          {
            type: "text",
            text: `Memory stored (id: ${Number(result.lastInsertRowid)}, category: ${category}, importance: ${importance})`,
          },
        ],
      };
    }
  );

  server.tool(
    "crow_search_memories",
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

      const { rows } = await db.execute({ sql, args: params });

      for (const row of rows) {
        await db.execute({
          sql: "UPDATE memories SET accessed_at = datetime('now'), access_count = access_count + 1 WHERE id = ?",
          args: [row.id],
        });
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
    "crow_recall_by_context",
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

      const { rows } = await db.execute({
        sql: `
          SELECT m.*, rank FROM memories_fts fts
          JOIN memories m ON m.id = fts.rowid
          WHERE memories_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `,
        args: [words, limit],
      });

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
    "crow_list_memories",
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

      const { rows } = await db.execute({ sql, args: params });

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
    "crow_update_memory",
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
      const { rows } = await db.execute({ sql: "SELECT * FROM memories WHERE id = ?", args: [id] });
      if (rows.length === 0) {
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

      await db.execute({ sql: `UPDATE memories SET ${updates.join(", ")} WHERE id = ?`, args: params });

      return { content: [{ type: "text", text: `Memory #${id} updated.` }] };
    }
  );

  server.tool(
    "crow_delete_memory",
    "Delete a memory by ID.",
    { id: z.number().describe("Memory ID to delete") },
    async ({ id }) => {
      const result = await db.execute({ sql: "DELETE FROM memories WHERE id = ?", args: [id] });
      return {
        content: [
          {
            type: "text",
            text: result.rowsAffected > 0 ? `Memory #${id} deleted.` : `Memory #${id} not found.`,
          },
        ],
      };
    }
  );

  server.tool(
    "crow_memory_stats",
    "Get statistics about stored memories - counts by category, total count, importance distribution.",
    {},
    async () => {
      const total = (await db.execute("SELECT COUNT(*) as count FROM memories")).rows[0];
      const byCategory = (await db.execute("SELECT category, COUNT(*) as count FROM memories GROUP BY category ORDER BY count DESC")).rows;
      const byImportance = (await db.execute("SELECT importance, COUNT(*) as count FROM memories GROUP BY importance ORDER BY importance DESC")).rows;
      const recent = (await db.execute("SELECT id, category, substr(content, 1, 80) as preview, created_at FROM memories ORDER BY created_at DESC LIMIT 5")).rows;

      let text = `Memory Statistics:\n`;
      text += `  Total memories: ${total.count}\n\n`;
      text += `By Category:\n${byCategory.map((r) => `  ${r.category}: ${r.count}`).join("\n")}\n\n`;
      text += `By Importance:\n${byImportance.map((r) => `  Level ${r.importance}: ${r.count}`).join("\n")}\n\n`;
      text += `Recent:\n${recent.map((r) => `  [#${r.id}] ${r.category} - ${r.preview}...`).join("\n")}`;

      return { content: [{ type: "text", text }] };
    }
  );

  // --- Cross-Platform Context (crow.md) Tools ---

  server.tool(
    "crow_get_context",
    "Generate and return the full crow.md cross-platform behavioral context document. This document defines how Crow behaves across all AI platforms — personality, memory protocols, transparency rules, and more. Includes optional dynamic data (memory stats, active projects, preferences).",
    {
      include_dynamic: z.boolean().default(true).describe("Include dynamic sections (memory stats, active projects, preferences)"),
      platform: z.string().default("generic").describe("Target platform hint: claude, chatgpt, gemini, grok, cursor, windsurf, cline, generic"),
    },
    async ({ include_dynamic, platform }) => {
      const markdown = await generateCrowContext(db, { includeDynamic: include_dynamic, platform });
      return { content: [{ type: "text", text: markdown }] };
    }
  );

  server.tool(
    "crow_update_context_section",
    "Update an existing crow.md section's content, title, enabled status, or sort order. Works on both protected and custom sections.",
    {
      section_key: z.string().describe("The section key to update (e.g. 'identity', 'memory_protocol')"),
      content: z.string().optional().describe("New content for the section"),
      section_title: z.string().optional().describe("New title for the section"),
      enabled: z.boolean().optional().describe("Enable or disable this section"),
      sort_order: z.number().optional().describe("New sort order (lower = earlier)"),
    },
    async ({ section_key, content, section_title, enabled, sort_order }) => {
      const { rows } = await db.execute({
        sql: "SELECT * FROM crow_context WHERE section_key = ?",
        args: [section_key],
      });
      if (rows.length === 0) {
        return { content: [{ type: "text", text: `Section "${section_key}" not found.` }] };
      }

      const updates = [];
      const params = [];
      if (content !== undefined) { updates.push("content = ?"); params.push(content); }
      if (section_title !== undefined) { updates.push("section_title = ?"); params.push(section_title); }
      if (enabled !== undefined) { updates.push("enabled = ?"); params.push(enabled ? 1 : 0); }
      if (sort_order !== undefined) { updates.push("sort_order = ?"); params.push(sort_order); }

      if (updates.length === 0) {
        return { content: [{ type: "text", text: "No updates provided." }] };
      }

      updates.push("updated_at = datetime('now')");
      params.push(section_key);

      await db.execute({
        sql: `UPDATE crow_context SET ${updates.join(", ")} WHERE section_key = ?`,
        args: params,
      });

      return { content: [{ type: "text", text: `Section "${section_key}" updated.` }] };
    }
  );

  server.tool(
    "crow_add_context_section",
    "Add a new custom section to crow.md. Custom sections can be used to extend Crow's behavioral context with project-specific or user-specific instructions.",
    {
      section_key: z.string().describe("Unique key for the section (e.g. 'project_guidelines', 'coding_style')"),
      section_title: z.string().describe("Display title for the section"),
      content: z.string().describe("Markdown content for the section"),
      sort_order: z.number().default(100).describe("Sort order (lower = earlier, default 100)"),
    },
    async ({ section_key, section_title, content, sort_order }) => {
      if (PROTECTED_SECTIONS.includes(section_key)) {
        return { content: [{ type: "text", text: `Cannot create section with protected key "${section_key}". Use crow_update_context_section to modify it.` }] };
      }

      try {
        await db.execute({
          sql: "INSERT INTO crow_context (section_key, section_title, content, sort_order) VALUES (?, ?, ?, ?)",
          args: [section_key, section_title, content, sort_order],
        });
        return { content: [{ type: "text", text: `Section "${section_key}" added to crow.md.` }] };
      } catch (err) {
        if (err.message?.includes("UNIQUE")) {
          return { content: [{ type: "text", text: `Section "${section_key}" already exists. Use crow_update_context_section to modify it.` }] };
        }
        throw err;
      }
    }
  );

  server.tool(
    "crow_list_context_sections",
    "List all crow.md sections with their metadata (key, title, sort order, enabled status). Does not return full content — use crow_get_context for that.",
    {},
    async () => {
      const { rows } = await db.execute(
        "SELECT section_key, section_title, sort_order, enabled, updated_at FROM crow_context ORDER BY sort_order ASC, id ASC"
      );

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No crow.md sections found. Run `npm run init-db` to seed defaults." }] };
      }

      const formatted = rows
        .map((r) => {
          const status = r.enabled ? "enabled" : "disabled";
          const prot = PROTECTED_SECTIONS.includes(r.section_key) ? " [protected]" : "";
          return `- ${r.section_key}${prot}: "${r.section_title}" (order: ${r.sort_order}, ${status}, updated: ${r.updated_at})`;
        })
        .join("\n");

      return { content: [{ type: "text", text: `crow.md sections:\n\n${formatted}` }] };
    }
  );

  server.tool(
    "crow_delete_context_section",
    "Delete a custom crow.md section. Protected sections (identity, memory_protocol, research_protocol, session_protocol, transparency_rules, skills_reference, key_principles) cannot be deleted — only disabled.",
    {
      section_key: z.string().describe("The section key to delete"),
    },
    async ({ section_key }) => {
      if (PROTECTED_SECTIONS.includes(section_key)) {
        return {
          content: [{ type: "text", text: `Cannot delete protected section "${section_key}". Use crow_update_context_section with enabled=false to disable it instead.` }],
        };
      }

      const result = await db.execute({
        sql: "DELETE FROM crow_context WHERE section_key = ?",
        args: [section_key],
      });

      return {
        content: [
          {
            type: "text",
            text: result.rowsAffected > 0
              ? `Section "${section_key}" deleted.`
              : `Section "${section_key}" not found.`,
          },
        ],
      };
    }
  );

  // --- Resources ---

  server.resource("crow-context", "crow://context", async (uri) => {
    const markdown = await generateCrowContext(db, { includeDynamic: true, platform: "generic" });
    return {
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: markdown }],
    };
  });

  server.resource("memory-categories", "memory://categories", async (uri) => {
    const { rows: categories } = await db.execute(
      "SELECT DISTINCT category, COUNT(*) as count FROM memories GROUP BY category ORDER BY count DESC"
    );
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
