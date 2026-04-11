/**
 * Audiobookshelf API Routes — Express router for Crow's Nest Audiobookshelf panel
 *
 * Bundle-compatible version: uses env vars directly for API calls.
 * Protected by dashboardAuth. Proxies REST calls to the configured
 * Audiobookshelf instance for the dashboard panel.
 */

import { Router } from "express";

const ABS_URL = () => (process.env.AUDIOBOOKSHELF_URL || "http://localhost:13378").replace(/\/+$/, "");
const ABS_API_KEY = () => process.env.AUDIOBOOKSHELF_API_KEY || "";

/**
 * Fetch from Audiobookshelf API with auth and timeout.
 */
async function absFetch(path) {
  const url = `${ABS_URL()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "Authorization": `Bearer ${ABS_API_KEY()}` },
    });
    if (!res.ok) throw new Error(`Audiobookshelf ${res.status}: ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Audiobookshelf request timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach Audiobookshelf — is the server running?");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Format seconds to human-readable duration.
 */
function formatDuration(seconds) {
  if (!seconds) return null;
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {Router}
 */
export default function audiobookshelfRouter(authMiddleware) {
  const router = Router();

  // --- Libraries ---
  router.get("/api/audiobookshelf/libraries", authMiddleware, async (req, res) => {
    try {
      const data = await absFetch("/api/libraries");
      const libraries = (data.libraries || data || []).map((lib) => ({
        id: lib.id,
        name: lib.name,
        mediaType: lib.mediaType || null,
      }));
      res.json({ libraries });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- In Progress ---
  router.get("/api/audiobookshelf/progress", authMiddleware, async (req, res) => {
    try {
      const data = await absFetch("/api/me/items-in-progress");
      const items = (data.libraryItems || data || []).map((item) => {
        const media = item.media || {};
        const meta = media.metadata || {};
        const progress = item.userMediaProgress || {};

        return {
          id: item.id,
          title: meta.title || item.name || null,
          author: meta.authorName || meta.authors?.map((a) => a.name).join(", ") || null,
          duration: formatDuration(media.duration),
          progress: Math.round((progress.progress || 0) * 100) + "%",
        };
      });
      res.json({ items });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Recently Added ---
  router.get("/api/audiobookshelf/recent", authMiddleware, async (req, res) => {
    try {
      // Get first library
      const libData = await absFetch("/api/libraries");
      const libraries = libData.libraries || libData || [];
      if (libraries.length === 0) {
        res.json({ items: [] });
        return;
      }

      const allItems = [];
      for (const lib of libraries.slice(0, 3)) {
        const params = new URLSearchParams({
          sort: "addedAt",
          desc: "1",
          limit: "10",
        });
        const data = await absFetch(`/api/libraries/${lib.id}/items?${params}`);
        const items = (data.results || []).map((item) => {
          const media = item.media || {};
          const meta = media.metadata || {};
          return {
            id: item.id,
            title: meta.title || item.name || null,
            author: meta.authorName || meta.authors?.map((a) => a.name).join(", ") || null,
            duration: formatDuration(media.duration),
            year: meta.publishedYear || null,
            webPlayerUrl: `${ABS_URL()}/item/${item.id}`,
          };
        });
        allItems.push(...items);
      }

      // Sort by most recent and limit
      res.json({ items: allItems.slice(0, 20) });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
