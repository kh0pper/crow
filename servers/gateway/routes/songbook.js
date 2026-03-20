/**
 * Songbook Public Routes
 *
 * GET /blog/songbook           — Songbook index (published songs)
 * GET /blog/songbook/:slug     — Individual song page (?key=G&instrument=piano)
 * GET /blog/songbook/setlist/:id — Setlist view
 */

import { Router } from "express";
import { createDbClient, escapeLikePattern } from "../../db.js";
import { renderSongPage, renderSongbookIndex, renderSetlistPage } from "../../blog/songbook-renderer.js";

/**
 * Get blog settings from dashboard_settings table.
 */
async function getBlogSettings(db) {
  const result = await db.execute({
    sql: "SELECT key, value FROM dashboard_settings WHERE key LIKE 'blog_%'",
    args: [],
  });
  const s = {};
  for (const r of result.rows) s[r.key.replace("blog_", "")] = r.value;
  return {
    title: s.title || "Crow Blog",
    tagline: s.tagline || "",
    author: s.author || "",
    theme: s.theme || "dark",
    themeMode: s.theme_mode || "dark",
    themeGlass: s.theme_glass === "true",
    themeSerif: s.theme_serif !== "false",
    themeBlogMode: s.theme_blog_mode || "",
  };
}

/**
 * @returns {Router}
 */
export default function songbookRouter() {
  const router = Router();

  // GET /blog/songbook/setlist/:id — Setlist view (must be before :slug)
  router.get("/blog/songbook/setlist/:id", async (req, res) => {
    const db = createDbClient();
    try {
      const settings = await getBlogSettings(db);
      const setlistId = parseInt(req.params.id, 10);
      if (isNaN(setlistId)) {
        return res.status(404).send("Setlist not found");
      }

      const setlist = await db.execute({
        sql: "SELECT * FROM songbook_setlists WHERE id = ?",
        args: [setlistId],
      });

      if (setlist.rows.length === 0) {
        return res.status(404).send("Setlist not found");
      }

      // Only show public setlists (or all for now since no auth on songbook)
      const s = setlist.rows[0];
      if (s.visibility === "private") {
        return res.status(404).send("Setlist not found");
      }

      const items = await db.execute({
        sql: `SELECT si.*, bp.title, bp.slug, bp.content, bp.author
              FROM songbook_setlist_items si
              JOIN blog_posts bp ON bp.id = si.post_id
              WHERE si.setlist_id = ? AND bp.status = 'published'
              ORDER BY si.position`,
        args: [setlistId],
      });

      const html = renderSetlistPage(s, items.rows, { blogSettings: settings });
      res.type("html").send(html);
    } catch (err) {
      console.error("[songbook] Setlist page error:", err);
      res.status(500).send("Error loading setlist");
    } finally {
      db.close();
    }
  });

  // GET /blog/songbook — Index
  router.get("/blog/songbook", async (req, res) => {
    const db = createDbClient();
    try {
      const settings = await getBlogSettings(db);
      const escaped = escapeLikePattern("songbook");

      const posts = await db.execute({
        sql: `SELECT id, slug, title, content, author, tags, published_at
              FROM blog_posts
              WHERE status = 'published' AND visibility = 'public'
              AND tags LIKE ? ESCAPE '\\'
              ORDER BY published_at DESC
              LIMIT 100`,
        args: [`%${escaped}%`],
      });

      const html = renderSongbookIndex(posts.rows, { blogSettings: settings });
      res.type("html").send(html);
    } catch (err) {
      console.error("[songbook] Index error:", err);
      res.status(500).send("Error loading songbook");
    } finally {
      db.close();
    }
  });

  // GET /blog/songbook/:slug — Individual song
  router.get("/blog/songbook/:slug", async (req, res) => {
    const db = createDbClient();
    try {
      const settings = await getBlogSettings(db);
      const slug = req.params.slug;

      const result = await db.execute({
        sql: "SELECT * FROM blog_posts WHERE slug = ? AND status = 'published' AND visibility = 'public'",
        args: [slug],
      });

      if (result.rows.length === 0) {
        return res.status(404).send("Song not found");
      }

      const post = result.rows[0];
      const targetKey = req.query.key || undefined;
      const instrument = req.query.instrument === "piano" ? "piano" : "guitar";

      const html = renderSongPage(post, {
        targetKey,
        instrument,
        blogSettings: settings,
      });

      res.type("html").send(html);
    } catch (err) {
      console.error("[songbook] Song page error:", err);
      res.status(500).send("Error loading song");
    } finally {
      db.close();
    }
  });

  return router;
}
