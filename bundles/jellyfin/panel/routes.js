/**
 * Jellyfin API Routes — Express router for Crow's Nest Jellyfin panel
 *
 * Bundle-compatible version: uses env vars directly for API calls.
 * Protected by dashboardAuth. Proxies REST calls to the configured
 * Jellyfin instance for the dashboard panel.
 */

import { Router } from "express";

const JELLYFIN_URL = () => (process.env.JELLYFIN_URL || "http://localhost:8096").replace(/\/+$/, "");
const JELLYFIN_API_KEY = () => process.env.JELLYFIN_API_KEY || "";
const JELLYFIN_USER_ID = () => process.env.JELLYFIN_USER_ID || "";

/**
 * Fetch from Jellyfin API with auth and timeout.
 */
async function jfFetch(path) {
  const url = `${JELLYFIN_URL()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "X-Emby-Token": JELLYFIN_API_KEY() },
    });
    if (!res.ok) throw new Error(`Jellyfin ${res.status}: ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Jellyfin request timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach Jellyfin — is the server running?");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Format runtime ticks to human-readable duration.
 */
function formatTicks(ticks) {
  if (!ticks) return null;
  const totalSeconds = Math.floor(ticks / 10000000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {Router}
 */
export default function jellyfinRouter(authMiddleware) {
  const router = Router();

  // --- Library Stats ---
  router.get("/api/jellyfin/stats", authMiddleware, async (req, res) => {
    try {
      const data = await jfFetch("/Items/Counts");
      res.json(data);
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Recently Added ---
  router.get("/api/jellyfin/recent", authMiddleware, async (req, res) => {
    try {
      const params = new URLSearchParams({
        Limit: "20",
        Recursive: "true",
        SortBy: "DateCreated",
        SortOrder: "Descending",
        IncludeItemTypes: "Movie,Series,MusicAlbum",
        Fields: "Genres,RunTimeTicks,ProductionYear",
      });
      const userId = JELLYFIN_USER_ID();
      if (userId) params.set("UserId", userId);

      const data = await jfFetch(`/Items?${params}`);
      const items = (data.Items || []).map((item) => ({
        id: item.Id,
        name: item.Name,
        type: item.Type,
        year: item.ProductionYear || null,
        runtime: formatTicks(item.RunTimeTicks),
        genres: item.Genres?.join(", ") || null,
        streamUrl: item.Type === "Movie" || item.Type === "Audio"
          ? `${JELLYFIN_URL()}/Videos/${item.Id}/stream?static=true&api_key=${JELLYFIN_API_KEY()}`
          : null,
      }));

      res.json({ items });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Stream URL ---
  router.get("/api/jellyfin/stream/:itemId", authMiddleware, async (req, res) => {
    try {
      const itemId = req.params.itemId;
      const paramsStr = JELLYFIN_USER_ID() ? `?UserId=${JELLYFIN_USER_ID()}` : "";
      const item = await jfFetch(`/Items/${encodeURIComponent(itemId)}${paramsStr}`);

      const isAudio = item.Type === "Audio" || item.Type === "MusicAlbum";
      const streamType = isAudio ? "Audio" : "Videos";
      const streamUrl = `${JELLYFIN_URL()}/${streamType}/${encodeURIComponent(itemId)}/stream?static=true&api_key=${JELLYFIN_API_KEY()}`;

      res.json({
        name: item.Name,
        type: item.Type,
        streamUrl,
        runtime: formatTicks(item.RunTimeTicks),
        container: item.Container || null,
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Active Sessions ---
  router.get("/api/jellyfin/sessions", authMiddleware, async (req, res) => {
    try {
      const data = await jfFetch("/Sessions");
      const sessions = (data || [])
        .filter((s) => s.NowPlayingItem)
        .map((s) => ({
          sessionId: s.Id,
          client: s.Client,
          device: s.DeviceName,
          user: s.UserName,
          nowPlaying: s.NowPlayingItem.Name,
          type: s.NowPlayingItem.Type,
          isPaused: s.PlayState?.IsPaused || false,
          position: formatTicks(s.PlayState?.PositionTicks),
        }));

      res.json({ sessions });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
