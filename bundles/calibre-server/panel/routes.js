/**
 * Calibre Server API Routes — Express router for Crow's Nest Calibre panel
 *
 * Bundle-compatible version: uses env vars directly for API calls.
 * Protected by dashboardAuth. Proxies REST calls to the configured
 * Calibre content server for the dashboard panel.
 */

import { Router } from "express";

const CALIBRE_URL = () => (process.env.CALIBRE_URL || "http://localhost:8081").replace(/\/+$/, "");
const CALIBRE_USERNAME = () => process.env.CALIBRE_USERNAME || "";
const CALIBRE_PASSWORD = () => process.env.CALIBRE_PASSWORD || "";

/**
 * Fetch from Calibre content server API with auth and timeout.
 */
async function cbFetch(path) {
  const url = `${CALIBRE_URL()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const headers = {};
    const username = CALIBRE_USERNAME();
    const password = CALIBRE_PASSWORD();
    if (username && password) {
      headers["Authorization"] = `Basic ${btoa(`${username}:${password}`)}`;
    }

    const res = await fetch(url, {
      signal: controller.signal,
      headers,
    });
    if (!res.ok) throw new Error(`Calibre ${res.status}: ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Calibre request timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach Calibre — is the server running?");
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
export default function calibreServerRouter(authMiddleware) {
  const router = Router();

  // --- Library Stats ---
  router.get("/api/calibre-server/stats", authMiddleware, async (req, res) => {
    try {
      // Get category counts to build stats
      const categories = await cbFetch("/ajax/categories");
      const stats = {};

      for (const cat of (categories || [])) {
        const key = cat.name || "";
        if (cat.count !== undefined) {
          if (key.toLowerCase() === "authors") stats.totalAuthors = cat.count;
          else if (key.toLowerCase() === "tags") stats.totalTags = cat.count;
          else if (key.toLowerCase() === "series") stats.totalSeries = cat.count;
          else if (key.toLowerCase() === "publisher") stats.totalPublishers = cat.count;
          else if (key.toLowerCase() === "formats") stats.totalFormats = cat.count;
        }
      }

      // Get total book count via search with empty query
      const searchData = await cbFetch("/ajax/search?num=0");
      stats.totalBooks = searchData.total_num || 0;

      res.json(stats);
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Recently Added ---
  router.get("/api/calibre-server/recent", authMiddleware, async (req, res) => {
    try {
      const params = new URLSearchParams({
        num: "20",
        offset: "0",
        sort: "timestamp",
        sort_order: "desc",
      });

      const data = await cbFetch(`/ajax/search?${params}`);
      const bookIds = data.book_ids || [];

      if (bookIds.length === 0) {
        res.json({ items: [] });
        return;
      }

      const idsParam = bookIds.join(",");
      const books = await cbFetch(`/ajax/books?ids=${idsParam}`);

      const items = Object.values(books).map((book) => {
        const formats = Array.isArray(book.formats) ? book.formats : (book.available_formats || []);
        const preferredFormat = formats.find((f) => f.toUpperCase() === "EPUB")
          || formats.find((f) => f.toUpperCase() === "PDF")
          || formats[0];

        return {
          id: book.application_id || book.id,
          title: book.title || "Unknown",
          authors: Array.isArray(book.authors) ? book.authors.join(", ") : (book.authors || "Unknown"),
          tags: Array.isArray(book.tags) ? book.tags.join(", ") : null,
          formats: formats.join(", "),
          downloadUrl: preferredFormat
            ? `${CALIBRE_URL()}/get/${preferredFormat.toUpperCase()}/${book.application_id || book.id}`
            : null,
        };
      });

      res.json({ items });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
