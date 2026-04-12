/**
 * Change Detection dashboard routes.
 * Proxies the /api/v1/watch endpoint with the configured API key.
 */

import { Router } from "express";

const BASE_URL = () => (process.env.CHANGEDETECTION_URL || "http://localhost:5010").replace(/\/+$/, "");
const API_KEY = () => process.env.CHANGEDETECTION_API_KEY || "";

async function cdFetch(path) {
  const url = BASE_URL() + path;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    if (!API_KEY()) {
      const e = new Error("CHANGEDETECTION_API_KEY is not set (Settings > API in the web UI)");
      e.missingAuth = true;
      throw e;
    }
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "x-api-key": API_KEY() },
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error("Authentication failed — check CHANGEDETECTION_API_KEY");
      throw new Error("Change Detection API " + res.status);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Change Detection request timed out");
    if (err.message && (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED"))) {
      throw new Error("Cannot reach Change Detection — is it running?");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function formatTs(n) {
  if (!n || typeof n !== "number") return null;
  try { return new Date(n * 1000).toISOString(); } catch { return null; }
}

export default function changeDetectionRouter(authMiddleware) {
  const router = Router();

  router.get("/api/changedetection/watches", authMiddleware, async (req, res) => {
    try {
      const data = await cdFetch("/api/v1/watch");
      const watches = Object.entries(data || {}).map(([id, w]) => ({
        id,
        url: w.url || null,
        title: w.title || null,
        paused: !!w.paused,
        tag: w.tag || null,
        last_checked: formatTs(w.last_checked),
        last_changed: formatTs(w.last_changed),
        last_error: w.last_error || null,
      }));
      watches.sort((a, b) => (b.last_changed || "").localeCompare(a.last_changed || ""));
      res.json({ watches });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
