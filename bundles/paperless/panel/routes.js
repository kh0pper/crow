/**
 * Paperless-ngx API Routes — Express router for Crow's Nest Paperless panel
 *
 * Bundle-compatible version: uses env vars directly for API calls.
 * Protected by dashboardAuth. Proxies REST calls to the configured
 * Paperless-ngx instance for the dashboard panel.
 */

import { Router } from "express";

const PAPERLESS_URL = () => (process.env.PAPERLESS_URL || "http://localhost:8000").replace(/\/+$/, "");
const PAPERLESS_API_TOKEN = () => process.env.PAPERLESS_API_TOKEN || "";

/**
 * Fetch from Paperless-ngx API with auth and timeout.
 */
async function plFetch(path) {
  const url = `${PAPERLESS_URL()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Token ${PAPERLESS_API_TOKEN()}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) throw new Error(`Paperless ${res.status}: ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Paperless request timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach Paperless-ngx — is the server running?");
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
export default function paperlessRouter(authMiddleware) {
  const router = Router();

  // --- Statistics ---
  router.get("/api/paperless/stats", authMiddleware, async (req, res) => {
    try {
      const data = await plFetch("/api/statistics/");
      res.json(data);
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Tags ---
  router.get("/api/paperless/tags", authMiddleware, async (req, res) => {
    try {
      const data = await plFetch("/api/tags/?page_size=100");
      const tags = (data.results || []).map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color || null,
        document_count: t.document_count || 0,
      }));
      res.json({ tags });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Recent Documents ---
  router.get("/api/paperless/recent", authMiddleware, async (req, res) => {
    try {
      const params = new URLSearchParams({
        page_size: "20",
        ordering: "-added",
      });
      const data = await plFetch(`/api/documents/?${params}`);
      const documents = (data.results || []).map((doc) => ({
        id: doc.id,
        title: doc.title,
        correspondent: doc.correspondent_name || null,
        tags: doc.tags_name || [],
        created: doc.created,
        added: doc.added,
      }));
      res.json({ documents });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
