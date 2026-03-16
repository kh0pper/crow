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

  // --- TTS generation (on-demand) ---
  router.post("/api/media/articles/:id/listen", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const id = parseInt(req.params.id, 10);
      const { getOrGenerateAudio, isEdgeTtsAvailable } = await importBundleModule("tts.js");
      if (!(await isEdgeTtsAvailable())) {
        return res.status(503).json({ error: "edge-tts is not installed. Run: npm install edge-tts" });
      }
      const result = await getOrGenerateAudio(db, id);
      res.json({ audio_url: `/api/media/articles/${id}/audio`, cached: result.cached, duration: result.duration });
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

  // --- Playlist items ---
  router.post("/api/media/playlists/:id/items", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const playlistId = parseInt(req.params.id, 10);
      const { item_type, item_id } = req.body;
      if (!item_type || !item_id) return res.status(400).json({ error: "item_type and item_id required" });

      const pl = await db.execute({ sql: "SELECT id FROM media_playlists WHERE id = ?", args: [playlistId] });
      if (pl.rows.length === 0) return res.status(404).json({ error: "Playlist not found" });

      const maxPos = await db.execute({
        sql: "SELECT COALESCE(MAX(position), 0) as m FROM media_playlist_items WHERE playlist_id = ?",
        args: [playlistId],
      });
      await db.execute({
        sql: "INSERT INTO media_playlist_items (playlist_id, item_type, item_id, position) VALUES (?, ?, ?, ?)",
        args: [playlistId, item_type, parseInt(item_id, 10), (maxPos.rows[0]?.m || 0) + 1],
      });
      await db.execute({
        sql: "UPDATE media_playlists SET updated_at = datetime('now') WHERE id = ?",
        args: [playlistId],
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  router.delete("/api/media/playlists/:id/items/:itemId", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const playlistId = parseInt(req.params.id, 10);
      const itemId = parseInt(req.params.itemId, 10);
      await db.execute({
        sql: "DELETE FROM media_playlist_items WHERE id = ? AND playlist_id = ?",
        args: [itemId, playlistId],
      });
      await db.execute({
        sql: "UPDATE media_playlists SET updated_at = datetime('now') WHERE id = ?",
        args: [playlistId],
      });
      res.json({ ok: true });
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

  // --- Generate Briefing ---
  router.post("/api/media/briefings", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const topic = req.body.topic || null;
      const count = Math.min(parseInt(req.body.count || "5", 10), 20);
      const generateAudio = req.body.voice === "1" || req.body.voice === "true";

      // Get top unread articles
      let sql = `SELECT a.id, a.title, a.summary, a.content_full, a.content_raw,
                        s.name as source_name, s.category as source_category
                 FROM media_articles a
                 JOIN media_sources s ON s.id = a.source_id
                 LEFT JOIN media_article_states st ON st.article_id = a.id
                 WHERE COALESCE(st.is_read, 0) = 0 AND s.enabled = 1`;
      const args = [];
      if (topic) {
        const { escapeLikePattern: esc } = await import(pathToFileURL(dbModulePath).href);
        const escaped = esc(topic);
        sql += " AND (s.category LIKE ? ESCAPE '\\' OR a.title LIKE ? ESCAPE '\\')";
        args.push(`%${escaped}%`, `%${escaped}%`);
      }
      sql += " ORDER BY a.pub_date DESC NULLS LAST LIMIT ?";
      args.push(count);

      const { rows: articles } = await db.execute({ sql, args });
      if (articles.length === 0) {
        return res.status(400).json({ error: "No unread articles found" + (topic ? ` matching "${topic}"` : "") });
      }

      // Build briefing script
      const title = topic ? `Briefing: ${topic}` : `News Briefing`;
      const scriptLines = articles.map((a, i) => {
        const text = a.summary || (a.content_full || a.content_raw || "").slice(0, 500);
        return `${i + 1}. ${a.title} (${a.source_name})\n${text}`;
      });
      const script = scriptLines.join("\n\n");
      const articleIds = JSON.stringify(articles.map(a => a.id));

      let audioPath = null;
      let durationSec = null;

      if (generateAudio) {
        try {
          const { isEdgeTtsAvailable, generateAudio: genAudio, resolveAudioDir } = await importBundleModule("tts.js");
          if (await isEdgeTtsAvailable()) {
            const { join } = await import("node:path");
            const { createHash } = await import("node:crypto");
            const audioDir = resolveAudioDir();
            const hash = createHash("sha256").update(script).digest("hex").slice(0, 12);
            const outPath = join(audioDir, `briefing-${hash}.mp3`);
            const result = await genAudio(`${title}. ${script}`, "en-US-AriaNeural", outPath);
            audioPath = outPath;
            durationSec = result.duration;
          }
        } catch (e) {
          console.warn("[media] Briefing TTS failed:", e.message);
        }
      }

      const result = await db.execute({
        sql: "INSERT INTO media_briefings (title, script, audio_path, article_ids, duration_sec) VALUES (?, ?, ?, ?, ?)",
        args: [title, script, audioPath, articleIds, durationSec],
      });

      res.json({ id: result.lastInsertRowid, title, article_count: articles.length, has_audio: !!audioPath });
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

  // --- Playlist visibility ---
  router.patch("/api/media/playlists/:id", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const id = parseInt(req.params.id, 10);
      const { visibility } = req.body;
      if (!["private", "public", "unlisted"].includes(visibility)) {
        return res.status(400).json({ error: "visibility must be private, public, or unlisted" });
      }

      // Auto-generate slug when making public/unlisted
      let slug = null;
      if (visibility !== "private") {
        const pl = await db.execute({ sql: "SELECT name, slug FROM media_playlists WHERE id = ?", args: [id] });
        if (pl.rows.length === 0) return res.status(404).json({ error: "Not found" });
        slug = pl.rows[0].slug;
        if (!slug) {
          slug = pl.rows[0].name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
          // Ensure uniqueness
          const existing = await db.execute({ sql: "SELECT id FROM media_playlists WHERE slug = ? AND id != ?", args: [slug, id] });
          if (existing.rows.length > 0) slug += "-" + id;
        }
      }

      await db.execute({
        sql: "UPDATE media_playlists SET visibility = ?, slug = ?, updated_at = datetime('now') WHERE id = ?",
        args: [visibility, slug, id],
      });
      res.json({ ok: true, slug, visibility });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  return router;
}

/**
 * Public playlist routes — mounted WITHOUT auth middleware.
 * Follows the same pattern as blog-public.js.
 */
export function mediaPublicRouter() {
  const router = Router();

  router.get("/media/playlists/:slug", async (req, res) => {
    const db = createDbClient();
    try {
      const slug = req.params.slug;
      const pl = await db.execute({
        sql: "SELECT * FROM media_playlists WHERE slug = ? AND visibility IN ('public', 'unlisted')",
        args: [slug],
      });
      if (pl.rows.length === 0) return res.status(404).send("Playlist not found");

      const playlist = pl.rows[0];
      const { rows: items } = await db.execute({
        sql: `SELECT pi.*, a.title, a.url, a.author, a.pub_date, a.summary, a.image_url, a.audio_url,
                     a.content_fetch_status, s.name as source_name
              FROM media_playlist_items pi
              JOIN media_articles a ON a.id = pi.item_id AND pi.item_type = 'article'
              JOIN media_sources s ON s.id = a.source_id
              WHERE pi.playlist_id = ?
              ORDER BY pi.position ASC`,
        args: [playlist.id],
      });

      const itemsHtml = items.map((item, idx) => {
        const paywalled = item.content_fetch_status === "failed";
        return `<div style="display:flex;gap:0.75rem;align-items:center;padding:0.75rem;border-bottom:1px solid #2a2a3a">
          <span style="font-size:0.8rem;color:#888;width:24px;text-align:center">${idx + 1}</span>
          ${item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt="" style="width:56px;height:56px;border-radius:4px;object-fit:cover;flex-shrink:0">` : ""}
          <div style="flex:1;min-width:0">
            <div style="font-size:0.9rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              <a href="${escapeHtml(item.url || "#")}" target="_blank" rel="noopener" style="color:#e2e8f0;text-decoration:none">${escapeHtml(item.title)}</a>
            </div>
            <div style="font-size:0.75rem;color:#888">${escapeHtml(item.source_name || "")}${item.pub_date ? " \u00b7 " + item.pub_date.split("T")[0] : ""}</div>
            ${paywalled ? '<span style="font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:4px;background:rgba(251,191,36,0.15);color:#fbbf24">Subscriber content</span>' : ""}
          </div>
        </div>`;
      }).join("");

      function escapeHtml(s) { return s ? s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") : ""; }

      const html = `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(playlist.name)} — Crow Playlist</title>
  <meta property="og:title" content="${escapeHtml(playlist.name)}">
  <meta property="og:description" content="Playlist with ${items.length} articles">
  <meta property="og:type" content="music.playlist">
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Fraunces:opsz,wght@9..144,700&display=swap" rel="stylesheet">
  <style>body{margin:0;background:#0f0f1a;color:#e2e8f0;font-family:'DM Sans',sans-serif;min-height:100vh}
  .container{max-width:640px;margin:0 auto;padding:2rem 1rem}
  h1{font-family:'Fraunces',serif;font-size:1.5rem;margin:0 0 0.25rem}
  .meta{font-size:0.85rem;color:#888;margin-bottom:1.5rem}
  a{color:#6366f1}</style>
</head><body>
  <div class="container">
    <h1>${escapeHtml(playlist.name)}</h1>
    <div class="meta">${items.length} articles${playlist.description ? " \u00b7 " + escapeHtml(playlist.description) : ""}</div>
    <div>${itemsHtml || "<p style='color:#888'>This playlist is empty.</p>"}</div>
    <p style="margin-top:2rem;font-size:0.75rem;color:#555">Powered by <a href="https://github.com/kh0pp/crow">Crow</a></p>
  </div>
</body></html>`;

      res.type("html").send(html);
    } catch (err) {
      res.status(500).send("Error loading playlist");
    } finally {
      db.close();
    }
  });

  return router;
}
