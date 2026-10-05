/**
 * Media API Routes — Express router for Crow's Nest media panel
 *
 * Bundle-compatible version: uses dynamic imports with path resolution
 * so this routes file works both from the repo and when installed
 * to ~/.crow/bundles/media/.
 *
 * Protected by dashboardAuth (plus the gateway CSRF check on every
 * state-changing route). Provides feed, article, and source
 * endpoints consumed by the media dashboard panel.
 */

import { Router } from "express";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

// Resolve bundle server directory (this instance's installed copy, else the repo)
function resolveBundleServer() {
  const installed = join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "media", "server");
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

// The gateway's double-submit CSRF check, resolved from the app root so it
// also works from an installed copy (the gateway sets CROW_APP_ROOT; the
// repo-relative fallback covers running straight from the checkout).
const appRoot = process.env.CROW_APP_ROOT || join(import.meta.dirname, "..", "..", "..");
const { csrfMiddleware } = await import(
  pathToFileURL(join(appRoot, "servers", "gateway", "dashboard", "shared", "csrf.js")).href
);

/** Escape a value for HTML text and quoted-attribute contexts. */
function escapeHtml(value) {
  if (value == null || value === false) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Feed-supplied URL -> normalized absolute http(s) URL, otherwise "". */
function safeHttpUrl(value) {
  if (typeof value !== "string") return "";
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return "";
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
}

/** Import a module from the bundle's server directory */
const bundleModule = (name) => import(pathToFileURL(join(serverDir, name)).href);

// The tables are created by the stdio server at its start; the panel must not depend on that having happened.
{
  const db = createDbClient();
  try { await (await bundleModule("init-tables.js")).initMediaTables(db); }
  catch (err) { console.warn(`[media] table check failed: ${err.message}`); }
  finally { db.close(); }
}

/**
 * Stream one of the bundle's audio files. The path comes from a database row, so it is served only
 * when it is a real .mp3 inside the audio directory. One byte range is supported; a range that is
 * malformed or cannot be satisfied answers 416.
 */
async function sendAudio(req, res, audioPath) {
  const { insideAudioDir } = await bundleModule("speech.js");
  if (!insideAudioDir(audioPath)) return res.status(404).json({ error: "Audio file not found." });
  const { statSync, createReadStream } = await import("node:fs");
  const size = statSync(audioPath).size;
  const base = { "Content-Type": "audio/mpeg", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" };
  const range = req.headers.range;
  if (range === undefined) {
    res.writeHead(200, { ...base, "Content-Length": size });
    return createReadStream(audioPath).pipe(res);
  }
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(String(range).trim());
  let start = NaN, end = NaN;
  if (m && (m[1] !== "" || m[2] !== "")) {
    if (m[1] === "") { start = Math.max(0, size - Number(m[2])); end = size - 1; if (Number(m[2]) === 0) start = NaN; }
    else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  }
  if (!(start >= 0 && start <= end && start < size)) {
    res.writeHead(416, { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" });
    return res.end();
  }
  res.writeHead(206, { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
  createReadStream(audioPath, { start, end }).pipe(res);
}

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
  router.post("/api/media/articles/:id/action", authMiddleware, csrfMiddleware, async (req, res) => {
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

  router.post("/api/media/sources", authMiddleware, csrfMiddleware, async (req, res) => {
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

  router.delete("/api/media/sources/:id", authMiddleware, csrfMiddleware, async (req, res) => {
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
  router.post("/api/media/sources/:id/refresh", authMiddleware, csrfMiddleware, async (req, res) => {
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

  // --- Article audio ---
  router.get("/api/media/articles/:id/audio", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const id = parseInt(req.params.id, 10);
      const cached = await db.execute({ sql: "SELECT audio_path FROM media_audio_cache WHERE article_id = ?", args: [id] });
      if (cached.rows.length === 0) return res.status(404).json({ error: "No audio has been made for this article yet." });
      await db.execute({ sql: "UPDATE media_audio_cache SET last_accessed = datetime('now') WHERE article_id = ?", args: [id] });
      await sendAudio(req, res, cached.rows[0].audio_path);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Article audio, made on demand by the local voice ---
  router.post("/api/media/articles/:id/listen", authMiddleware, csrfMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const id = parseInt(req.params.id, 10);
      const { getOrGenerateAudio } = await importBundleModule("tts.js");
      const result = await getOrGenerateAudio(db, id);
      res.json({ audio_url: `/api/media/articles/${id}/audio`, cached: result.cached, duration: result.duration });
    } catch (err) {
      res.status(err.code ? 503 : 500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Briefings: the latest one (the stable answer other parts of Crow use) ---
  // ?audio=0 drops the "has audio" rule; ?max_age_hours=N and ?kind=daily narrow it. 404 when none qualifies.
  router.get("/api/media/briefings/latest", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const { getLatestBriefing } = await importBundleModule("briefing.js");
      const maxAge = Number(req.query.max_age_hours);
      const kind = ["daily", "manual"].includes(req.query.kind) ? req.query.kind : null;
      const b = await getLatestBriefing(db, { withAudio: req.query.audio !== "0", maxAgeHours: Number.isFinite(maxAge) && maxAge > 0 ? maxAge : null, kind });
      if (!b) return res.status(404).json({ error: "no_briefing" });
      res.json(b);
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Briefings: the daily schedule ---
  router.get("/api/media/briefings/schedule", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const { readSchedule, scheduleView } = await importBundleModule("schedule.js");
      const s = await readSchedule(db);
      res.json({ view: scheduleView(s.row, s.cfg), cfg: s.cfg });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  router.post("/api/media/briefings/schedule", authMiddleware, csrfMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const { saveSchedule } = await importBundleModule("schedule.js");
      const body = req.body || {};
      const input = {};
      if (typeof body.time === "string" && body.time) input.time = body.time;
      if (body.enabled !== undefined) input.enabled = body.enabled === true || body.enabled === "1";
      if (body.max_stories !== undefined) input.max_stories = Number(body.max_stories);
      if (body.show_source_id !== undefined) {
        const id = Number(body.show_source_id);
        input.attach = id > 0 ? [{ source_id: id, days: body.show_weekdays_only === false ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5], ...(typeof body.show_title_prefix === "string" ? { title_prefix: body.show_title_prefix.slice(0, 80) } : {}) }] : [];
      }
      const s = await saveSchedule(db, input);
      res.json({ ok: true, view: s.view, cfg: s.cfg });
    } catch (err) {
      res.status(["bad_time", "bad_cron", "bad_tz", "bad_source"].includes(err.code) ? 400 : 500).json({ error: err.message, code: err.code || null });
    } finally {
      db.close();
    }
  });

  // --- Briefings: one, by id ---
  router.get("/api/media/briefings/:id", authMiddleware, async (req, res, next) => {
    if (!/^\d{1,12}$/.test(req.params.id)) return next();
    const db = createDbClient();
    try {
      const { getBriefing } = await importBundleModule("briefing.js");
      const b = await getBriefing(db, Number(req.params.id));
      if (!b) return res.status(404).json({ error: "not_found" });
      res.json(b);
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
      const result = await db.execute({ sql: "SELECT audio_path FROM media_briefings WHERE id = ?", args: [id] });
      if (result.rows.length === 0 || !result.rows[0].audio_path) return res.status(404).json({ error: "Briefing audio not found." });
      await sendAudio(req, res, result.rows[0].audio_path);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
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

  router.post("/api/media/playlists", authMiddleware, csrfMiddleware, async (req, res) => {
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
  router.post("/api/media/playlists/:id/items", authMiddleware, csrfMiddleware, async (req, res) => {
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

  router.delete("/api/media/playlists/:id/items/:itemId", authMiddleware, csrfMiddleware, async (req, res) => {
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

  router.delete("/api/media/playlists/:id", authMiddleware, csrfMiddleware, async (req, res) => {
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

  // --- Make a briefing now ---
  // Answers at once with the new briefing's id; the feeds are refreshed, the script written and the
  // local voice run in the background. The tab polls GET /api/media/briefings/:id until it is ready.
  router.post("/api/media/briefings", authMiddleware, csrfMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const { createBriefing, makeBriefing, failBriefing, getBriefing } = await importBundleModule("briefing.js");
      const { readSchedule } = await importBundleModule("schedule.js");
      const { instanceLang } = await importBundleModule("settings.js");
      const { refreshSources } = await importBundleModule("tasks.js");
      const topic = typeof req.body?.topic === "string" && req.body.topic.trim() ? req.body.topic.trim().slice(0, 200) : null;
      const count = Math.min(Math.max(parseInt(req.body?.count || "0", 10) || 0, 0), 20);
      const busy = await db.execute("SELECT id FROM media_briefings WHERE status = 'generating' AND COALESCE(kind, 'manual') != 'daily' AND julianday(created_at) > julianday('now', '-10 minutes') ORDER BY id DESC LIMIT 1");
      if (busy.rows[0]) return res.status(202).json(await getBriefing(db, busy.rows[0].id));
      const { cfg } = await readSchedule(db);
      const lang = await instanceLang(db);
      const id = await createBriefing(db, { kind: "manual", lang });
      const job = createDbClient();
      makeBriefing(job, id, { kind: "manual", topic, maxStories: count || cfg.max_stories, tz: cfg.tz, lang, refreshCapMs: 20_000 }, { refresh: refreshSources, audio: req.body?.audio !== false && req.body?.audio !== "0" })
        .catch((err) => { console.warn(`[media] briefing ${id} failed: ${err.message}`); return failBriefing(job, id, err.message); })
        .catch(() => {})
        .finally(() => { try { job.close(); } catch {} });
      res.status(202).json(await getBriefing(db, id));
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
      const { listBriefings } = await importBundleModule("briefing.js");
      res.json({ briefings: await listBriefings(db, { limit: 20 }) });
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
  router.patch("/api/media/playlists/:id", authMiddleware, csrfMiddleware, async (req, res) => {
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
        // Feed-supplied URLs: http(s) only, anything else is dropped.
        const imageUrl = safeHttpUrl(item.image_url);
        const linkUrl = safeHttpUrl(item.url) || "#";
        return `<div style="display:flex;gap:0.75rem;align-items:center;padding:0.75rem;border-bottom:1px solid #2a2a3a">
          <span style="font-size:0.8rem;color:#888;width:24px;text-align:center">${idx + 1}</span>
          ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="" style="width:56px;height:56px;border-radius:4px;object-fit:cover;flex-shrink:0">` : ""}
          <div style="flex:1;min-width:0">
            <div style="font-size:0.9rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              <a href="${escapeHtml(linkUrl)}" target="_blank" rel="noopener" style="color:#e2e8f0;text-decoration:none">${escapeHtml(item.title)}</a>
            </div>
            <div style="font-size:0.75rem;color:#888">${escapeHtml(item.source_name || "")}${item.pub_date ? " \u00b7 " + escapeHtml(String(item.pub_date).split("T")[0]) : ""}</div>
            ${paywalled ? '<span style="font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:4px;background:rgba(217,165,33,0.15);color:#d9a521">Subscriber content</span>' : ""}
          </div>
        </div>`;
      }).join("");

      const html = `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(playlist.name)} — Crow Playlist</title>
  <meta property="og:title" content="${escapeHtml(playlist.name)}">
  <meta property="og:description" content="Playlist with ${items.length} articles">
  <meta property="og:type" content="music.playlist">
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
  <style>body{margin:0;background:#0f0f1a;color:#e2e8f0;font-family:'DM Sans',sans-serif;min-height:100vh}
  .container{max-width:640px;margin:0 auto;padding:2rem 1rem}
  h1{font-family:'DM Sans',sans-serif;font-weight:700;font-size:1.5rem;margin:0 0 0.25rem}
  .meta{font-size:0.85rem;color:#888;margin-bottom:1.5rem}
  a{color:#4fbdb0}</style>
</head><body>
  <div class="container">
    <h1>${escapeHtml(playlist.name)}</h1>
    <div class="meta">${items.length} articles${playlist.description ? " \u00b7 " + escapeHtml(playlist.description) : ""}</div>
    <div>${itemsHtml || "<p style='color:#888'>This playlist is empty.</p>"}</div>
    <p style="margin-top:2rem;font-size:0.75rem;color:#555">Powered by <a href="https://github.com/kh0pper/crow">Crow</a></p>
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
