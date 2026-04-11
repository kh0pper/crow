/**
 * Calibre-Web API Routes — Express router for Crow's Nest Calibre-Web panel
 *
 * Bundle-compatible version: uses env vars directly for API calls.
 * Protected by dashboardAuth. Proxies calls to the configured
 * Calibre-Web instance for the dashboard panel.
 */

import { Router } from "express";

const CALIBRE_WEB_URL = () => (process.env.CALIBRE_WEB_URL || "http://localhost:8083").replace(/\/+$/, "");
const CALIBRE_WEB_API_KEY = () => process.env.CALIBRE_WEB_API_KEY || "";

/**
 * Fetch from Calibre-Web with auth and timeout.
 */
async function cwFetch(path) {
  const url = `${CALIBRE_WEB_URL()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "Authorization": `Bearer ${CALIBRE_WEB_API_KEY()}` },
    });
    if (!res.ok) throw new Error(`Calibre-Web ${res.status}: ${res.statusText}`);
    const text = await res.text();

    // Try JSON first, fall back to raw text (for OPDS XML)
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Calibre-Web request timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach Calibre-Web — is the server running?");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse OPDS XML entries.
 */
function parseOpdsEntries(xml) {
  if (typeof xml !== "string") return [];
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[1];
    const getTag = (tag) => {
      const m = entryXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return m ? m[1].trim() : null;
    };

    const idTag = getTag("id");
    const idMatch = idTag ? idTag.match(/(\d+)/) : null;

    entries.push({
      id: idMatch ? parseInt(idMatch[1], 10) : null,
      title: getTag("title"),
      author: getTag("name"),
      updated: getTag("updated"),
    });
  }
  return entries;
}

/**
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {Router}
 */
export default function calibreWebRouter(authMiddleware) {
  const router = Router();

  // --- Library Stats ---
  router.get("/api/calibre-web/stats", authMiddleware, async (req, res) => {
    try {
      // Get book count from main feed
      const mainFeed = await cwFetch("/opds");
      const entries = parseOpdsEntries(mainFeed);
      const totalBooks = entries.length;

      // Get shelf count
      let totalShelves = 0;
      try {
        const shelfFeed = await cwFetch("/opds/shelf");
        const shelfEntries = parseOpdsEntries(shelfFeed);
        totalShelves = shelfEntries.length;
      } catch {
        // Shelves may not be accessible
      }

      res.json({ totalBooks, totalShelves });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Recently Added ---
  router.get("/api/calibre-web/recent", authMiddleware, async (req, res) => {
    try {
      const data = await cwFetch("/opds/new");
      const entries = parseOpdsEntries(data);

      const items = entries.slice(0, 20).map((entry) => ({
        id: entry.id,
        title: entry.title,
        author: entry.author,
        readerUrl: entry.id ? `${CALIBRE_WEB_URL()}/read/${entry.id}` : null,
      }));

      res.json({ items });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
