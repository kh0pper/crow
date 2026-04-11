/**
 * BookStack API Routes — Express router for Crow's Nest BookStack panel
 *
 * Bundle-compatible version: uses env vars directly for API calls.
 * Protected by dashboardAuth. Proxies REST calls to the configured
 * BookStack instance for the dashboard panel.
 */

import { Router } from "express";

const BOOKSTACK_URL = () => (process.env.BOOKSTACK_URL || "http://localhost:6875").replace(/\/+$/, "");
const BOOKSTACK_TOKEN_ID = () => process.env.BOOKSTACK_TOKEN_ID || "";
const BOOKSTACK_TOKEN_SECRET = () => process.env.BOOKSTACK_TOKEN_SECRET || "";

/**
 * Fetch from BookStack API with auth and timeout.
 */
async function bsFetch(path) {
  const url = `${BOOKSTACK_URL()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "Authorization": `Token ${BOOKSTACK_TOKEN_ID()}:${BOOKSTACK_TOKEN_SECRET()}` },
    });
    if (!res.ok) throw new Error(`BookStack ${res.status}: ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error("BookStack request timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach BookStack — is the server running?");
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
export default function bookstackRouter(authMiddleware) {
  const router = Router();

  // --- Library Stats ---
  router.get("/api/bookstack/stats", authMiddleware, async (req, res) => {
    try {
      const [shelves, books, chapters, pages] = await Promise.all([
        bsFetch("/api/shelves?count=0"),
        bsFetch("/api/books?count=0"),
        bsFetch("/api/chapters?count=0"),
        bsFetch("/api/pages?count=0"),
      ]);

      res.json({
        shelves: shelves.total || 0,
        books: books.total || 0,
        chapters: chapters.total || 0,
        pages: pages.total || 0,
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Recent Pages ---
  router.get("/api/bookstack/recent", authMiddleware, async (req, res) => {
    try {
      const params = new URLSearchParams({
        count: "20",
        sort: "-updated_at",
      });

      const data = await bsFetch(`/api/pages?${params}`);
      const items = (data.data || []).map((page) => ({
        id: page.id,
        name: page.name,
        slug: page.slug,
        book: page.book?.name || null,
        chapter: page.chapter?.name || null,
        updated: page.updated_at ? new Date(page.updated_at).toLocaleDateString() : null,
        preview: page.preview?.slice(0, 150) || null,
      }));

      res.json({ items });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
