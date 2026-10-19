/**
 * Songbook Public Routes
 *
 * GET /blog/songbook           — Songbook index (published songs)
 * GET /blog/songbook/lib/:file — SunVox player engine assets (whitelisted)
 * GET /blog/songbook/:slug     — Individual song page (?key=G&instrument=piano)
 * GET /blog/songbook/setlist/:id — Setlist view
 */

import { Router } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createDbClient, escapeLikePattern } from "../../db.js";
import { renderSongPage, renderSongbookIndex, renderSetlistPage } from "../../blog/songbook-renderer.js";
import { BUNDLES_DIR, APP_BUNDLES } from "../bundles-config.js";

/**
 * SunVox player engine assets (MIT — see bundles/songbook/web/sunvox/LICENSE.txt),
 * pinned to libsunvox 2.1.4d. Exact-filename whitelist: anything else 404s,
 * so this route can never serve arbitrary bundle files.
 */
export const SUNVOX_LIB_FILES = {
  "sunvox.js": "application/javascript; charset=utf-8",
  "sunvox_lib_loader.js": "application/javascript; charset=utf-8",
  "sunvox.wasm": "application/wasm",
  // The upstream terms travel with the engine: song pages hand the binaries
  // to every visitor, so the licences are served beside them (linked from the
  // player card's "Powered by SunVox" line).
  "LICENSE.txt": "text/plain; charset=utf-8",
  "THIRD-PARTY-NOTICES.txt": "text/plain; charset=utf-8",
};

/** Resolve a whitelisted lib file, installed bundle first, repo fallback. */
export function resolveSunvoxLibFile(file) {
  if (!Object.hasOwn(SUNVOX_LIB_FILES, file)) return null;
  for (const base of [join(BUNDLES_DIR, "songbook"), join(APP_BUNDLES, "songbook")]) {
    const p = join(base, "web", "sunvox", file);
    if (existsSync(p)) return p;
  }
  return null;
}

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
    themeSerif: s.theme_serif !== "false",
    themeBlogMode: s.theme_blog_mode || "",
  };
}

/**
 * @returns {Router}
 */
export default function songbookRouter() {
  const router = Router();

  // GET /blog/songbook/lib/:file — SunVox engine assets (must be before :slug)
  router.get("/blog/songbook/lib/:file", (req, res) => {
    const p = resolveSunvoxLibFile(req.params.file);
    if (!p) return res.status(404).send("Not found");
    res.set("Content-Type", SUNVOX_LIB_FILES[req.params.file]);
    res.set("Cache-Control", "public, max-age=86400");
    res.set("X-Robots-Tag", "noindex");
    res.sendFile(p);
  });

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

      if (posts.rows.length === 0) {
        return res.status(404).send("Not found");
      }

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
