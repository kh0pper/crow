/**
 * Kodi API Routes — Express router for Crow's Nest Kodi panel
 *
 * Bundle-compatible version: uses dynamic imports with path resolution
 * so this routes file works both from the repo and when installed
 * to ~/.crow/bundles/kodi/.
 *
 * Protected by dashboardAuth. Proxies JSON-RPC calls to the configured
 * Kodi instance for the dashboard panel.
 */

import { Router } from "express";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

// Resolve bundle server directory (installed vs repo)
function resolveBundleServer() {
  const installed = join(homedir(), ".crow", "bundles", "kodi", "server");
  if (existsSync(installed)) return installed;
  return join(import.meta.dirname, "..", "server");
}

const serverDir = resolveBundleServer();

/**
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {Router}
 */
export default function kodiRouter(authMiddleware) {
  const router = Router();

  /** Lazily create a KodiClient */
  let _client = null;
  async function getClient() {
    if (!_client) {
      const { KodiClient } = await import(pathToFileURL(join(serverDir, "jsonrpc.js")).href);
      _client = new KodiClient({
        url: process.env.KODI_URL || "http://localhost:8080",
        user: process.env.KODI_USER || "",
        password: process.env.KODI_PASSWORD || "",
      });
    }
    return _client;
  }

  // --- Now Playing ---
  router.get("/api/kodi/now-playing", authMiddleware, async (req, res) => {
    try {
      const kodi = await getClient();

      const players = await kodi.call("Player.GetActivePlayers");
      if (players.length === 0) {
        // Still fetch volume info
        try {
          const appProps = await kodi.call("Application.GetProperties", {
            properties: ["volume", "muted"],
          });
          return res.json({ title: null, volume: appProps.volume, muted: appProps.muted });
        } catch {
          return res.json({ title: null });
        }
      }

      const pid = players[0].playerid;
      const [item, props, appProps] = await Promise.all([
        kodi.call("Player.GetItem", {
          playerid: pid,
          properties: ["title", "showtitle", "season", "episode", "artist", "album", "year", "thumbnail", "duration"],
        }),
        kodi.call("Player.GetProperties", {
          playerid: pid,
          properties: ["percentage", "time", "totaltime", "speed", "type"],
        }),
        kodi.call("Application.GetProperties", {
          properties: ["volume", "muted"],
        }),
      ]);

      const i = item.item || {};
      const toSec = (t) => (t ? (t.hours || 0) * 3600 + (t.minutes || 0) * 60 + (t.seconds || 0) : 0);
      const fmt = (s) => {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);
        return h > 0
          ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
          : `${m}:${String(sec).padStart(2, "0")}`;
      };

      res.json({
        title: i.title || i.label || "Unknown",
        type: i.type || players[0].type,
        show: i.showtitle || null,
        season: i.season || null,
        episode: i.episode || null,
        artist: i.artist?.length ? i.artist.join(", ") : null,
        album: i.album || null,
        year: i.year || null,
        progress: Math.round(props.percentage || 0),
        elapsed: fmt(toSec(props.time)),
        total: fmt(toSec(props.totaltime)),
        speed: props.speed === 0 ? "paused" : props.speed === 1 ? "playing" : `${props.speed}x`,
        volume: appProps.volume,
        muted: appProps.muted,
        thumbnail: i.thumbnail || null,
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Transport Controls ---
  router.post("/api/kodi/control", authMiddleware, async (req, res) => {
    try {
      const kodi = await getClient();
      const { command, value, media_type, id } = req.body || {};

      // Handle play command from library cards
      if (command === "play" && media_type && id !== undefined) {
        const idFields = {
          movie: "movieid",
          episode: "episodeid",
          song: "songid",
          album: "albumid",
          musicvideo: "musicvideoid",
        };
        const item = { [idFields[media_type] || "movieid"]: id };
        await kodi.call("Player.Open", { item });
        return res.json({ ok: true, message: `Playing ${media_type} #${id}` });
      }

      // Standard transport controls
      switch (command) {
        case "play_pause": {
          const players = await kodi.call("Player.GetActivePlayers");
          if (players.length === 0) return res.json({ ok: false, message: "No active player" });
          await kodi.call("Player.PlayPause", { playerid: players[0].playerid });
          break;
        }
        case "stop": {
          const players = await kodi.call("Player.GetActivePlayers");
          if (players.length === 0) return res.json({ ok: false, message: "No active player" });
          await kodi.call("Player.Stop", { playerid: players[0].playerid });
          break;
        }
        case "seek_forward": {
          const players = await kodi.call("Player.GetActivePlayers");
          if (players.length === 0) return res.json({ ok: false, message: "No active player" });
          await kodi.call("Player.Seek", { playerid: players[0].playerid, value: { seconds: value || 30 } });
          break;
        }
        case "seek_backward": {
          const players = await kodi.call("Player.GetActivePlayers");
          if (players.length === 0) return res.json({ ok: false, message: "No active player" });
          await kodi.call("Player.Seek", { playerid: players[0].playerid, value: { seconds: -(value || 30) } });
          break;
        }
        case "next": {
          const players = await kodi.call("Player.GetActivePlayers");
          if (players.length === 0) return res.json({ ok: false, message: "No active player" });
          await kodi.call("Player.GoTo", { playerid: players[0].playerid, to: "next" });
          break;
        }
        case "previous": {
          const players = await kodi.call("Player.GetActivePlayers");
          if (players.length === 0) return res.json({ ok: false, message: "No active player" });
          await kodi.call("Player.GoTo", { playerid: players[0].playerid, to: "previous" });
          break;
        }
        case "set_volume": {
          const vol = Math.max(0, Math.min(100, value ?? 50));
          await kodi.call("Application.SetVolume", { volume: vol });
          break;
        }
        case "mute":
          await kodi.call("Application.SetMute", { mute: true });
          break;
        case "unmute":
          await kodi.call("Application.SetMute", { mute: false });
          break;
        default:
          return res.json({ ok: false, message: `Unknown command: ${command}` });
      }

      res.json({ ok: true });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- GUI Navigation ---
  router.post("/api/kodi/navigate", authMiddleware, async (req, res) => {
    try {
      const kodi = await getClient();
      const { action } = req.body || {};

      const actionMap = {
        Up: "Input.Up",
        Down: "Input.Down",
        Left: "Input.Left",
        Right: "Input.Right",
        Select: "Input.Select",
        Back: "Input.Back",
        Home: "Input.Home",
        ContextMenu: "Input.ContextMenu",
        Info: "Input.Info",
      };

      const method = actionMap[action];
      if (!method) {
        return res.json({ ok: false, message: `Unknown action: ${action}` });
      }

      await kodi.call(method);
      res.json({ ok: true });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Library Browse ---
  router.get("/api/kodi/library/:type", authMiddleware, async (req, res) => {
    try {
      const kodi = await getClient();
      const mediaType = req.params.type;
      const sortBy = req.query.sort_by || "title";
      const limit = Math.min(parseInt(req.query.limit || "24", 10), 100);
      const offset = parseInt(req.query.offset || "0", 10);

      const sortMap = { title: "title", year: "year", rating: "rating", dateadded: "dateadded" };
      const sort = { method: sortMap[sortBy] || "title", order: sortBy === "rating" ? "descending" : "ascending" };
      const limits = { start: offset, end: offset + limit };

      let items = [];
      let total = 0;

      switch (mediaType) {
        case "movie": {
          const data = await kodi.call("VideoLibrary.GetMovies", {
            properties: ["title", "year", "rating", "runtime", "genre", "playcount"],
            limits, sort,
          });
          total = data.limits?.total || 0;
          items = (data.movies || []).map((m) => ({
            id: m.movieid, title: m.title, year: m.year,
            rating: m.rating ? Math.round(m.rating * 10) / 10 : null,
            runtime: m.runtime ? `${Math.round(m.runtime / 60)}m` : null,
            genre: m.genre?.join(", "), plays: m.playcount,
          }));
          break;
        }
        case "tvshow": {
          const data = await kodi.call("VideoLibrary.GetTVShows", {
            properties: ["title", "year", "rating", "season", "episode", "genre"],
            limits, sort,
          });
          total = data.limits?.total || 0;
          items = (data.tvshows || []).map((s) => ({
            id: s.tvshowid, title: s.title, year: s.year,
            rating: s.rating ? Math.round(s.rating * 10) / 10 : null,
            seasons: s.season, episodes: s.episode,
            genre: s.genre?.join(", "),
          }));
          break;
        }
        case "artist": {
          const data = await kodi.call("AudioLibrary.GetArtists", {
            properties: ["artist", "genre"],
            limits,
            sort: { method: sortBy === "title" ? "artist" : sortMap[sortBy] || "artist", order: sort.order },
          });
          total = data.limits?.total || 0;
          items = (data.artists || []).map((a) => ({
            id: a.artistid, name: a.artist, genre: a.genre?.join(", "),
          }));
          break;
        }
        case "album": {
          const data = await kodi.call("AudioLibrary.GetAlbums", {
            properties: ["title", "artist", "year", "genre"],
            limits, sort,
          });
          total = data.limits?.total || 0;
          items = (data.albums || []).map((a) => ({
            id: a.albumid, title: a.title, artist: a.artist?.join(", "),
            year: a.year, genre: a.genre?.join(", "),
          }));
          break;
        }
        default:
          return res.json({ error: `Unknown media type: ${mediaType}` });
      }

      res.json({ items, total });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
