/**
 * Media API Routes — Express router for Crow's Nest media panel
 *
 * Bundle-compatible version: uses dynamic imports with path resolution
 * so this routes file works both from the repo and when installed
 * to ~/.crow/bundles/media/.
 *
 * Protected by dashboardAuth. Provides feed, article, and source
 * endpoints consumed by the media dashboard panel.
 */

import { Router } from "express";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

// Resolve bundle server directory (installed vs repo)
function resolveBundleServer() {
  const installed = join(homedir(), ".crow", "bundles", "media", "server");
  if (existsSync(installed)) return installed;
  // Fallback: panel is in bundles/media/panel/, server is in bundles/media/server/
  return join(import.meta.dirname, "..", "server");
}

// Resolve the main crow db.js (for createDbClient, sanitizeFtsQuery, escapeLikePattern)
function resolveDbModule() {
  // When running from the repo, db.js is at servers/db.js relative to repo root
  // The panel lives at bundles/media/panel/, so repo root is ../../../
  const repoPath = join(import.meta.dirname, "..", "..", "..", "servers", "db.js");
  if (existsSync(repoPath)) return repoPath;
  // Fallback: try the installed bundle's copy if it ships one
  const bundlePath = join(resolveBundleServer(), "db.js");
  if (existsSync(bundlePath)) return bundlePath;
  return repoPath; // let it fail with a clear path
}

const serverDir = resolveBundleServer();
const dbModulePath = resolveDbModule();

const { createDbClient, sanitizeFtsQuery, escapeLikePattern } = await import(pathToFileURL(dbModulePath).href);

/**
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {Router}
 */
