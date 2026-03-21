/**
 * Plex API Routes — Express router for Crow's Nest Plex panel
 *
 * Bundle-compatible version: uses env vars directly for API calls.
 * Protected by dashboardAuth. Proxies REST calls to the configured
 * Plex instance for the dashboard panel.
 */

import { Router } from "express";

const PLEX_URL = () => (process.env.PLEX_URL || "http://localhost:32400").replace(/\/+$/, "");
const PLEX_TOKEN = () => process.env.PLEX_TOKEN || "";

/**
 * Fetch from Plex API with auth, JSON header, and timeout.
 */
async function pFetch(path) {
  const base = PLEX_URL();
  const token = PLEX_TOKEN();
  const separator = path.includes("?") ? "&" : "?";
  const url = `${base}${path}${separator}X-Plex-Token=${encodeURIComponent(token)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "X-Plex-Client-Identifier": "crow-mcp",
      },
    });
    if (!res.ok) throw new Error(`Plex ${res.status}: ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Plex request timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach Plex — is the server running?");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Format milliseconds to human-readable duration.
 */
function formatDuration(ms) {
  if (!ms) return null;
  const totalSeconds = Math.floor(ms / 1000);
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
export default function plexRouter(authMiddleware) {
  const router = Router();

  // --- On Deck ---
  router.get("/api/plex/on-deck", authMiddleware, async (req, res) => {
    try {
      const data = await pFetch("/library/onDeck");
      const container = data.MediaContainer || {};
      const items = (container.Metadata || []).map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        show: item.grandparentTitle || item.parentTitle || null,
        season: item.parentIndex,
        episode: item.index,
        year: item.year || null,
        runtime: formatDuration(item.duration),
        resumePosition: formatDuration(item.viewOffset),
      }));

      res.json({ items });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Proxied stream URL ---
  router.get("/api/plex/stream/:ratingKey", authMiddleware, async (req, res) => {
    try {
      const ratingKey = req.params.ratingKey;
      const data = await pFetch(`/library/metadata/${encodeURIComponent(ratingKey)}`);
      const container = data.MediaContainer || {};
      const items = container.Metadata || [];

      if (items.length === 0) {
        return res.json({ error: "Item not found" });
      }

      const item = items[0];
      const media = item.Media?.[0];
      const part = media?.Part?.[0];

      if (!part?.key) {
        return res.json({ error: "No streamable media found for this item" });
      }

      const base = PLEX_URL();
      const token = PLEX_TOKEN();
      const streamUrl = `${base}${part.key}?X-Plex-Token=${encodeURIComponent(token)}`;

      res.json({
        name: item.title,
        type: item.type,
        streamUrl,
        runtime: formatDuration(item.duration),
        container: media.container || null,
        audioCodec: media.audioCodec || null,
        videoCodec: media.videoCodec || null,
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Active Sessions + Server Info + Libraries ---
  router.get("/api/plex/sessions", authMiddleware, async (req, res) => {
    try {
      const [sessionsData, identityData, librariesData] = await Promise.all([
        pFetch("/status/sessions").catch(() => ({})),
        pFetch("/identity").catch(() => ({})),
        pFetch("/library/sections").catch(() => ({})),
      ]);

      // Server info
      const id = identityData.MediaContainer || {};
      const serverInfo = {
        friendlyName: id.friendlyName || null,
        version: id.version || null,
        platform: id.platform || null,
        machineIdentifier: id.machineIdentifier || null,
      };

      // Libraries
      const libContainer = librariesData.MediaContainer || {};
      const libraries = (libContainer.Directory || []).map((s) => ({
        id: s.key,
        title: s.title,
        type: s.type,
      }));

      // Sessions
      const sesContainer = sessionsData.MediaContainer || {};
      const sessions = (sesContainer.Metadata || []).map((s) => {
        const progress = s.duration ? Math.round((s.viewOffset || 0) / s.duration * 100) : 0;
        const transcode = s.TranscodeSession;

        return {
          sessionId: s.sessionKey,
          title: s.title,
          type: s.type,
          show: s.grandparentTitle || null,
          user: s.User?.title || "Unknown",
          player: s.Player?.title || "Unknown",
          platform: s.Player?.platform || "Unknown",
          state: s.Player?.state || null,
          progress,
          position: formatDuration(s.viewOffset),
          duration: formatDuration(s.duration),
          transcoding: transcode
            ? `${transcode.videoDecision || "direct"} video, ${transcode.audioDecision || "direct"} audio`
            : null,
        };
      });

      res.json({ serverInfo, libraries, sessions });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
