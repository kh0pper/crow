/**
 * IPTV API Routes — Express router for Crow's Nest IPTV panel
 *
 * Bundle-compatible version: uses dynamic imports with path resolution
 * so this routes file works both from the repo and when installed
 * to ~/.crow/bundles/iptv/.
 *
 * Protected by dashboardAuth. Provides channel, EPG, and stream
 * endpoints consumed by the IPTV dashboard panel.
 */

import { Router } from "express";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

// Resolve the main crow db.js (for createDbClient)
function resolveDbModule() {
  const repoPath = join(import.meta.dirname, "..", "..", "..", "servers", "db.js");
  if (existsSync(repoPath)) return repoPath;
  const bundlePath = join(homedir(), ".crow", "bundles", "iptv", "server", "db.js");
  if (existsSync(bundlePath)) return bundlePath;
  return repoPath;
}

const dbModulePath = resolveDbModule();
const { createDbClient } = await import(pathToFileURL(dbModulePath).href);

/**
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {Router}
 */
export default function iptvRouter(authMiddleware) {
  const router = Router();

  // --- Paginated channel list ---
  router.get("/api/iptv/channels", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
      const page = Math.max(1, parseInt(req.query.page || "1", 10));
      const offset = (page - 1) * limit;
      const playlistId = req.query.playlist_id ? parseInt(req.query.playlist_id, 10) : null;
      const group = req.query.group || null;
      const search = req.query.search || null;

      const conditions = [];
      const args = [];

      if (playlistId) {
        conditions.push("c.playlist_id = ?");
        args.push(playlistId);
      }
      if (group) {
        conditions.push("c.group_title = ?");
        args.push(group);
      }
      if (search) {
        conditions.push("c.name LIKE ?");
        args.push(`%${search}%`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const result = await db.execute({
        sql: `SELECT c.id, c.name, c.stream_url, c.logo_url, c.group_title, c.tvg_id, c.is_favorite,
                     p.name as playlist_name
              FROM iptv_channels c
              LEFT JOIN iptv_playlists p ON c.playlist_id = p.id
              ${where}
              ORDER BY c.is_favorite DESC, c.group_title, c.name
              LIMIT ? OFFSET ?`,
        args: [...args, limit, offset],
      });

      const countResult = await db.execute({
        sql: `SELECT COUNT(*) as total FROM iptv_channels c ${where}`,
        args,
      });

      res.json({
        channels: result.rows,
        total: countResult.rows[0]?.total ?? 0,
        page,
        limit,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- EPG for one channel ---
  router.get("/api/iptv/epg/:channelId", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const channelId = parseInt(req.params.channelId, 10);

      const channel = await db.execute({
        sql: "SELECT id, name, tvg_id FROM iptv_channels WHERE id = ?",
        args: [channelId],
      });
      if (channel.rows.length === 0) {
        return res.status(404).json({ error: "Channel not found" });
      }

      const ch = channel.rows[0];
      if (!ch.tvg_id) {
        return res.json({ channel: ch.name, programs: [], note: "No EPG ID available" });
      }

      const now = new Date().toISOString();
      const endTime = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

      const epg = await db.execute({
        sql: `SELECT title, description, start_time, end_time, category, icon_url
              FROM iptv_epg
              WHERE channel_tvg_id = ? AND end_time > ? AND start_time < ?
              ORDER BY start_time`,
        args: [ch.tvg_id, now, endTime],
      });

      res.json({
        channel: ch.name,
        tvg_id: ch.tvg_id,
        programs: epg.rows,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Redirect to stream URL ---
  router.get("/api/iptv/stream/:channelId", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const channelId = parseInt(req.params.channelId, 10);

      const result = await db.execute({
        sql: "SELECT stream_url FROM iptv_channels WHERE id = ?",
        args: [channelId],
      });
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Channel not found" });
      }

      res.redirect(result.rows[0].stream_url);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Favorite toggle (POST from dashboard) ---
  router.post("/dashboard/iptv/favorite", authMiddleware, async (req, res) => {
    const db = createDbClient();
    try {
      const channelId = parseInt(req.body.channel_id, 10);
      const action = req.body.action === "add" ? 1 : 0;

      await db.execute({
        sql: "UPDATE iptv_channels SET is_favorite = ? WHERE id = ?",
        args: [action, channelId],
      });

      // Redirect back to IPTV panel
      const referer = req.headers.referer || "/dashboard/iptv";
      res.redirectAfterPost(referer);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
