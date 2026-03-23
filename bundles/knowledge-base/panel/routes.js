/**
 * Knowledge Base Dashboard API Routes
 *
 * Auth-protected endpoints for managing KB content from the Crow's Nest panel.
 * Mounted behind dashboardAuth by the panel registry system.
 */

import { Router } from "express";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let createDbClient;
try {
  const dbMod = await import(pathToFileURL(resolve(__dirname, "../server/db.js")).href);
  createDbClient = dbMod.createDbClient;
} catch {
  createDbClient = null;
}

export default function kbDashboardRouter() {
  const router = Router();
  let db;

  router.use(async (req, res, next) => {
    if (!db && createDbClient) db = createDbClient();
    if (!db) return res.status(500).json({ error: "Database not available" });
    next();
  });

  // --- Collections ---

  router.get("/api/kb/collections", async (req, res) => {
    try {
      const result = await db.execute({ sql: "SELECT * FROM kb_collections ORDER BY name", args: [] });
      res.json({ collections: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/api/kb/collections", async (req, res) => {
    try {
      const { name, description, languages, default_language, visibility, lan_enabled } = req.body;
      if (!name) return res.status(400).json({ error: "name is required" });

      const slug = name.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 200);
      await db.execute({
        sql: `INSERT INTO kb_collections (slug, name, description, default_language, languages, visibility, lan_enabled)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [slug, name, description || null, default_language || "en", languages || "en,es", visibility || "private", lan_enabled ? 1 : 0],
      });
      res.json({ ok: true, slug });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Articles ---

  router.get("/api/kb/articles", async (req, res) => {
    try {
      const { collection_id, status, language, limit = 50, offset = 0 } = req.query;
      let sql = `SELECT a.*, c.name AS collection_name, c.slug AS collection_slug
                 FROM kb_articles a JOIN kb_collections c ON a.collection_id = c.id WHERE 1=1`;
      const args = [];

      if (collection_id) { sql += " AND a.collection_id = ?"; args.push(Number(collection_id)); }
      if (status) { sql += " AND a.status = ?"; args.push(status); }
      if (language) { sql += " AND a.language = ?"; args.push(language); }

      sql += ` ORDER BY a.updated_at DESC LIMIT ? OFFSET ?`;
      args.push(Number(limit), Number(offset));

      const result = await db.execute({ sql, args });
      res.json({ articles: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/api/kb/articles/:id", async (req, res) => {
    try {
      const result = await db.execute({
        sql: `SELECT a.*, c.name AS collection_name
              FROM kb_articles a JOIN kb_collections c ON a.collection_id = c.id
              WHERE a.id = ?`,
        args: [Number(req.params.id)],
      });
      if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });

      // Get paired translations
      const translations = await db.execute({
        sql: "SELECT id, language, title, status FROM kb_articles WHERE pair_id = ? AND id != ?",
        args: [result.rows[0].pair_id, result.rows[0].id],
      });

      // Get resources
      const resources = await db.execute({
        sql: "SELECT * FROM kb_resources WHERE article_id = ? ORDER BY sort_order, id",
        args: [Number(req.params.id)],
      });

      res.json({
        article: result.rows[0],
        translations: translations.rows,
        resources: resources.rows,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Categories ---

  router.get("/api/kb/categories", async (req, res) => {
    try {
      const { collection_id } = req.query;
      if (!collection_id) return res.status(400).json({ error: "collection_id is required" });

      const result = await db.execute({
        sql: `SELECT c.id, c.slug, c.sort_order, c.icon,
              GROUP_CONCAT(n.language || ':' || n.name, '|') AS names
              FROM kb_categories c
              LEFT JOIN kb_category_names n ON c.id = n.category_id
              WHERE c.collection_id = ?
              GROUP BY c.id ORDER BY c.sort_order, c.slug`,
        args: [Number(collection_id)],
      });
      res.json({ categories: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/api/kb/categories", async (req, res) => {
    try {
      const { collection_id, slug, sort_order, icon, names } = req.body;
      if (!collection_id || !slug) return res.status(400).json({ error: "collection_id and slug required" });

      const result = await db.execute({
        sql: "INSERT INTO kb_categories (collection_id, slug, sort_order, icon) VALUES (?, ?, ?, ?)",
        args: [collection_id, slug, sort_order || 0, icon || null],
      });
      const categoryId = Number(result.lastInsertRowid);

      // Insert localized names
      if (names && typeof names === "object") {
        for (const [lang, name] of Object.entries(names)) {
          await db.execute({
            sql: "INSERT INTO kb_category_names (category_id, language, name) VALUES (?, ?, ?)",
            args: [categoryId, lang, name],
          });
        }
      }

      res.json({ ok: true, id: categoryId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Flags ---

  router.get("/api/kb/flags", async (req, res) => {
    try {
      const result = await db.execute({
        sql: `SELECT r.*, a.title AS article_title, a.language, a.slug AS article_slug,
              c.name AS collection_name
              FROM kb_resources r
              JOIN kb_articles a ON r.article_id = a.id
              JOIN kb_collections c ON a.collection_id = c.id
              WHERE r.flagged = 1
              ORDER BY r.flagged_at DESC LIMIT 100`,
        args: [],
      });
      res.json({ flags: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/api/kb/flags/:id/resolve", async (req, res) => {
    try {
      const { action } = req.body; // "verify" or "dismiss"
      const id = Number(req.params.id);

      if (action === "verify") {
        await db.execute({
          sql: `UPDATE kb_resources SET flagged = 0, flag_reason = NULL, flagged_at = NULL,
                last_verified_at = datetime('now'), verified_by = 'dashboard', updated_at = datetime('now') WHERE id = ?`,
          args: [id],
        });
      } else {
        await db.execute({
          sql: "UPDATE kb_resources SET flagged = 0, flag_reason = NULL, flagged_at = NULL, updated_at = datetime('now') WHERE id = ?",
          args: [id],
        });
      }

      const resource = await db.execute({ sql: "SELECT article_id FROM kb_resources WHERE id = ?", args: [id] });
      if (resource.rows.length > 0) {
        await db.execute({
          sql: "INSERT INTO kb_review_log (resource_id, article_id, action, reviewed_by) VALUES (?, ?, ?, 'dashboard')",
          args: [id, resource.rows[0].article_id, action === "verify" ? "verified" : "dismissed"],
        });
      }

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
