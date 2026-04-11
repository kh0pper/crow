/**
 * Shiori API Routes — Express router for Crow's Nest Shiori panel
 *
 * Bundle-compatible version: uses env vars directly for API calls.
 * Protected by dashboardAuth. Proxies REST calls to the configured
 * Shiori instance for the dashboard panel.
 *
 * Shiori uses session-based auth: login to get a token, then use it
 * as a Bearer token. Re-authenticate on 401/403.
 */

import { Router } from "express";

const SHIORI_URL = () => (process.env.SHIORI_URL || "http://localhost:8086").replace(/\/+$/, "");
const SHIORI_USERNAME = () => process.env.SHIORI_USERNAME || "shiori";
const SHIORI_PASSWORD = () => process.env.SHIORI_PASSWORD || "";

let sessionToken = null;

/**
 * Authenticate with Shiori and get a session token.
 */
async function getSession() {
  if (sessionToken) return sessionToken;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(`${SHIORI_URL()}/api/v1/auth/login`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: SHIORI_USERNAME(),
        password: SHIORI_PASSWORD(),
        remember_me: true,
      }),
    });

    if (!res.ok) throw new Error("Shiori login failed");

    const data = await res.json();
    sessionToken = data.message?.session || data.token || data.message;
    return sessionToken;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch from Shiori API with auth and timeout. Re-authenticates on 401/403.
 */
async function shFetch(path, isRetry = false) {
  const token = await getSession();
  const url = `${SHIORI_URL()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Session-Id": token,
      },
    });

    if ((res.status === 401 || res.status === 403) && !isRetry) {
      sessionToken = null;
      return shFetch(path, true);
    }

    if (!res.ok) throw new Error(`Shiori ${res.status}: ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Shiori request timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach Shiori — is the server running?");
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
export default function shioriRouter(authMiddleware) {
  const router = Router();

  // --- Stats ---
  router.get("/api/shiori/stats", authMiddleware, async (req, res) => {
    try {
      const [bookmarks, tags] = await Promise.all([
        shFetch("/api/v1/bookmarks?page=1"),
        shFetch("/api/v1/tags"),
      ]);

      const bookmarkList = bookmarks.bookmarks || bookmarks || [];
      const tagList = tags.tags || tags || [];

      res.json({
        bookmarkCount: bookmarkList.length || 0,
        tagCount: Array.isArray(tagList) ? tagList.length : 0,
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Recent Bookmarks ---
  router.get("/api/shiori/recent", authMiddleware, async (req, res) => {
    try {
      const data = await shFetch("/api/v1/bookmarks?page=1");
      const list = data.bookmarks || data || [];
      const bookmarks = (Array.isArray(list) ? list : []).slice(0, 20).map((b) => ({
        id: b.id,
        url: b.url,
        title: b.title || null,
        excerpt: b.excerpt ? b.excerpt.slice(0, 200) : null,
        tags: (b.tags || []).map((t) => t.name || t),
        hasArchive: b.hasArchive || false,
      }));

      res.json({ bookmarks });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
