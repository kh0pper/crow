/**
 * Kodi MCP Server
 *
 * Provides tools to remote-control a Kodi media center via JSON-RPC:
 * - System status and player info
 * - Now-playing details with progress
 * - Transport controls (play/pause, stop, seek, volume)
 * - Library search (movies, TV shows, music)
 * - Play items by library ID or direct URL
 * - Browse library with sorting and pagination
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KodiClient } from "./jsonrpc.js";

const KODI_URL = process.env.KODI_URL || "http://localhost:8080";
const KODI_USER = process.env.KODI_USER || "";
const KODI_PASSWORD = process.env.KODI_PASSWORD || "";

/**
 * Format seconds into H:MM:SS or M:SS
 */
function formatTime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Convert Kodi time object { hours, minutes, seconds, milliseconds } to total seconds
 */
function timeToSeconds(t) {
  if (!t) return 0;
  return (t.hours || 0) * 3600 + (t.minutes || 0) * 60 + (t.seconds || 0);
}

export function createKodiServer(options = {}) {
  const kodi = new KodiClient({
    url: KODI_URL,
    user: KODI_USER,
    password: KODI_PASSWORD,
  });

  const server = new McpServer(
    { name: "crow-kodi", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- crow_kodi_status ---
  server.tool(
    "crow_kodi_status",
    "Get Kodi system info: version, active players, and status",
    {},
    async () => {
      try {
        const [appProps, players] = await Promise.all([
          kodi.call("Application.GetProperties", {
            properties: ["name", "version", "volume", "muted"],
          }),
          kodi.call("Player.GetActivePlayers"),
        ]);

        const ver = appProps.version;
        const versionStr = `${ver.major}.${ver.minor}.${ver.tag}`;
        const playerSummary = players.length === 0
          ? "No active players"
          : players.map((p) => `Player ${p.playerid}: ${p.type}`).join(", ");

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              application: appProps.name,
              version: versionStr,
              volume: appProps.volume,
              muted: appProps.muted,
              activePlayers: playerSummary,
              playerCount: players.length,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_kodi_now_playing ---
  server.tool(
    "crow_kodi_now_playing",
    "Get detailed info about what is currently playing: title, progress, elapsed/total time, speed",
    {},
    async () => {
      try {
        const players = await kodi.call("Player.GetActivePlayers");
        if (players.length === 0) {
          return { content: [{ type: "text", text: "Nothing is currently playing." }] };
        }

        const pid = players[0].playerid;
        const [item, props] = await Promise.all([
          kodi.call("Player.GetItem", {
            playerid: pid,
            properties: ["title", "showtitle", "season", "episode", "artist", "album", "year", "thumbnail", "file", "duration"],
          }),
          kodi.call("Player.GetProperties", {
            playerid: pid,
            properties: ["percentage", "time", "totaltime", "speed", "type", "repeat", "shuffled"],
          }),
        ]);

        const i = item.item || {};
        const elapsed = timeToSeconds(props.time);
        const total = timeToSeconds(props.totaltime);

        const result = {
          title: i.title || i.label || "Unknown",
          type: i.type || players[0].type,
          ...(i.showtitle && { show: i.showtitle, season: i.season, episode: i.episode }),
          ...(i.artist?.length && { artist: i.artist.join(", ") }),
          ...(i.album && { album: i.album }),
          ...(i.year && { year: i.year }),
          progress: `${Math.round(props.percentage || 0)}%`,
          elapsed: formatTime(elapsed),
          total: formatTime(total),
          speed: props.speed === 0 ? "paused" : props.speed === 1 ? "playing" : `${props.speed}x`,
          repeat: props.repeat || "off",
          shuffled: props.shuffled || false,
          ...(i.thumbnail && { thumbnail: i.thumbnail }),
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_kodi_control ---
  server.tool(
    "crow_kodi_control",
    "Transport controls: play/pause, stop, seek, skip, volume. Use command + optional value.",
    {
      command: z.enum([
        "play_pause", "stop", "seek_forward", "seek_backward",
        "next", "previous", "set_volume", "mute", "unmute",
      ]).describe("Control command"),
      value: z.number().optional().describe("Value: volume 0-100, or seek offset in seconds (default 30)"),
    },
    async ({ command, value }) => {
      try {
        let msg;
        switch (command) {
          case "play_pause": {
            const players = await kodi.call("Player.GetActivePlayers");
            if (players.length === 0) return { content: [{ type: "text", text: "No active player to pause/resume." }] };
            await kodi.call("Player.PlayPause", { playerid: players[0].playerid });
            msg = "Toggled play/pause.";
            break;
          }
          case "stop": {
            const players = await kodi.call("Player.GetActivePlayers");
            if (players.length === 0) return { content: [{ type: "text", text: "No active player to stop." }] };
            await kodi.call("Player.Stop", { playerid: players[0].playerid });
            msg = "Playback stopped.";
            break;
          }
          case "seek_forward": {
            const players = await kodi.call("Player.GetActivePlayers");
            if (players.length === 0) return { content: [{ type: "text", text: "No active player." }] };
            const secs = value || 30;
            await kodi.call("Player.Seek", {
              playerid: players[0].playerid,
              value: { seconds: secs },
            });
            msg = `Seeked forward ${secs} seconds.`;
            break;
          }
          case "seek_backward": {
            const players = await kodi.call("Player.GetActivePlayers");
            if (players.length === 0) return { content: [{ type: "text", text: "No active player." }] };
            const secs = value || 30;
            await kodi.call("Player.Seek", {
              playerid: players[0].playerid,
              value: { seconds: -secs },
            });
            msg = `Seeked backward ${secs} seconds.`;
            break;
          }
          case "next": {
            const players = await kodi.call("Player.GetActivePlayers");
            if (players.length === 0) return { content: [{ type: "text", text: "No active player." }] };
            await kodi.call("Player.GoTo", { playerid: players[0].playerid, to: "next" });
            msg = "Skipped to next.";
            break;
          }
          case "previous": {
            const players = await kodi.call("Player.GetActivePlayers");
            if (players.length === 0) return { content: [{ type: "text", text: "No active player." }] };
            await kodi.call("Player.GoTo", { playerid: players[0].playerid, to: "previous" });
            msg = "Skipped to previous.";
            break;
          }
          case "set_volume": {
            const vol = Math.max(0, Math.min(100, value ?? 50));
            await kodi.call("Application.SetVolume", { volume: vol });
            msg = `Volume set to ${vol}.`;
            break;
          }
          case "mute": {
            await kodi.call("Application.SetMute", { mute: true });
            msg = "Muted.";
            break;
          }
          case "unmute": {
            await kodi.call("Application.SetMute", { mute: false });
            msg = "Unmuted.";
            break;
          }
        }
        return { content: [{ type: "text", text: msg }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_kodi_search ---
  server.tool(
    "crow_kodi_search",
    "Search Kodi library by title/name. Returns matching items with basic metadata.",
    {
      query: z.string().max(500).describe("Search text"),
      media_type: z.enum(["movie", "tvshow", "episode", "artist", "album", "song"]).describe("Type of media to search"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Max results (default 20)"),
    },
    async ({ query, media_type, limit }) => {
      try {
        const filter = {
          operator: "contains",
          field: media_type === "artist" || media_type === "album" || media_type === "song" ? "title" : "title",
          value: query,
        };

        // Adjust filter field for artists
        if (media_type === "artist") {
          filter.field = "artist";
        }

        let results = [];

        switch (media_type) {
          case "movie": {
            const data = await kodi.call("VideoLibrary.GetMovies", {
              filter,
              properties: ["title", "year", "rating", "runtime", "genre", "playcount", "thumbnail"],
              limits: { start: 0, end: limit },
              sort: { method: "title", order: "ascending" },
            });
            results = (data.movies || []).map((m) => ({
              id: m.movieid, title: m.title, year: m.year,
              rating: m.rating ? Math.round(m.rating * 10) / 10 : null,
              runtime: m.runtime ? `${Math.round(m.runtime / 60)}m` : null,
              genre: m.genre?.join(", "), plays: m.playcount,
            }));
            break;
          }
          case "tvshow": {
            const data = await kodi.call("VideoLibrary.GetTVShows", {
              filter,
              properties: ["title", "year", "rating", "season", "episode", "genre", "thumbnail"],
              limits: { start: 0, end: limit },
              sort: { method: "title", order: "ascending" },
            });
            results = (data.tvshows || []).map((s) => ({
              id: s.tvshowid, title: s.title, year: s.year,
              rating: s.rating ? Math.round(s.rating * 10) / 10 : null,
              seasons: s.season, episodes: s.episode,
              genre: s.genre?.join(", "),
            }));
            break;
          }
          case "episode": {
            const data = await kodi.call("VideoLibrary.GetEpisodes", {
              filter,
              properties: ["title", "showtitle", "season", "episode", "runtime", "playcount", "firstaired"],
              limits: { start: 0, end: limit },
              sort: { method: "title", order: "ascending" },
            });
            results = (data.episodes || []).map((e) => ({
              id: e.episodeid, title: e.title, show: e.showtitle,
              season: e.season, episode: e.episode,
              runtime: e.runtime ? `${Math.round(e.runtime / 60)}m` : null,
              aired: e.firstaired, plays: e.playcount,
            }));
            break;
          }
          case "artist": {
            const data = await kodi.call("AudioLibrary.GetArtists", {
              filter,
              properties: ["artist", "genre", "thumbnail"],
              limits: { start: 0, end: limit },
              sort: { method: "artist", order: "ascending" },
            });
            results = (data.artists || []).map((a) => ({
              id: a.artistid, name: a.artist,
              genre: a.genre?.join(", "),
            }));
            break;
          }
          case "album": {
            const data = await kodi.call("AudioLibrary.GetAlbums", {
              filter,
              properties: ["title", "artist", "year", "genre", "thumbnail"],
              limits: { start: 0, end: limit },
              sort: { method: "title", order: "ascending" },
            });
            results = (data.albums || []).map((a) => ({
              id: a.albumid, title: a.title,
              artist: a.artist?.join(", "), year: a.year,
              genre: a.genre?.join(", "),
            }));
            break;
          }
          case "song": {
            const data = await kodi.call("AudioLibrary.GetSongs", {
              filter,
              properties: ["title", "artist", "album", "duration", "track", "year", "playcount"],
              limits: { start: 0, end: limit },
              sort: { method: "title", order: "ascending" },
            });
            results = (data.songs || []).map((s) => ({
              id: s.songid, title: s.title,
              artist: s.artist?.join(", "), album: s.album,
              duration: s.duration ? formatTime(s.duration) : null,
              track: s.track, year: s.year, plays: s.playcount,
            }));
            break;
          }
        }

        return {
          content: [{
            type: "text",
            text: results.length > 0
              ? `Found ${results.length} ${media_type}(s):\n${JSON.stringify(results, null, 2)}`
              : `No ${media_type}s found matching "${query}".`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_kodi_play ---
  server.tool(
    "crow_kodi_play",
    "Play a library item by ID, or a direct file/URL. Specify media_type + id for library items, or file for direct playback.",
    {
      media_type: z.enum(["movie", "episode", "song", "album", "musicvideo"]).optional().describe("Library item type"),
      id: z.number().optional().describe("Library item ID (from search/browse results)"),
      file: z.string().max(2000).optional().describe("Direct file path or URL to play"),
      resume: z.boolean().optional().default(false).describe("Resume from last position (library items only)"),
    },
    async ({ media_type, id, file, resume }) => {
      try {
        if (!file && (!media_type || id === undefined)) {
          return { content: [{ type: "text", text: "Provide either media_type + id, or a file path/URL." }] };
        }

        let item;
        if (file) {
          item = { file };
        } else {
          const idFields = {
            movie: "movieid",
            episode: "episodeid",
            song: "songid",
            album: "albumid",
            musicvideo: "musicvideoid",
          };
          item = { [idFields[media_type]]: id };
        }

        const options = {};
        if (resume && !file) {
          options.resume = true;
        }

        await kodi.call("Player.Open", {
          item,
          options,
        });

        const label = file ? file : `${media_type} #${id}`;
        return { content: [{ type: "text", text: `Now playing: ${label}${resume ? " (resumed)" : ""}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_kodi_browse ---
  server.tool(
    "crow_kodi_browse",
    "Browse Kodi library by type with sorting and pagination",
    {
      media_type: z.enum(["movie", "tvshow", "artist", "album"]).describe("Library type to browse"),
      sort_by: z.enum(["title", "year", "rating", "dateadded"]).optional().default("title").describe("Sort field"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Items per page (default 20)"),
      offset: z.number().min(0).optional().default(0).describe("Start offset for pagination"),
    },
    async ({ media_type, sort_by, limit, offset }) => {
      try {
        const sortMap = { title: "title", year: "year", rating: "rating", dateadded: "dateadded" };
        const sort = { method: sortMap[sort_by] || "title", order: sort_by === "rating" ? "descending" : "ascending" };
        const limits = { start: offset, end: offset + limit };

        let results = [];
        let total = 0;

        switch (media_type) {
          case "movie": {
            const data = await kodi.call("VideoLibrary.GetMovies", {
              properties: ["title", "year", "rating", "runtime", "genre", "playcount"],
              limits, sort,
            });
            total = data.limits?.total || 0;
            results = (data.movies || []).map((m) => ({
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
            results = (data.tvshows || []).map((s) => ({
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
              sort: { method: sort_by === "title" ? "artist" : sortMap[sort_by] || "artist", order: sort.order },
            });
            total = data.limits?.total || 0;
            results = (data.artists || []).map((a) => ({
              id: a.artistid, name: a.artist,
              genre: a.genre?.join(", "),
            }));
            break;
          }
          case "album": {
            const data = await kodi.call("AudioLibrary.GetAlbums", {
              properties: ["title", "artist", "year", "genre"],
              limits, sort,
            });
            total = data.limits?.total || 0;
            results = (data.albums || []).map((a) => ({
              id: a.albumid, title: a.title,
              artist: a.artist?.join(", "), year: a.year,
              genre: a.genre?.join(", "),
            }));
            break;
          }
        }

        return {
          content: [{
            type: "text",
            text: results.length > 0
              ? `Showing ${results.length} of ${total} ${media_type}(s) (offset ${offset}):\n${JSON.stringify(results, null, 2)}`
              : `No ${media_type}s found in library.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}
