/**
 * Linkding API Routes — Express router for Crow's Nest Linkding panel
 *
 * Bundle-compatible version: uses env vars directly for API calls.
 * Protected by dashboardAuth. Proxies REST calls to the configured
 * Linkding instance for the dashboard panel.
 */

import { Router } from "express";

const LINKDING_URL = () => (process.env.LINKDING_URL || "http://localhost:9090").replace(/\/+$/, "");
const LINKDING_API_TOKEN = () => process.env.LINKDING_API_TOKEN || "";

/**
 * Fetch from Linkding API with auth and timeout.
 */
async function ldFetch(path) {
  const url = `${LINKDING_URL()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Token ${LINKDING_API_TOKEN()}` },
    });
    if (!res.ok) throw new Error(`Linkding ${res.status}: ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Linkding request timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach Linkding — is the server running?");
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
export default function linkdingRouter(authMiddleware) {
  const router = Router();

  // --- Stats ---
  router.get("/api/linkding/stats", authMiddleware, async (req, res) => {
    try {
      const [bookmarks, tags] = await Promise.all([
        ldFetch("/api/bookmarks/?limit=1&offset=0"),
        ldFetch("/api/tags/"),
      ]);

      res.json({
        bookmarkCount: bookmarks.count || 0,
        tagCount: Array.isArray(tags.results) ? tags.results.length : (tags.count || 0),
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Recent Bookmarks ---
  router.get("/api/linkding/recent", authMiddleware, async (req, res) => {
    try {
      const data = await ldFetch("/api/bookmarks/?limit=20&offset=0");
      const bookmarks = (data.results || []).map((b) => ({
        id: b.id,
        url: b.url,
        title: b.title || b.website_title || null,
        description: b.description || null,
        tags: b.tag_names || [],
        date_added: b.date_added || null,
      }));

      res.json({ bookmarks });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