export default function mediaRouter(authMiddleware) {
  const router = Router();

  /** Dynamically import a module from the bundle's server directory */
  async function importBundleModule(name) {
    return import(pathToFileURL(join(serverDir, name)).href);
  }

  // --- Feed (paginated) ---
  router.get("/api/media/feed", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const limit = Math.min(parseInt(req.query.limit || "20", 10), 50);
      const offset = parseInt(req.query.offset || "0", 10);
      const category = req.query.category || null;
      const sourceId = req.query.source_id ? parseInt(req.query.source_id, 10) : null;
      const unreadOnly = req.query.unread_only === "true";
      const starredOnly = req.query.starred_only === "true";
      const sort = req.query.sort || "chronological";

      // For You — use scored query
      if (sort === "for_you") {
        try {
          const { buildScoredFeedSql } = await importBundleModule("scorer.js");
          const scored = buildScoredFeedSql({
            limit, offset, category, sourceId,
            unreadOnly, starredOnly,
          });
          const result = await db.execute({ sql: scored.sql, args: scored.args });
          return res.json({ articles: result.rows, limit, offset, sort });
        } catch {
          // Fall through to chronological
        }
      }

      let sql = `SELECT a.id, a.title, a.author, a.pub_date, a.url, a.summary, a.image_url,
                        s.name as source_name, s.category as source_category,
                        COALESCE(st.is_read, 0) as is_read,
                        COALESCE(st.is_starred, 0) as is_starred,
                        COALESCE(st.is_saved, 0) as is_saved
                 FROM media_articles a
                 JOIN media_sources s ON s.id = a.source_id
                 LEFT JOIN media_article_states st ON st.article_id = a.id
                 WHERE s.enabled = 1`;
      const args = [];

      if (category) {
        sql += " AND s.category = ?";
        args.push(category);
      }
      if (sourceId) {
        sql += " AND a.source_id = ?";
        args.push(sourceId);
      }
      if (unreadOnly) sql += " AND COALESCE(st.is_read, 0) = 0";
      if (starredOnly) sql += " AND COALESCE(st.is_starred, 0) = 1";

      sql += " ORDER BY a.pub_date DESC NULLS LAST, a.created_at DESC LIMIT ? OFFSET ?";
      args.push(limit, offset);

      const result = await db.execute({ sql, args });
      res.json({ articles: result.rows, limit, offset });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Single article ---
  router.get("/api/media/articles/:id", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const id = parseInt(req.params.id, 10);
      const result = await db.execute({
        sql: `SELECT a.*, s.name as source_name, s.category as source_category,
                     COALESCE(st.is_read, 0) as is_read,
                     COALESCE(st.is_starred, 0) as is_starred,
                     COALESCE(st.is_saved, 0) as is_saved
              FROM media_articles a
              JOIN media_sources s ON s.id = a.source_id
              LEFT JOIN media_article_states st ON st.article_id = a.id
              WHERE a.id = ?`,
        args: [id],
      });

      if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });

      // Mark as read
      await db.execute({
        sql: `INSERT INTO media_article_states (article_id, is_read, read_at)
              VALUES (?, 1, datetime('now'))
              ON CONFLICT(article_id) DO UPDATE SET is_read = 1, read_at = datetime('now')`,
        args: [id],
      });

      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Article action (star/save/read/feedback) ---
  router.post("/api/media/articles/:id/action", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const id = parseInt(req.params.id, 10);
      const { action } = req.body;

      // Ensure state row exists
      await db.execute({
        sql: "INSERT OR IGNORE INTO media_article_states (article_id) VALUES (?)",
        args: [id],
      });

      const actions = {
        star: "UPDATE media_article_states SET is_starred = 1 WHERE article_id = ?",
        unstar: "UPDATE media_article_states SET is_starred = 0 WHERE article_id = ?",
        save: "UPDATE media_article_states SET is_saved = 1 WHERE article_id = ?",
        unsave: "UPDATE media_article_states SET is_saved = 0 WHERE article_id = ?",
        mark_read: "UPDATE media_article_states SET is_read = 1, read_at = datetime('now') WHERE article_id = ?",
        mark_unread: "UPDATE media_article_states SET is_read = 0, read_at = NULL WHERE article_id = ?",
      };

      if (actions[action]) {
        await db.execute({ sql: actions[action], args: [id] });
      } else if (action === "thumbs_up" || action === "thumbs_down") {
        await db.execute({
          sql: "INSERT INTO media_feedback (article_id, feedback) VALUES (?, ?)",
          args: [id, action === "thumbs_up" ? "up" : "down"],
        });
      } else {
        return res.status(400).json({ error: "Invalid action" });
      }

      // Update interest profiles for personalization
      try {
        const { updateInterestProfile } = await importBundleModule("scorer.js");
        await updateInterestProfile(db, id, action);
      } catch {}

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Search ---
  router.get("/api/media/search", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const query = req.query.q;
      if (!query) return res.status(400).json({ error: "Missing query parameter 'q'" });

      const safeQuery = sanitizeFtsQuery(query);
      if (!safeQuery) return res.status(400).json({ error: "Invalid search query" });

      const limit = Math.min(parseInt(req.query.limit || "20", 10), 50);

      const result = await db.execute({
        sql: `SELECT a.id, a.title, a.author, a.pub_date, a.url, a.summary, a.image_url,
                     s.name as source_name, s.category as source_category
              FROM media_articles a
              JOIN media_articles_fts fts ON a.id = fts.rowid
              JOIN media_sources s ON s.id = a.source_id
              WHERE fts.media_articles_fts MATCH ?
              ORDER BY rank LIMIT ?`,
        args: [safeQuery, limit],
      });

      res.json({ results: result.rows, query });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Sources CRUD ---
  router.get("/api/media/sources", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const result = await db.execute("SELECT * FROM media_sources ORDER BY name ASC");
      res.json({ sources: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  router.post("/api/media/sources", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const { url, name, category } = req.body;
      if (!url) return res.status(400).json({ error: "URL is required" });

      const { fetchAndParseFeed } = await importBundleModule("feed-fetcher.js");
      const { feed, items } = await fetchAndParseFeed(url);
      const sourceName = name || feed.title || url;

      const sourceType = feed.isPodcast ? 'podcast' : 'rss';
      const result = await db.execute({
        sql: `INSERT INTO media_sources (source_type, name, url, category, last_fetched, config)
              VALUES (?, ?, ?, ?, datetime('now'), ?)`,
        args: [sourceType, sourceName, url, category || null, JSON.stringify({ image: feed.image })],
      });

      const sourceId = result.lastInsertRowid;

      let imported = 0;
      for (const item of items.slice(0, 100)) {
        const guid = item.guid || item.link || item.title;
        if (!guid) continue;
        try {
          const ins = await db.execute({
            sql: `INSERT OR IGNORE INTO media_articles
                  (source_id, guid, url, title, author, pub_date, content_raw, summary, image_url,
                   audio_url, source_url, content_fetch_status, ai_analysis_status, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', datetime('now'))`,
            args: [sourceId, guid, item.link || null, item.title, item.author || null,
                   item.pub_date || null, item.content || null, item.summary?.slice(0, 2000) || null,
                   item.image || null, item.enclosureAudio || null, item.sourceUrl || null],
          });
          if (ins.rowsAffected > 0) imported++;
        } catch {}
      }

      res.json({ id: sourceId, name: sourceName, imported });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  router.delete("/api/media/sources/:id", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const id = parseInt(req.params.id, 10);
      await db.execute({
        sql: "DELETE FROM media_article_states WHERE article_id IN (SELECT id FROM media_articles WHERE source_id = ?)",
        args: [id],
      });
      await db.execute({ sql: "DELETE FROM media_articles WHERE source_id = ?", args: [id] });
      await db.execute({ sql: "DELETE FROM media_sources WHERE id = ?", args: [id] });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Refresh source ---
  router.post("/api/media/sources/:id/refresh", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const id = parseInt(req.params.id, 10);
      const source = await db.execute({ sql: "SELECT * FROM media_sources WHERE id = ?", args: [id] });
      if (source.rows.length === 0) return res.status(404).json({ error: "Not found" });

      const { fetchAndParseFeed } = await importBundleModule("feed-fetcher.js");
      const { items } = await fetchAndParseFeed(source.rows[0].url);

      await db.execute({
        sql: "UPDATE media_sources SET last_fetched = datetime('now'), last_error = NULL WHERE id = ?",
        args: [id],
      });

      let newCount = 0;
      for (const item of items.slice(0, 100)) {
        const guid = item.guid || item.link || item.title;
        if (!guid) continue;
        try {
          const ins = await db.execute({
            sql: `INSERT OR IGNORE INTO media_articles
                  (source_id, guid, url, title, author, pub_date, content_raw, summary, image_url,
                   audio_url, source_url, content_fetch_status, ai_analysis_status, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', datetime('now'))`,
            args: [id, guid, item.link || null, item.title, item.author || null,
                   item.pub_date || null, item.content || null, item.summary?.slice(0, 2000) || null,
                   item.image || null, item.enclosureAudio || null, item.sourceUrl || null],
          });
          if (ins.rowsAffected > 0) newCount++;
        } catch {}
      }

      res.json({ ok: true, new_articles: newCount });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Article audio (TTS) ---
  router.get("/api/media/articles/:id/audio", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const id = parseInt(req.params.id, 10);
      const cached = await db.execute({
        sql: "SELECT audio_path FROM media_audio_cache WHERE article_id = ?",
        args: [id],
      });

      if (cached.rows.length === 0) {
        return res.status(404).json({ error: "No audio generated for this article. Use crow_media_listen first." });
      }

      const audioPath = cached.rows[0].audio_path;
      const { existsSync, statSync, createReadStream } = await import("node:fs");
      if (!existsSync(audioPath)) {
        return res.status(404).json({ error: "Audio file not found." });
      }

      // Update last accessed
      await db.execute({
        sql: "UPDATE media_audio_cache SET last_accessed = datetime('now') WHERE article_id = ?",
        args: [id],
      });

      const stat = statSync(audioPath);
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
          "Content-Type": "audio/mpeg",
        });
        createReadStream(audioPath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          "Content-Length": stat.size,
          "Content-Type": "audio/mpeg",
          "Accept-Ranges": "bytes",
        });
        createReadStream(audioPath).pipe(res);
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Briefing audio ---
  router.get("/api/media/briefings/:id/audio", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const id = parseInt(req.params.id, 10);
      const result = await db.execute({
        sql: "SELECT audio_path FROM media_briefings WHERE id = ?",
        args: [id],
      });

      if (result.rows.length === 0 || !result.rows[0].audio_path) {
        return res.status(404).json({ error: "Briefing audio not found." });
      }

      const audioPath = result.rows[0].audio_path;
      const { existsSync, statSync, createReadStream } = await import("node:fs");
      if (!existsSync(audioPath)) {
        return res.status(404).json({ error: "Audio file not found." });
      }

      const stat = statSync(audioPath);
      res.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": "audio/mpeg",
      });
      createReadStream(audioPath).pipe(res);
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Playlists ---
  router.get("/api/media/playlists", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const { rows } = await db.execute(
        "SELECT p.*, (SELECT COUNT(*) FROM media_playlist_items pi WHERE pi.playlist_id = p.id) as item_count FROM media_playlists p ORDER BY p.updated_at DESC"
      );
      res.json({ playlists: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  router.get("/api/media/playlists/:id", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const id = parseInt(req.params.id, 10);
      const playlist = await db.execute({ sql: "SELECT * FROM media_playlists WHERE id = ?", args: [id] });
      if (playlist.rows.length === 0) return res.status(404).json({ error: "Not found" });

      const { rows: items } = await db.execute({
        sql: `SELECT pi.*,
                CASE pi.item_type
                  WHEN 'article' THEN (SELECT title FROM media_articles WHERE id = pi.item_id)
                  WHEN 'briefing' THEN (SELECT title FROM media_briefings WHERE id = pi.item_id)
                  ELSE NULL
                END as item_title
              FROM media_playlist_items pi
              WHERE pi.playlist_id = ?
              ORDER BY pi.position ASC`,
        args: [id],
      });

      res.json({ playlist: playlist.rows[0], items });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  router.post("/api/media/playlists", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const { name, description } = req.body;
      if (!name) return res.status(400).json({ error: "Name required" });
      const result = await db.execute({
        sql: "INSERT INTO media_playlists (name, description) VALUES (?, ?)",
        args: [name, description || null],
      });
      res.json({ id: result.lastInsertRowid, name });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  router.delete("/api/media/playlists/:id", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const id = parseInt(req.params.id, 10);
      await db.execute({ sql: "DELETE FROM media_playlists WHERE id = ?", args: [id] });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Briefings ---
  router.get("/api/media/briefings", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const { rows } = await db.execute("SELECT * FROM media_briefings ORDER BY created_at DESC LIMIT 20");
      res.json({ briefings: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Stats ---
  router.get("/api/media/stats", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const [sources, articles, unread, starred] = await Promise.all([
        db.execute("SELECT COUNT(*) as c FROM media_sources WHERE enabled = 1"),
        db.execute("SELECT COUNT(*) as c FROM media_articles"),
        db.execute("SELECT COUNT(*) as c FROM media_articles a LEFT JOIN media_article_states st ON st.article_id = a.id WHERE COALESCE(st.is_read, 0) = 0"),
        db.execute("SELECT COUNT(*) as c FROM media_article_states WHERE is_starred = 1"),
      ]);
      res.json({
        sources: sources.rows[0].c,
        articles: articles.rows[0].c,
        unread: unread.rows[0].c,
        starred: starred.rows[0].c,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  return router;
}
