/**
 * Kavita API Routes — Express router for Crow's Nest Kavita panel
 *
 * Bundle-compatible version: uses env vars directly for API calls.
 * Protected by dashboardAuth. Proxies REST calls to the configured
 * Kavita instance for the dashboard panel.
 */

import { Router } from "express";

const KAVITA_URL = () => (process.env.KAVITA_URL || "http://localhost:5000").replace(/\/+$/, "");
const KAVITA_USERNAME = () => process.env.KAVITA_USERNAME || "";
const KAVITA_PASSWORD = () => process.env.KAVITA_PASSWORD || "";

let cachedToken = null;
let tokenExpiry = 0;

/**
 * Get a JWT token from Kavita, caching for 1 hour.
 */
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(`${KAVITA_URL()}/api/Account/login`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: KAVITA_USERNAME(), password: KAVITA_PASSWORD() }),
    });
    if (!res.ok) throw new Error("Kavita login failed");
    const data = await res.json();
    cachedToken = data.token;
    tokenExpiry = Date.now() + 3600000;
    return cachedToken;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Kavita login timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach Kavita — is the server running?");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch from Kavita API with JWT auth, timeout, and 401 retry.
 */
async function kvFetch(path) {
  const doFetch = async (token) => {
    const url = `${KAVITA_URL()}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) return null;
      if (!res.ok) throw new Error(`Kavita ${res.status}: ${res.statusText}`);
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    } catch (err) {
      if (err.name === "AbortError") throw new Error("Kavita request timed out");
      if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
        throw new Error("Cannot reach Kavita — is the server running?");
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  };

  let token = await getToken();
  let result = await doFetch(token);
  if (result === null) {
    cachedToken = null;
    tokenExpiry = 0;
    token = await getToken();
    result = await doFetch(token);
    if (result === null) throw new Error("Kavita auth failed after retry");
  }
  return result;
}

/**
 * Convert Kavita format enum to string.
 */
function formatType(format) {
  const types = { 0: "Image", 1: "Archive", 2: "Unknown", 3: "EPUB", 4: "PDF", 5: "Image" };
  return types[format] || "Unknown";
}

/**
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {Router}
 */
export default function kavitaRouter(authMiddleware) {
  const router = Router();

  // --- Libraries ---
  router.get("/api/kavita/libraries", authMiddleware, async (req, res) => {
    try {
      const data = await kvFetch("/api/Library");
      const libraries = (data || []).map((lib) => ({
        id: lib.id,
        name: lib.name,
        type: lib.type,
      }));
      res.json({ libraries });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Recently Added ---
  router.get("/api/kavita/recent", authMiddleware, async (req, res) => {
    try {
      const data = await kvFetch("/api/Series/recently-added?pageNumber=1&pageSize=20");
      const items = (Array.isArray(data) ? data : data.content || []).map((s) => ({
        id: s.id,
        name: s.name,
        format: formatType(s.format),
        libraryName: s.libraryName || null,
        pages: s.pages || 0,
      }));
      res.json({ items });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Want to Read ---
  router.get("/api/kavita/want-to-read", authMiddleware, async (req, res) => {
    try {
      const data = await kvFetch("/api/Want-to-read");
      const items = (data || []).map((s) => ({
        id: s.id,
        name: s.name,
        format: formatType(s.format),
        pages: s.pages || 0,
      }));
      res.json({ items });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
