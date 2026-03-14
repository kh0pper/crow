/**
 * Crow Persistent Memory — Server Factory
 *
 * Creates a configured McpServer with all memory tools registered.
 * Transport-agnostic: used by both stdio (index.js) and HTTP (gateway).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDbClient, sanitizeFtsQuery, escapeLikePattern } from "../db.js";
import { generateCrowContext, PROTECTED_SECTIONS } from "./crow-context.js";

export function createMemoryServer(dbPath, options = {}) {
  const db = createDbClient(dbPath);

  const server = new McpServer(
    { name: "crow-memory", version: "0.1.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  // --- Tools ---

  server.tool(
    "crow_store_memory",
    "Store a new piece of information in persistent memory. Use this whenever you learn something important about the user, their projects, preferences, or any context that should persist across sessions.",
    {
      content: z.string().max(50000).describe("The information to remember"),
      category: z.string().max(500).default("general").describe("Category: general, project, preference, person, process, decision, learning, goal"),
      context: z.string().max(50000).optional().describe("Additional context about when/why this was stored"),
      tags: z.string().max(500).optional().describe("Comma-separated tags for filtering"),
      source: z.string().max(500).optional().describe("Where this information came from"),
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
      query: z.string().max(500).describe("Search query"),
      category: z.string().max(500).optional().describe("Filter by category"),
      min_importance: z.number().min(1).max(10).optional().describe("Minimum importance threshold"),
      limit: z.number().max(100).default(10).describe("Maximum results to return"),
    },
    async ({ query, category, min_importance, limit }) => {
      const safeQuery = sanitizeFtsQuery(query);
      if (!safeQuery) {
        return { content: [{ type: "text", text: "Search query is empty or contains only special characters." }] };
      }

      let sql = `
        SELECT m.*, rank
        FROM memories_fts fts
        JOIN memories m ON m.id = fts.rowid
        WHERE memories_fts MATCH ?
      `;
      const params = [safeQuery];

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
            `[#${r.id}] (${r.category}, importance: ${r.importance})\n--- stored content ---\n${r.content}\n--- end stored content ---${r.context ? `\n  Context: ${r.context}` : ""}${r.tags ? `\n  Tags: ${r.tags}` : ""}${r.source ? `\n  Source: ${r.source}` : ""}`
        )
        .join("\n\n");

      return { content: [{ type: "text", text: `Found ${rows.length} memories:\n\n${formatted}` }] };
    }
  );

  server.tool(
    "crow_recall_by_context",
    "Retrieve memories relevant to a given context. Uses full-text search across content, context, and tags to find the most relevant stored information.",
    {
      context: z.string().max(2000).describe("Describe the current context or topic to find relevant memories"),
      limit: z.number().max(100).default(5).describe("Maximum results"),
    },
    async ({ context, limit }) => {
      const contextWords = context.split(/\s+/).filter((w) => w.length > 2).slice(0, 10).join(" ");
      const safeQuery = sanitizeFtsQuery(contextWords);

      if (!safeQuery) {
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
        args: [safeQuery, limit],
      });

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No relevant memories found for this context." }] };
      }

      const formatted = rows
        .map((r) => `[#${r.id}] (${r.category})\n--- stored content ---\n${r.content}\n--- end stored content ---`)
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
      category: z.string().max(500).optional().describe("Filter by category"),
      tag: z.string().max(500).optional().describe("Filter by tag (partial match)"),
      min_importance: z.number().min(1).max(10).optional().describe("Minimum importance"),
      sort_by: z.enum(["recent", "importance", "accessed"]).default("recent").describe("Sort order"),
      limit: z.number().max(100).default(20).describe("Max results"),
    },
    async ({ category, tag, min_importance, sort_by, limit }) => {
      let sql = "SELECT * FROM memories WHERE 1=1";
      const params = [];

      if (category) {
        sql += " AND category = ?";
        params.push(category);
      }
      if (tag) {
        sql += " AND tags LIKE ? ESCAPE '\\'";
        params.push(`%${escapeLikePattern(tag)}%`);
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
      content: z.string().max(50000).optional().describe("New content"),
      category: z.string().max(500).optional().describe("New category"),
      tags: z.string().max(500).optional().describe("New tags (replaces existing)"),
      importance: z.number().min(1).max(10).optional().describe("New importance"),
      context: z.string().max(50000).optional().describe("Updated context"),
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
    "Generate and return the full crow.md cross-platform behavioral context document. This document defines how Crow behaves across all AI platforms — personality, memory protocols, transparency rules, and more. Includes optional dynamic data (memory stats, active projects, preferences). Use device_id to get device-specific overrides merged with global context.",
    {
      include_dynamic: z.boolean().default(true).describe("Include dynamic sections (memory stats, active projects, preferences)"),
      platform: z.string().default("generic").describe("Target platform hint: claude, chatgpt, gemini, grok, cursor, windsurf, cline, generic"),
      device_id: z.string().max(200).optional().describe("Device ID to merge device-specific overrides with global context"),
    },
    async ({ include_dynamic, platform, device_id }) => {
      const markdown = await generateCrowContext(db, { includeDynamic: include_dynamic, platform, deviceId: device_id ?? null });
      return { content: [{ type: "text", text: markdown }] };
    }
  );

  server.tool(
    "crow_update_context_section",
    "Update an existing crow.md section's content, title, enabled status, or sort order. Works on both protected and custom sections. Use device_id to update a device-specific override instead of the global section.",
    {
      section_key: z.string().max(500).describe("The section key to update (e.g. 'identity', 'memory_protocol')"),
      content: z.string().max(50000).optional().describe("New content for the section"),
      section_title: z.string().max(500).optional().describe("New title for the section"),
      enabled: z.boolean().optional().describe("Enable or disable this section"),
      sort_order: z.number().optional().describe("New sort order (lower = earlier)"),
      device_id: z.string().max(200).optional().describe("Device ID to update a device-specific override. Omit for global section."),
    },
    async ({ section_key, content, section_title, enabled, sort_order, device_id }) => {
      // Build WHERE clause based on device_id
      const whereClause = device_id
        ? "section_key = ? AND device_id = ?"
        : "section_key = ? AND device_id IS NULL";
      const whereArgs = device_id ? [section_key, device_id] : [section_key];

      const { rows } = await db.execute({
        sql: `SELECT * FROM crow_context WHERE ${whereClause}`,
        args: whereArgs,
      });
      if (rows.length === 0) {
        const target = device_id ? ` (device: ${device_id})` : "";
        return { content: [{ type: "text", text: `Section "${section_key}"${target} not found.` }] };
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
      params.push(...whereArgs);

      await db.execute({
        sql: `UPDATE crow_context SET ${updates.join(", ")} WHERE ${whereClause}`,
        args: params,
      });

      const target = device_id ? ` (device: ${device_id})` : "";
      return { content: [{ type: "text", text: `Section "${section_key}"${target} updated.` }] };
    }
  );

  server.tool(
    "crow_add_context_section",
    "Add a new custom section to crow.md. Custom sections can be used to extend Crow's behavioral context with project-specific or user-specific instructions. Use device_id to create a device-specific override that takes precedence over the global section on that device.",
    {
      section_key: z.string().max(500).describe("Unique key for the section (e.g. 'project_guidelines', 'coding_style')"),
      section_title: z.string().max(500).describe("Display title for the section"),
      content: z.string().max(50000).describe("Markdown content for the section"),
      sort_order: z.number().default(100).describe("Sort order (lower = earlier, default 100)"),
      device_id: z.string().max(200).optional().describe("Device ID to create a device-specific override. Omit for global section."),
    },
    async ({ section_key, section_title, content, sort_order, device_id }) => {
      // Protected sections can have device overrides but not new global entries
      if (PROTECTED_SECTIONS.includes(section_key) && !device_id) {
        return { content: [{ type: "text", text: `Cannot create section with protected key "${section_key}". Use crow_update_context_section to modify it.` }] };
      }

      try {
        await db.execute({
          sql: "INSERT INTO crow_context (section_key, section_title, content, sort_order, device_id) VALUES (?, ?, ?, ?, ?)",
          args: [section_key, section_title, content, sort_order, device_id ?? null],
        });
        const target = device_id ? ` (device: ${device_id})` : "";
        return { content: [{ type: "text", text: `Section "${section_key}"${target} added to crow.md.` }] };
      } catch (err) {
        if (err.message?.includes("UNIQUE")) {
          const target = device_id ? ` for device "${device_id}"` : "";
          return { content: [{ type: "text", text: `Section "${section_key}"${target} already exists. Use crow_update_context_section to modify it.` }] };
        }
        throw err;
      }
    }
  );

  server.tool(
    "crow_list_context_sections",
    "List all crow.md sections with their metadata (key, title, sort order, enabled status, device ID). Does not return full content — use crow_get_context for that. Use device_id to filter sections for a specific device.",
    {
      device_id: z.string().max(200).optional().describe("Filter to sections for this device (also shows global sections). Omit to show all sections."),
    },
    async ({ device_id } = {}) => {
      const { rows } = await db.execute(
        "SELECT section_key, section_title, sort_order, enabled, updated_at, device_id FROM crow_context ORDER BY sort_order ASC, id ASC"
      );

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No crow.md sections found. Run `npm run init-db` to seed defaults." }] };
      }

      // If device_id filter is set, show global + that device's sections
      const filtered = device_id
        ? rows.filter((r) => !r.device_id || r.device_id === device_id)
        : rows;

      const formatted = filtered
        .map((r) => {
          const status = r.enabled ? "enabled" : "disabled";
          const prot = PROTECTED_SECTIONS.includes(r.section_key) ? " [protected]" : "";
          const device = r.device_id ? ` [device: ${r.device_id}]` : "";
          return `- ${r.section_key}${prot}${device}: "${r.section_title}" (order: ${r.sort_order}, ${status}, updated: ${r.updated_at})`;
        })
        .join("\n");

      return { content: [{ type: "text", text: `crow.md sections:\n\n${formatted}` }] };
    }
  );

  server.tool(
    "crow_delete_context_section",
    "Delete a custom crow.md section. Protected sections (identity, memory_protocol, research_protocol, session_protocol, transparency_rules, skills_reference, key_principles) cannot be deleted — only disabled. Device-specific overrides of protected sections CAN be deleted (restores the global version for that device).",
    {
      section_key: z.string().max(500).describe("The section key to delete"),
      device_id: z.string().max(200).optional().describe("Device ID to delete only the device-specific override. Omit to delete the global section."),
    },
    async ({ section_key, device_id }) => {
      // Protected global sections cannot be deleted, but device overrides can
      if (PROTECTED_SECTIONS.includes(section_key) && !device_id) {
        return {
          content: [{ type: "text", text: `Cannot delete protected section "${section_key}". Use crow_update_context_section with enabled=false to disable it instead.` }],
        };
      }

      const whereClause = device_id
        ? "section_key = ? AND device_id = ?"
        : "section_key = ? AND device_id IS NULL";
      const whereArgs = device_id ? [section_key, device_id] : [section_key];

      const result = await db.execute({
        sql: `DELETE FROM crow_context WHERE ${whereClause}`,
        args: whereArgs,
      });

      const target = device_id ? ` (device: ${device_id})` : "";
      return {
        content: [
          {
            type: "text",
            text: result.rowsAffected > 0
              ? `Section "${section_key}"${target} deleted.`
              : `Section "${section_key}"${target} not found.`,
          },
        ],
      };
    }
  );

  // --- Schedule Tools ---

  server.tool(
    "crow_create_schedule",
    "Create a scheduled or recurring task. Uses cron expressions for timing (e.g. '0 9 * * *' for daily at 9am, '0 */6 * * *' for every 6 hours).",
    {
      task: z.string().max(1000).describe("The task to schedule"),
      cron_expression: z.string().max(50).describe("Cron expression for scheduling (e.g. '0 9 * * *' for daily at 9am)"),
      description: z.string().max(500).optional().describe("Optional description of the schedule"),
    },
    async ({ task, cron_expression, description }) => {
      // Validate and compute next_run
      let nextRun = null;
      try {
        const { CronExpressionParser } = await import("cron-parser");
        const interval = CronExpressionParser.parse(cron_expression);
        nextRun = interval.next().toISOString();
      } catch {
        return { content: [{ type: "text", text: `Invalid cron expression: "${cron_expression}". Use standard 5-field format (e.g. "0 9 * * *" for daily at 9am).` }] };
      }

      const result = await db.execute({
        sql: "INSERT INTO schedules (task, cron_expression, description, next_run) VALUES (?, ?, ?, ?)",
        args: [task, cron_expression, description ?? null, nextRun],
      });
      return {
        content: [
          {
            type: "text",
            text: `Schedule created (id: ${Number(result.lastInsertRowid)}, task: ${task}, cron: ${cron_expression}, next run: ${nextRun})`,
          },
        ],
      };
    }
  );

  server.tool(
    "crow_list_schedules",
    "List all scheduled tasks, optionally filtering to only enabled schedules.",
    {
      enabled_only: z.boolean().optional().describe("If true, only return enabled schedules"),
    },
    async ({ enabled_only }) => {
      let sql = "SELECT * FROM schedules";
      const params = [];

      if (enabled_only) {
        sql += " WHERE enabled = 1";
      }

      sql += " ORDER BY created_at DESC";

      const { rows } = await db.execute({ sql, args: params });

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No schedules found." }] };
      }

      const formatted = rows
        .map(
          (r) =>
            `[#${r.id}] ${r.enabled ? "enabled" : "disabled"} | ${r.cron_expression}\n  Task: ${r.task}${r.description ? `\n  Description: ${r.description}` : ""}${r.last_run ? `\n  Last run: ${r.last_run}` : ""}${r.next_run ? `\n  Next run: ${r.next_run}` : ""}\n  Created: ${r.created_at}`
        )
        .join("\n\n");

      return { content: [{ type: "text", text: `${rows.length} schedules:\n\n${formatted}` }] };
    }
  );

  server.tool(
    "crow_update_schedule",
    "Update or delete a scheduled task by ID. Provide only the fields you want to change, or set delete=true to remove it.",
    {
      id: z.number().describe("Schedule ID to update or delete"),
      enabled: z.boolean().optional().describe("Enable or disable the schedule"),
      task: z.string().max(1000).optional().describe("New task description"),
      cron_expression: z.string().max(50).optional().describe("New cron expression"),
      delete: z.boolean().optional().describe("If true, delete the schedule entirely"),
    },
    async ({ id, enabled, task, cron_expression, delete: doDelete }) => {
      const { rows } = await db.execute({ sql: "SELECT * FROM schedules WHERE id = ?", args: [id] });
      if (rows.length === 0) {
        return { content: [{ type: "text", text: `Schedule #${id} not found.` }] };
      }

      if (doDelete) {
        await db.execute({ sql: "DELETE FROM schedules WHERE id = ?", args: [id] });
        return { content: [{ type: "text", text: `Schedule #${id} deleted.` }] };
      }

      const updates = [];
      const params = [];
      if (task !== undefined) { updates.push("task = ?"); params.push(task); }
      if (cron_expression !== undefined) {
        // Validate and recompute next_run
        try {
          const { CronExpressionParser } = await import("cron-parser");
          const interval = CronExpressionParser.parse(cron_expression);
          const nextRun = interval.next().toISOString();
          updates.push("cron_expression = ?"); params.push(cron_expression);
          updates.push("next_run = ?"); params.push(nextRun);
        } catch {
          return { content: [{ type: "text", text: `Invalid cron expression: "${cron_expression}". Use standard 5-field format.` }] };
        }
      }
      if (enabled !== undefined) {
        updates.push("enabled = ?"); params.push(enabled ? 1 : 0);
        // Recompute next_run when re-enabling
        if (enabled && cron_expression === undefined) {
          try {
            const { CronExpressionParser } = await import("cron-parser");
            const existingCron = rows[0].cron_expression;
            const interval = CronExpressionParser.parse(existingCron);
            updates.push("next_run = ?"); params.push(interval.next().toISOString());
          } catch {}
        }
      }

      if (updates.length === 0) {
        return { content: [{ type: "text", text: "No updates provided." }] };
      }

      updates.push("updated_at = datetime('now')");
      params.push(id);

      await db.execute({ sql: `UPDATE schedules SET ${updates.join(", ")} WHERE id = ?`, args: params });

      return { content: [{ type: "text", text: `Schedule #${id} updated.` }] };
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

  // --- Prompts ---

  server.prompt(
    "session-start",
    "Session start/end protocol — how to begin and end conversations with Crow",
    async () => {
      let text;
      try {
        const result = await db.execute({
          sql: "SELECT content FROM crow_context WHERE enabled = 1 AND section_key IN ('memory_protocol', 'session_protocol')",
          args: [],
        });
        if (result.rows.length > 0) {
          text = result.rows.map((r) => r.content).join("\n\n");
        }
      } catch {
        // Fallback
      }

      if (!text) {
        text = `Session Start Protocol:
1. Call crow_recall_by_context with the user's first message to load relevant memories
2. Use recalled memories to personalize your response
3. Throughout the conversation, store important new information with crow_store_memory

Session End Protocol:
- Before ending, store any important learnings, decisions, or preferences
- Use appropriate categories: general, project, preference, person, process, decision, learning, goal
- Set importance 8-10 for critical information the user would expect you to remember`;
      }

      return { messages: [{ role: "user", content: { type: "text", text } }] };
    }
  );

  server.prompt(
    "crow-guide",
    "Full Crow behavioral context (crow.md) — identity, memory protocols, transparency rules, and more",
    { platform: z.string().default("generic").describe("Target platform: claude, chatgpt, gemini, grok, cursor, generic") },
    async ({ platform }) => {
      let text;
      try {
        text = await generateCrowContext(db, { includeDynamic: false, platform });
      } catch {
        text = "Unable to load crow.md context. Use crow_get_context tool as an alternative.";
      }
      return { messages: [{ role: "user", content: { type: "text", text } }] };
    }
  );

  return server;
}
