/**
 * Miniflux API Routes — Express router for Crow's Nest Miniflux panel
 *
 * Bundle-compatible version: uses env vars directly for API calls.
 * Protected by dashboardAuth. Proxies REST calls to the configured
 * Miniflux instance for the dashboard panel.
 */

import { Router } from "express";

const MINIFLUX_URL = () => (process.env.MINIFLUX_URL || "http://localhost:8085").replace(/\/+$/, "");
const MINIFLUX_API_KEY = () => process.env.MINIFLUX_API_KEY || "";

/**
 * Fetch from Miniflux API with auth and timeout.
 */
async function mfFetch(path) {
  const url = `${MINIFLUX_URL()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "X-Auth-Token": MINIFLUX_API_KEY() },
    });
    if (!res.ok) throw new Error(`Miniflux ${res.status}: ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Miniflux request timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach Miniflux — is the server running?");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {Router}
 */
export default function minifluxRouter(authMiddleware) {
  const router = Router();

  // --- Feed Stats ---
  router.get("/api/miniflux/stats", authMiddleware, async (req, res) => {
    try {
      const feeds = await mfFetch("/v1/feeds");
      const feedCount = (feeds || []).length;
      const unreadCount = (feeds || []).reduce((sum, f) => sum + (f.unread_count || 0), 0);

      // Get starred count from entries endpoint
      const starred = await mfFetch("/v1/entries?starred=true&limit=1&offset=0");
      const starredCount = starred.total || 0;

      res.json({ feedCount, unreadCount, starredCount });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Entries ---
  router.get("/api/miniflux/entries", authMiddleware, async (req, res) => {
    try {
      const params = new URLSearchParams({
        limit: req.query.limit || "20",
        offset: req.query.offset || "0",
        direction: "desc",
        order: "published_at",
      });
      if (req.query.status) params.set("status", req.query.status);
      if (req.query.starred === "true") params.set("starred", "true");

      const data = await mfFetch(`/v1/entries?${params}`);
      const entries = (data.entries || []).map((e) => ({
        id: e.id,
        title: e.title,
        feed: e.feed?.title || null,
        published: e.published_at || null,
        url: e.url || null,
        status: e.status,
        starred: e.starred || false,
        reading_time: e.reading_time ? `${e.reading_time} min` : null,
      }));

      res.json({ entries, total: data.total || 0 });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
