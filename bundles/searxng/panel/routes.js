/**
 * SearXNG panel routes — proxies search + config to the local SearXNG.
 */

import { Router } from "express";

const SEARXNG_URL = () => (process.env.SEARXNG_BASE_URL || "http://localhost:8098/").replace(/\/+$/, "");

async function sxFetch(path, timeoutMs = 15000) {
  const url = `${SEARXNG_URL()}${path}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) throw new Error(`SearXNG ${res.status}: ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error("SearXNG request timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach SearXNG — is the server running?");
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

export default function searxngRouter(authMiddleware) {
  const router = Router();

  router.get("/api/searxng/status", authMiddleware, async (req, res) => {
    try {
      const url = SEARXNG_URL();
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);
      const r = await fetch(`${url}/healthz`, { signal: controller.signal });
      clearTimeout(t);
      res.json({ url, reachable: r.ok });
    } catch (err) {
      res.json({ url: SEARXNG_URL(), reachable: false, error: err.message });
    }
  });

  router.get("/api/searxng/search", authMiddleware, async (req, res) => {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.json({ results: [] });
    if (q.length > 500) return res.json({ error: "Query too long" });
    try {
      const params = new URLSearchParams({ q, format: "json", language: "en", pageno: "1" });
      const data = await sxFetch(`/search?${params}`);
      const results = (Array.isArray(data?.results) ? data.results : []).slice(0, 10).map((r) => ({
        title: r.title || "",
        url: r.url || "",
        content: r.content ? r.content.slice(0, 300) : "",
        engine: r.engine || "",
      }));
      res.json({ query: q, results });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
