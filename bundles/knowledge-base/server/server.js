/**
 * Crow Knowledge Base MCP Server
 *
 * Multilingual knowledge base — create, manage, and share organized
 * collections of guides and articles with structured resource tracking
 * and verification workflows.
 *
 * Factory function: createKnowledgeBaseServer(db, options?)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { sanitizeFtsQuery, escapeLikePattern } from "./db.js";

// Lazy-load confirm helpers (may not be available in standalone mode)
let generateToken, validateToken, shouldSkipGates;
try {
  const confirmMod = await import("../../../servers/shared/confirm.js");
  generateToken = confirmMod.generateToken;
  validateToken = confirmMod.validateToken;
  shouldSkipGates = confirmMod.shouldSkipGates;
} catch {
  // Standalone mode — confirm gates disabled
  generateToken = () => "standalone";
  validateToken = () => true;
  shouldSkipGates = () => true;
}

// Lazy-load notification helper
let createNotification;
try {
  const notifMod = await import("../../../servers/shared/notifications.js");
  createNotification = notifMod.createNotification;
} catch {
  createNotification = async () => {};
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 200);
}

export function createKnowledgeBaseServer(db, options = {}) {
  const server = new McpServer(
    { name: "crow-knowledge-base", version: "1.0.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  // ─── Tool 1: crow_kb_create_collection ───

  server.tool(
    "crow_kb_create_collection",
    "Create a new knowledge base collection. Collections are top-level containers that hold categories and articles.",
    {
      name: z.string().min(1).max(200).describe("Collection name"),
      description: z.string().max(2000).optional().describe("Collection description"),
      languages: z.string().max(100).optional().default("en,es").describe("Comma-separated ISO 639-1 language codes (default: en,es)"),
      default_language: z.string().max(10).optional().default("en").describe("Default language code"),
      visibility: z.enum(["private", "public", "peers", "lan"]).optional().default("private").describe("Visibility: private, public (web), peers (shared contacts), lan (local network)"),
    },
    async ({ name, description, languages, default_language, visibility }) => {
      const slug = slugify(name);
      if (!slug) {
        return { content: [{ type: "text", text: "Could not generate a valid slug from the collection name." }], isError: true };
      }

      try {
        const result = await db.execute({
          sql: `INSERT INTO kb_collections (slug, name, description, default_language, languages, visibility, lan_enabled)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [slug, name, description || null, default_language, languages, visibility, 0],
        });

        const collection = {
          id: Number(result.lastInsertRowid),
          slug,
          name,
          description,
          languages,
          default_language,
          visibility,
        };

        return { content: [{ type: "text", text: JSON.stringify(collection, null, 2) }] };
      } catch (err) {
        if (err.message?.includes("UNIQUE constraint")) {
          return { content: [{ type: "text", text: `A collection with slug "${slug}" already exists.` }], isError: true };
        }
        throw err;
      }
    }
  );

  // ─── Tool 1b: crow_kb_edit_collection ───

  server.tool(
    "crow_kb_edit_collection",
    "Update an existing knowledge base collection's name, description, visibility, or LAN discovery settings.",
    {
      id: z.number().int().positive().describe("Collection ID"),
      name: z.string().min(1).max(200).optional().describe("New collection name"),
      description: z.string().max(2000).optional().describe("New description"),
      visibility: z.enum(["private", "public", "peers", "lan"]).optional().describe("New visibility mode"),
      languages: z.string().max(100).optional().describe("Comma-separated language codes"),
      lan_enabled: z.boolean().optional().describe("Toggle mDNS LAN advertisement"),
    },
    async ({ id, name, description, visibility, languages, lan_enabled }) => {
      const existing = await db.execute({ sql: "SELECT * FROM kb_collections WHERE id = ?", args: [id] });
      if (existing.rows.length === 0) {
        return { content: [{ type: "text", text: `Collection ${id} not found.` }], isError: true };
      }

      const updates = [];
      const args = [];

      if (name !== undefined) { updates.push("name = ?"); args.push(name); }
      if (description !== undefined) { updates.push("description = ?"); args.push(description); }
      if (visibility !== undefined) { updates.push("visibility = ?"); args.push(visibility); }
      if (languages !== undefined) { updates.push("languages = ?"); args.push(languages); }
      if (lan_enabled !== undefined) { updates.push("lan_enabled = ?"); args.push(lan_enabled ? 1 : 0); }

      if (updates.length === 0) {
        return { content: [{ type: "text", text: "No fields to update." }], isError: true };
      }

      updates.push("updated_at = datetime('now')");
      args.push(id);

      await db.execute({
        sql: `UPDATE kb_collections SET ${updates.join(", ")} WHERE id = ?`,
        args,
      });

      const updated = await db.execute({ sql: "SELECT * FROM kb_collections WHERE id = ?", args: [id] });
      return { content: [{ type: "text", text: JSON.stringify(updated.rows[0], null, 2) }] };
    }
  );

  // ─── Tool 2: crow_kb_create_article ───

  server.tool(
    "crow_kb_create_article",
    "Create a new article in a knowledge base collection. For multilingual pairs, create the first language version (pair_id auto-generated), then create the translation with the same pair_id.",
    {
      collection_id: z.number().int().positive().describe("Collection ID"),
      title: z.string().min(1).max(500).describe("Article title"),
      content: z.string().min(1).max(100000).describe("Article content in markdown"),
      language: z.string().max(10).optional().default("en").describe("ISO 639-1 language code"),
      pair_id: z.string().max(100).optional().describe("Pair ID to link translations. Omit for new article (auto-generated), provide to add a translation."),
      category_id: z.number().int().positive().optional().describe("Category ID"),
      excerpt: z.string().max(1000).optional().describe("Short excerpt/summary"),
      author: z.string().max(200).optional().describe("Author name"),
      tags: z.string().max(500).optional().describe("Comma-separated tags"),
    },
    async ({ collection_id, title, content, language, pair_id, category_id, excerpt, author, tags }) => {
      // Verify collection exists
      const col = await db.execute({ sql: "SELECT id FROM kb_collections WHERE id = ?", args: [collection_id] });
      if (col.rows.length === 0) {
        return { content: [{ type: "text", text: `Collection ${collection_id} not found.` }], isError: true };
      }

      // Verify category exists if provided
      if (category_id) {
        const cat = await db.execute({ sql: "SELECT id FROM kb_categories WHERE id = ? AND collection_id = ?", args: [category_id, collection_id] });
        if (cat.rows.length === 0) {
          return { content: [{ type: "text", text: `Category ${category_id} not found in collection ${collection_id}.` }], isError: true };
        }
      }

      const actualPairId = pair_id || randomUUID();
      const slug = slugify(title);
      if (!slug) {
        return { content: [{ type: "text", text: "Could not generate a valid slug from the title." }], isError: true };
      }

      try {
        const result = await db.execute({
          sql: `INSERT INTO kb_articles (collection_id, category_id, pair_id, language, slug, title, content, excerpt, author, tags)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [collection_id, category_id || null, actualPairId, language, slug, title, content, excerpt || null, author || null, tags || null],
        });

        const article = {
          id: Number(result.lastInsertRowid),
          collection_id,
          pair_id: actualPairId,
          language,
          slug,
          title,
          status: "draft",
        };

        // Check if paired translation exists
        const paired = await db.execute({
          sql: "SELECT id, language, title FROM kb_articles WHERE pair_id = ? AND id != ?",
          args: [actualPairId, article.id],
        });
        if (paired.rows.length > 0) {
          article.paired_with = paired.rows.map(r => ({ id: r.id, language: r.language, title: r.title }));
        }

        return { content: [{ type: "text", text: JSON.stringify(article, null, 2) }] };
      } catch (err) {
        if (err.message?.includes("UNIQUE constraint")) {
          return { content: [{ type: "text", text: `An article with this slug/language or pair_id/language combination already exists.` }], isError: true };
        }
        throw err;
      }
    }
  );

  // ─── Tool 3: crow_kb_edit_article ───

  server.tool(
    "crow_kb_edit_article",
    "Update an existing article's content or metadata.",
    {
      id: z.number().int().positive().describe("Article ID"),
      title: z.string().min(1).max(500).optional().describe("New title"),
      content: z.string().min(1).max(100000).optional().describe("New content (markdown)"),
      excerpt: z.string().max(1000).optional().describe("New excerpt"),
      author: z.string().max(200).optional().describe("New author"),
      tags: z.string().max(500).optional().describe("New tags (comma-separated)"),
      category_id: z.number().int().positive().optional().describe("New category ID"),
    },
    async ({ id, title, content, excerpt, author, tags, category_id }) => {
      const existing = await db.execute({ sql: "SELECT id, collection_id, slug FROM kb_articles WHERE id = ?", args: [id] });
      if (existing.rows.length === 0) {
        return { content: [{ type: "text", text: `Article ${id} not found.` }], isError: true };
      }

      const updates = [];
      const args = [];

      if (title !== undefined) {
        updates.push("title = ?");
        args.push(title);
        // Update slug if title changes
        const newSlug = slugify(title);
        if (newSlug) {
          updates.push("slug = ?");
          args.push(newSlug);
        }
      }
      if (content !== undefined) { updates.push("content = ?"); args.push(content); }
      if (excerpt !== undefined) { updates.push("excerpt = ?"); args.push(excerpt); }
      if (author !== undefined) { updates.push("author = ?"); args.push(author); }
      if (tags !== undefined) { updates.push("tags = ?"); args.push(tags); }
      if (category_id !== undefined) {
        const cat = await db.execute({
          sql: "SELECT id FROM kb_categories WHERE id = ? AND collection_id = ?",
          args: [category_id, existing.rows[0].collection_id],
        });
        if (cat.rows.length === 0) {
          return { content: [{ type: "text", text: `Category ${category_id} not found in this collection.` }], isError: true };
        }
        updates.push("category_id = ?");
        args.push(category_id);
      }

      if (updates.length === 0) {
        return { content: [{ type: "text", text: "No fields to update." }], isError: true };
      }

      updates.push("updated_at = datetime('now')");
      args.push(id);

      await db.execute({
        sql: `UPDATE kb_articles SET ${updates.join(", ")} WHERE id = ?`,
        args,
      });

      const updated = await db.execute({ sql: "SELECT id, title, slug, status, language, updated_at FROM kb_articles WHERE id = ?", args: [id] });
      return { content: [{ type: "text", text: JSON.stringify(updated.rows[0], null, 2) }] };
    }
  );

  // ─── Tool 4: crow_kb_publish_article ───

  server.tool(
    "crow_kb_publish_article",
    "Publish a draft article (makes it visible based on collection visibility). Uses a two-step confirmation: first call returns a preview and token, second call with the token executes.",
    {
      id: z.number().int().positive().describe("Article ID to publish"),
      confirm_token: z.string().max(100).optional().describe("Confirmation token from preview step"),
    },
    async ({ id, confirm_token }) => {
      const article = await db.execute({
        sql: `SELECT a.id, a.title, a.language, a.status, a.slug, c.name as collection_name, c.slug as collection_slug, c.visibility
              FROM kb_articles a JOIN kb_collections c ON a.collection_id = c.id
              WHERE a.id = ?`,
        args: [id],
      });
      if (article.rows.length === 0) {
        return { content: [{ type: "text", text: `Article ${id} not found.` }], isError: true };
      }

      const row = article.rows[0];

      if (row.status === "published") {
        return { content: [{ type: "text", text: `Article "${row.title}" is already published.` }] };
      }

      // Skip gates or handle two-step confirmation
      if (!shouldSkipGates() && !confirm_token) {
        const token = generateToken("publish_article", id);
        return {
          content: [{
            type: "text",
            text: `Ready to publish:\n\n- **Title:** ${row.title}\n- **Language:** ${row.language}\n- **Collection:** ${row.collection_name}\n- **Visibility:** ${row.visibility}\n\nCall again with confirm_token: "${token}" to publish.`,
          }],
        };
      }

      if (confirm_token && !shouldSkipGates()) {
        if (!validateToken(confirm_token, "publish_article", id)) {
          return { content: [{ type: "text", text: "Invalid or expired confirmation token." }], isError: true };
        }
      }

      await db.execute({
        sql: "UPDATE kb_articles SET status = 'published', published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
        args: [id],
      });

      try {
        await createNotification(db, {
          title: `Published: ${row.title} (${row.language.toUpperCase()})`,
          type: "system",
          source: "knowledge-base",
          action_url: `/kb/${row.collection_slug}/${row.slug}`,
        });
      } catch {}

      return { content: [{ type: "text", text: `Published "${row.title}" (${row.language.toUpperCase()}).` }] };
    }
  );

  // ─── Tool 5: crow_kb_delete_article ───

  server.tool(
    "crow_kb_delete_article",
    "Delete an article. Uses two-step confirmation.",
    {
      id: z.number().int().positive().describe("Article ID to delete"),
      confirm_token: z.string().max(100).optional().describe("Confirmation token from preview step"),
    },
    async ({ id, confirm_token }) => {
      const article = await db.execute({
        sql: "SELECT id, title, language, status FROM kb_articles WHERE id = ?",
        args: [id],
      });
      if (article.rows.length === 0) {
        return { content: [{ type: "text", text: `Article ${id} not found.` }], isError: true };
      }

      const row = article.rows[0];

      if (!shouldSkipGates() && !confirm_token) {
        const token = generateToken("delete_article", id);
        return {
          content: [{
            type: "text",
            text: `About to delete:\n\n- **Title:** ${row.title}\n- **Language:** ${row.language}\n- **Status:** ${row.status}\n\nThis will also delete all associated resources. Call again with confirm_token: "${token}" to confirm.`,
          }],
        };
      }

      if (confirm_token && !shouldSkipGates()) {
        if (!validateToken(confirm_token, "delete_article", id)) {
          return { content: [{ type: "text", text: "Invalid or expired confirmation token." }], isError: true };
        }
      }

      await db.execute({ sql: "DELETE FROM kb_articles WHERE id = ?", args: [id] });

      return { content: [{ type: "text", text: `Deleted article "${row.title}" (${row.language.toUpperCase()}).` }] };
    }
  );

  // ─── Tool 6: crow_kb_search ───

  server.tool(
    "crow_kb_search",
    "Full-text search across knowledge base articles.",
    {
      query: z.string().min(1).max(500).describe("Search query"),
      collection_id: z.number().int().positive().optional().describe("Filter by collection"),
      language: z.string().max(10).optional().describe("Filter by language code"),
      category_id: z.number().int().positive().optional().describe("Filter by category"),
      status: z.enum(["draft", "published", "archived"]).optional().describe("Filter by status"),
      limit: z.number().int().min(1).max(50).optional().default(20).describe("Max results"),
    },
    async ({ query, collection_id, language, category_id, status, limit }) => {
      const safeQuery = sanitizeFtsQuery(query);
      if (!safeQuery) {
        return { content: [{ type: "text", text: "No valid search terms found." }], isError: true };
      }

      let sql = `
        SELECT a.id, a.title, a.slug, a.language, a.status, a.pair_id, a.excerpt, a.tags,
               a.collection_id, a.category_id, a.published_at, a.last_verified_at,
               c.name AS collection_name, c.slug AS collection_slug
        FROM kb_articles a
        JOIN kb_articles_fts f ON a.id = f.rowid
        JOIN kb_collections c ON a.collection_id = c.id
        WHERE kb_articles_fts MATCH ?`;
      const args = [safeQuery];

      if (collection_id) { sql += " AND a.collection_id = ?"; args.push(collection_id); }
      if (language) { sql += " AND a.language = ?"; args.push(language); }
      if (category_id) { sql += " AND a.category_id = ?"; args.push(category_id); }
      if (status) { sql += " AND a.status = ?"; args.push(status); }

      sql += " ORDER BY rank LIMIT ?";
      args.push(limit);

      const results = await db.execute({ sql, args });

      if (results.rows.length === 0) {
        return { content: [{ type: "text", text: `No results found for "${query}".` }] };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ query, count: results.rows.length, results: results.rows }, null, 2),
        }],
      };
    }
  );

  // ─── Tool 7: crow_kb_list_articles ───

  server.tool(
    "crow_kb_list_articles",
    "List knowledge base articles with optional filtering.",
    {
      collection_id: z.number().int().positive().optional().describe("Filter by collection"),
      category_id: z.number().int().positive().optional().describe("Filter by category"),
      language: z.string().max(10).optional().describe("Filter by language"),
      status: z.enum(["draft", "published", "archived"]).optional().describe("Filter by status"),
      limit: z.number().int().min(1).max(100).optional().default(50).describe("Max results"),
      offset: z.number().int().min(0).optional().default(0).describe("Offset for pagination"),
    },
    async ({ collection_id, category_id, language, status, limit, offset }) => {
      let sql = `
        SELECT a.id, a.title, a.slug, a.language, a.status, a.pair_id, a.excerpt, a.tags,
               a.collection_id, a.category_id, a.published_at, a.last_verified_at, a.updated_at,
               c.name AS collection_name, c.slug AS collection_slug
        FROM kb_articles a
        JOIN kb_collections c ON a.collection_id = c.id
        WHERE 1=1`;
      const args = [];

      if (collection_id) { sql += " AND a.collection_id = ?"; args.push(collection_id); }
      if (category_id) { sql += " AND a.category_id = ?"; args.push(category_id); }
      if (language) { sql += " AND a.language = ?"; args.push(language); }
      if (status) { sql += " AND a.status = ?"; args.push(status); }

      sql += " ORDER BY a.updated_at DESC LIMIT ? OFFSET ?";
      args.push(limit, offset);

      const results = await db.execute({ sql, args });

      // Get total count
      let countSql = "SELECT COUNT(*) AS total FROM kb_articles WHERE 1=1";
      const countArgs = [];
      if (collection_id) { countSql += " AND collection_id = ?"; countArgs.push(collection_id); }
      if (category_id) { countSql += " AND category_id = ?"; countArgs.push(category_id); }
      if (language) { countSql += " AND language = ?"; countArgs.push(language); }
      if (status) { countSql += " AND status = ?"; countArgs.push(status); }
      const countResult = await db.execute({ sql: countSql, args: countArgs });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total: countResult.rows[0]?.total || 0,
            offset,
            limit,
            articles: results.rows,
          }, null, 2),
        }],
      };
    }
  );

  // ─── Tool 8: crow_kb_import_article ───

  server.tool(
    "crow_kb_import_article",
    "Import text or markdown content as a new knowledge base article. Use this to bulk-import existing guides.",
    {
      collection_id: z.number().int().positive().describe("Collection ID"),
      title: z.string().min(1).max(500).describe("Article title"),
      content: z.string().min(1).max(100000).describe("Article content (markdown or plain text)"),
      language: z.string().max(10).optional().default("en").describe("ISO 639-1 language code"),
      pair_id: z.string().max(100).optional().describe("Pair ID to link with existing translation"),
      category_id: z.number().int().positive().optional().describe("Category ID"),
      excerpt: z.string().max(1000).optional().describe("Short summary"),
      author: z.string().max(200).optional().describe("Author name"),
      tags: z.string().max(500).optional().describe("Comma-separated tags"),
      auto_publish: z.boolean().optional().default(false).describe("Publish immediately after import"),
    },
    async ({ collection_id, title, content, language, pair_id, category_id, excerpt, author, tags, auto_publish }) => {
      // Verify collection
      const col = await db.execute({ sql: "SELECT id FROM kb_collections WHERE id = ?", args: [collection_id] });
      if (col.rows.length === 0) {
        return { content: [{ type: "text", text: `Collection ${collection_id} not found.` }], isError: true };
      }

      const actualPairId = pair_id || randomUUID();
      const slug = slugify(title);
      if (!slug) {
        return { content: [{ type: "text", text: "Could not generate a valid slug from the title." }], isError: true };
      }

      const status = auto_publish ? "published" : "draft";
      const publishedAt = auto_publish ? new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "") : null;

      try {
        const result = await db.execute({
          sql: `INSERT INTO kb_articles (collection_id, category_id, pair_id, language, slug, title, content, excerpt, author, tags, status, published_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [collection_id, category_id || null, actualPairId, language, slug, title, content, excerpt || null, author || null, tags || null, status, publishedAt],
        });

        const article = {
          id: Number(result.lastInsertRowid),
          collection_id,
          pair_id: actualPairId,
          language,
          slug,
          title,
          status,
          content_length: content.length,
        };

        return { content: [{ type: "text", text: `Imported article:\n${JSON.stringify(article, null, 2)}` }] };
      } catch (err) {
        if (err.message?.includes("UNIQUE constraint")) {
          return { content: [{ type: "text", text: `An article with this slug/language or pair_id/language already exists. Use a different title or pair_id.` }], isError: true };
        }
        throw err;
      }
    }
  );

  // ─── Tool 9: crow_kb_manage_resources ───

  server.tool(
    "crow_kb_manage_resources",
    "Manage structured resource entries for a knowledge base article. Actions: add, edit, list, delete, flag (AI marks as potentially outdated), verify (human confirms current), dismiss (dismiss a flag).",
    {
      action: z.enum(["add", "edit", "list", "delete", "flag", "verify", "dismiss"]).describe("Action to perform"),
      article_id: z.number().int().positive().optional().describe("Article ID (required for add, list)"),
      resource_id: z.number().int().positive().optional().describe("Resource ID (required for edit, delete, flag, verify, dismiss)"),
      name: z.string().max(500).optional().describe("Resource/organization name"),
      phone: z.string().max(100).optional().describe("Phone number"),
      address: z.string().max(500).optional().describe("Physical address"),
      website: z.string().max(1000).optional().describe("Website URL"),
      hours: z.string().max(500).optional().describe("Operating hours"),
      eligibility: z.string().max(2000).optional().describe("Eligibility criteria"),
      notes: z.string().max(2000).optional().describe("Additional notes"),
      sort_order: z.number().int().optional().describe("Display order"),
      flag_reason: z.string().max(1000).optional().describe("Why this resource may be outdated (required for flag action)"),
      verified_by: z.string().max(200).optional().describe("Who verified (for verify action)"),
    },
    async (params) => {
      const { action, article_id, resource_id } = params;

      // --- LIST ---
      if (action === "list") {
        if (!article_id) {
          return { content: [{ type: "text", text: "article_id is required for list action." }], isError: true };
        }
        const resources = await db.execute({
          sql: `SELECT * FROM kb_resources WHERE article_id = ? ORDER BY sort_order, id`,
          args: [article_id],
        });
        return { content: [{ type: "text", text: JSON.stringify({ article_id, count: resources.rows.length, resources: resources.rows }, null, 2) }] };
      }

      // --- ADD ---
      if (action === "add") {
        if (!article_id || !params.name) {
          return { content: [{ type: "text", text: "article_id and name are required for add action." }], isError: true };
        }
        // Verify article exists
        const art = await db.execute({ sql: "SELECT id FROM kb_articles WHERE id = ?", args: [article_id] });
        if (art.rows.length === 0) {
          return { content: [{ type: "text", text: `Article ${article_id} not found.` }], isError: true };
        }

        const result = await db.execute({
          sql: `INSERT INTO kb_resources (article_id, name, phone, address, website, hours, eligibility, notes, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [article_id, params.name, params.phone || null, params.address || null, params.website || null,
                 params.hours || null, params.eligibility || null, params.notes || null, params.sort_order || 0],
        });

        return { content: [{ type: "text", text: `Added resource "${params.name}" (ID: ${Number(result.lastInsertRowid)}).` }] };
      }

      // --- EDIT ---
      if (action === "edit") {
        if (!resource_id) {
          return { content: [{ type: "text", text: "resource_id is required for edit action." }], isError: true };
        }
        const existing = await db.execute({ sql: "SELECT id, article_id FROM kb_resources WHERE id = ?", args: [resource_id] });
        if (existing.rows.length === 0) {
          return { content: [{ type: "text", text: `Resource ${resource_id} not found.` }], isError: true };
        }

        const updates = [];
        const args = [];
        for (const field of ["name", "phone", "address", "website", "hours", "eligibility", "notes"]) {
          if (params[field] !== undefined) { updates.push(`${field} = ?`); args.push(params[field]); }
        }
        if (params.sort_order !== undefined) { updates.push("sort_order = ?"); args.push(params.sort_order); }

        if (updates.length === 0) {
          return { content: [{ type: "text", text: "No fields to update." }], isError: true };
        }

        updates.push("updated_at = datetime('now')");
        args.push(resource_id);

        await db.execute({ sql: `UPDATE kb_resources SET ${updates.join(", ")} WHERE id = ?`, args });

        // Log the update
        await db.execute({
          sql: `INSERT INTO kb_review_log (resource_id, article_id, action, details, reviewed_by)
                VALUES (?, ?, 'updated', ?, ?)`,
          args: [resource_id, existing.rows[0].article_id, `Updated fields: ${updates.filter(u => !u.includes("updated_at")).map(u => u.split(" = ")[0]).join(", ")}`, params.verified_by || "ai"],
        });

        return { content: [{ type: "text", text: `Updated resource ${resource_id}.` }] };
      }

      // --- DELETE ---
      if (action === "delete") {
        if (!resource_id) {
          return { content: [{ type: "text", text: "resource_id is required for delete action." }], isError: true };
        }
        const existing = await db.execute({ sql: "SELECT id, name FROM kb_resources WHERE id = ?", args: [resource_id] });
        if (existing.rows.length === 0) {
          return { content: [{ type: "text", text: `Resource ${resource_id} not found.` }], isError: true };
        }
        await db.execute({ sql: "DELETE FROM kb_resources WHERE id = ?", args: [resource_id] });
        return { content: [{ type: "text", text: `Deleted resource "${existing.rows[0].name}".` }] };
      }

      // --- FLAG ---
      if (action === "flag") {
        if (!resource_id || !params.flag_reason) {
          return { content: [{ type: "text", text: "resource_id and flag_reason are required for flag action." }], isError: true };
        }
        const existing = await db.execute({ sql: "SELECT id, name, article_id FROM kb_resources WHERE id = ?", args: [resource_id] });
        if (existing.rows.length === 0) {
          return { content: [{ type: "text", text: `Resource ${resource_id} not found.` }], isError: true };
        }

        await db.execute({
          sql: "UPDATE kb_resources SET flagged = 1, flag_reason = ?, flagged_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
          args: [params.flag_reason, resource_id],
        });

        await db.execute({
          sql: `INSERT INTO kb_review_log (resource_id, article_id, action, details)
                VALUES (?, ?, 'flagged', ?)`,
          args: [resource_id, existing.rows[0].article_id, params.flag_reason],
        });

        try {
          await createNotification(db, {
            title: `Flagged: ${existing.rows[0].name} — ${params.flag_reason}`,
            type: "system",
            source: "knowledge-base",
          });
        } catch {}

        return { content: [{ type: "text", text: `Flagged resource "${existing.rows[0].name}" for review: ${params.flag_reason}` }] };
      }

      // --- VERIFY ---
      if (action === "verify") {
        if (!resource_id) {
          return { content: [{ type: "text", text: "resource_id is required for verify action." }], isError: true };
        }
        const existing = await db.execute({ sql: "SELECT id, name, article_id FROM kb_resources WHERE id = ?", args: [resource_id] });
        if (existing.rows.length === 0) {
          return { content: [{ type: "text", text: `Resource ${resource_id} not found.` }], isError: true };
        }

        await db.execute({
          sql: `UPDATE kb_resources SET flagged = 0, flag_reason = NULL, flagged_at = NULL,
                last_verified_at = datetime('now'), verified_by = ?, updated_at = datetime('now') WHERE id = ?`,
          args: [params.verified_by || "user", resource_id],
        });

        await db.execute({
          sql: `INSERT INTO kb_review_log (resource_id, article_id, action, reviewed_by)
                VALUES (?, ?, 'verified', ?)`,
          args: [resource_id, existing.rows[0].article_id, params.verified_by || "user"],
        });

        return { content: [{ type: "text", text: `Verified resource "${existing.rows[0].name}" as current.` }] };
      }

      // --- DISMISS ---
      if (action === "dismiss") {
        if (!resource_id) {
          return { content: [{ type: "text", text: "resource_id is required for dismiss action." }], isError: true };
        }
        const existing = await db.execute({ sql: "SELECT id, name, article_id FROM kb_resources WHERE id = ?", args: [resource_id] });
        if (existing.rows.length === 0) {
          return { content: [{ type: "text", text: `Resource ${resource_id} not found.` }], isError: true };
        }

        await db.execute({
          sql: "UPDATE kb_resources SET flagged = 0, flag_reason = NULL, flagged_at = NULL, updated_at = datetime('now') WHERE id = ?",
          args: [resource_id],
        });

        await db.execute({
          sql: `INSERT INTO kb_review_log (resource_id, article_id, action, details, reviewed_by)
                VALUES (?, ?, 'dismissed', 'Flag dismissed', ?)`,
          args: [resource_id, existing.rows[0].article_id, params.verified_by || "user"],
        });

        return { content: [{ type: "text", text: `Dismissed flag on resource "${existing.rows[0].name}".` }] };
      }

      return { content: [{ type: "text", text: `Unknown action: ${action}` }], isError: true };
    }
  );

  // ─── Tool 10: crow_kb_review_flags ───

  server.tool(
    "crow_kb_review_flags",
    "List resources that have been flagged as potentially outdated, awaiting human review.",
    {
      collection_id: z.number().int().positive().optional().describe("Filter by collection"),
      limit: z.number().int().min(1).max(100).optional().default(20).describe("Max results"),
    },
    async ({ collection_id, limit }) => {
      let sql = `
        SELECT r.id, r.name, r.phone, r.address, r.website, r.hours, r.eligibility,
               r.flag_reason, r.flagged_at, r.last_verified_at,
               a.id AS article_id, a.title AS article_title, a.language, a.slug AS article_slug,
               c.id AS collection_id, c.name AS collection_name
        FROM kb_resources r
        JOIN kb_articles a ON r.article_id = a.id
        JOIN kb_collections c ON a.collection_id = c.id
        WHERE r.flagged = 1`;
      const args = [];

      if (collection_id) { sql += " AND a.collection_id = ?"; args.push(collection_id); }

      sql += " ORDER BY r.flagged_at DESC LIMIT ?";
      args.push(limit);

      const results = await db.execute({ sql, args });

      if (results.rows.length === 0) {
        return { content: [{ type: "text", text: "No flagged resources found." }] };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ flagged_count: results.rows.length, flagged_resources: results.rows }, null, 2),
        }],
      };
    }
  );

  return server;
}
