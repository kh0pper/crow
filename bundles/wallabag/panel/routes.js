/**
 * Wallabag API Routes — Express router for Crow's Nest Wallabag panel
 *
 * Bundle-compatible version: uses env vars directly for API calls.
 * Protected by dashboardAuth. Proxies REST calls to the configured
 * Wallabag instance for the dashboard panel.
 *
 * Uses OAuth2 password grant for authentication.
 */

import { Router } from "express";

const WALLABAG_URL = () => (process.env.WALLABAG_URL || "http://localhost:8084").replace(/\/+$/, "");
const WALLABAG_CLIENT_ID = () => process.env.WALLABAG_CLIENT_ID || "";
const WALLABAG_CLIENT_SECRET = () => process.env.WALLABAG_CLIENT_SECRET || "";
const WALLABAG_USERNAME = () => process.env.WALLABAG_USERNAME || "";
const WALLABAG_PASSWORD = () => process.env.WALLABAG_PASSWORD || "";

let accessToken = null;
let tokenExpiry = 0;

/**
 * Get a valid OAuth2 access token, refreshing if expired.
 */
async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(`${WALLABAG_URL()}/oauth/v2/token`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "password",
        client_id: WALLABAG_CLIENT_ID(),
        client_secret: WALLABAG_CLIENT_SECRET(),
        username: WALLABAG_USERNAME(),
        password: WALLABAG_PASSWORD(),
      }),
    });

    if (!res.ok) throw new Error("Wallabag OAuth2 login failed");

    const data = await res.json();
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return accessToken;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Wallabag OAuth2 token request timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach Wallabag — is the server running?");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch from Wallabag API with OAuth2 auth and timeout.
 */
async function wbFetch(path) {
  const token = await getAccessToken();
  const url = `${WALLABAG_URL()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (res.status === 401) {
      accessToken = null;
      tokenExpiry = 0;
      throw new Error("Wallabag authentication expired — reload to retry");
    }

    if (!res.ok) throw new Error(`Wallabag ${res.status}: ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Wallabag request timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach Wallabag — is the server running?");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Format reading time estimate.
 */
function formatReadingTime(minutes) {
  if (!minutes) return null;
  if (minutes < 1) return "< 1 min";
  return `${minutes} min`;
}

/**
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {Router}
 */
export default function wallabagRouter(authMiddleware) {
  const router = Router();

  // --- Reading Stats ---
  router.get("/api/wallabag/stats", authMiddleware, async (req, res) => {
    try {
      // Wallabag doesn't have a dedicated stats endpoint, so we query entries with filters
      const [unreadData, archivedData, starredData] = await Promise.all([
        wbFetch("/api/entries.json?archive=0&perPage=1"),
        wbFetch("/api/entries.json?archive=1&perPage=1"),
        wbFetch("/api/entries.json?starred=1&perPage=1"),
      ]);

      res.json({
        unread: unreadData.total || 0,
        archived: archivedData.total || 0,
        starred: starredData.total || 0,
        total: (unreadData.total || 0) + (archivedData.total || 0),
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Tags ---
  router.get("/api/wallabag/tags", authMiddleware, async (req, res) => {
    try {
      const data = await wbFetch("/api/tags.json");
      const tags = (data || []).map((t) => ({
        id: t.id,
        label: t.label,
        slug: t.slug,
        nbEntries: t.nbEntries || 0,
      }));
      res.json({ tags });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Recent Articles ---
  router.get("/api/wallabag/recent", authMiddleware, async (req, res) => {
    try {
      const params = new URLSearchParams({
        sort: "created",
        order: "desc",
        perPage: "20",
      });

      const data = await wbFetch(`/api/entries.json?${params}`);
      const articles = (data._embedded?.items || []).map((e) => ({
        id: e.id,
        title: e.title,
        url: e.url,
        domain: e.domain_name || null,
        is_archived: e.is_archived === 1,
        is_starred: e.is_starred === 1,
        tags: (e.tags || []).map((t) => t.label),
        reading_time: formatReadingTime(e.reading_time),
        created_at: e.created_at,
      }));

      res.json({ articles });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
