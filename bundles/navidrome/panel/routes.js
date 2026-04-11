/**
 * Navidrome API Routes — Express router for Crow's Nest Navidrome panel
 *
 * Bundle-compatible version: uses env vars directly for API calls.
 * Protected by dashboardAuth. Proxies Subsonic REST calls to the configured
 * Navidrome instance for the dashboard panel.
 */

import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";

const NAVIDROME_URL = () => (process.env.NAVIDROME_URL || "http://localhost:4533").replace(/\/+$/, "");
const NAVIDROME_USERNAME = () => process.env.NAVIDROME_USERNAME || "";
const NAVIDROME_PASSWORD = () => process.env.NAVIDROME_PASSWORD || "";

/**
 * Generate Subsonic auth query parameters.
 */
function subsonicParams() {
  const salt = randomBytes(8).toString("hex");
  const token = createHash("md5").update(NAVIDROME_PASSWORD() + salt).digest("hex");
  return `u=${encodeURIComponent(NAVIDROME_USERNAME())}&t=${token}&s=${salt}&v=1.16.1&c=crow&f=json`;
}

/**
 * Fetch from Navidrome Subsonic API with auth and timeout.
 */
async function ndFetch(path) {
  const separator = path.includes("?") ? "&" : "?";
  const url = `${NAVIDROME_URL()}/rest/${path}${separator}${subsonicParams()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Navidrome ${res.status}: ${res.statusText}`);
    const data = await res.json();
    const sub = data["subsonic-response"];
    if (!sub) throw new Error("Invalid Subsonic response");
    if (sub.status !== "ok") throw new Error(sub.error?.message || "Subsonic error");
    return sub;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Navidrome request timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach Navidrome — is the server running?");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Format duration in seconds to human-readable.
 */
function formatDuration(seconds) {
  if (!seconds) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {Router}
 */
export default function navidromeRouter(authMiddleware) {
  const router = Router();

  // --- Now Playing ---
  router.get("/api/navidrome/now-playing", authMiddleware, async (req, res) => {
    try {
      const sub = await ndFetch("getNowPlaying");
      const entries = (sub.nowPlaying?.entry || []).map((e) => ({
        title: e.title,
        artist: e.artist || null,
        album: e.album || null,
        username: e.username || null,
        playerName: e.playerName || null,
        duration: formatDuration(e.duration),
      }));
      res.json({ entries });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Recent Albums ---
  router.get("/api/navidrome/albums", authMiddleware, async (req, res) => {
    try {
      const sub = await ndFetch("getAlbumList2?type=newest&size=20&offset=0");
      const albums = (sub.albumList2?.album || []).map((a) => ({
        id: a.id,
        name: a.name || a.title,
        artist: a.artist || null,
        songCount: a.songCount || 0,
        duration: formatDuration(a.duration),
        year: a.year || null,
        genre: a.genre || null,
      }));
      res.json({ albums });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Playlists ---
  router.get("/api/navidrome/playlists", authMiddleware, async (req, res) => {
    try {
      const sub = await ndFetch("getPlaylists");
      const playlists = (sub.playlists?.playlist || []).map((p) => ({
        id: p.id,
        name: p.name,
        songCount: p.songCount || 0,
        duration: formatDuration(p.duration),
        owner: p.owner || null,
      }));
      res.json({ playlists });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
