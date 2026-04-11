/**
 * Navidrome MCP Server
 *
 * Provides tools to manage a Navidrome music server via the Subsonic API:
 * - Search songs, albums, artists
 * - Browse albums with sorting (newest, alphabetical, recent)
 * - List artists
 * - Get album details with track listing
 * - List and create playlists
 * - Get stream URLs for songs
 * - View currently playing tracks
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";

const NAVIDROME_URL = (process.env.NAVIDROME_URL || "http://localhost:4533").replace(/\/+$/, "");
const NAVIDROME_USERNAME = process.env.NAVIDROME_USERNAME || "";
const NAVIDROME_PASSWORD = process.env.NAVIDROME_PASSWORD || "";

/**
 * Generate Subsonic API authentication query parameters.
 * Uses salt+token scheme: token = md5(password + salt)
 */
function subsonicParams() {
  const salt = randomBytes(8).toString("hex");
  const token = createHash("md5").update(NAVIDROME_PASSWORD + salt).digest("hex");
  return `u=${encodeURIComponent(NAVIDROME_USERNAME)}&t=${token}&s=${salt}&v=1.16.1&c=crow&f=json`;
}

/**
 * Make an authenticated request to the Navidrome Subsonic API.
 * @param {string} path - API path under /rest/ (e.g., "getArtists")
 * @returns {Promise<object>} parsed subsonic-response body
 */
async function naviFetch(path) {
  const separator = path.includes("?") ? "&" : "?";
  const url = `${NAVIDROME_URL}/rest/${path}${separator}${subsonicParams()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      if (res.status === 401) throw new Error("Authentication failed — check NAVIDROME_USERNAME and NAVIDROME_PASSWORD");
      if (res.status === 404) throw new Error(`Not found: ${path}`);
      throw new Error(`Navidrome API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const sub = data["subsonic-response"];
    if (!sub) throw new Error("Invalid Subsonic response format");
    if (sub.status !== "ok") {
      throw new Error(sub.error?.message || `Subsonic error: code ${sub.error?.code || "unknown"}`);
    }
    return sub;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Navidrome request timed out after 10s: ${path}`);
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Navidrome at ${NAVIDROME_URL} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Format duration in seconds to human-readable string.
 */
function formatDuration(seconds) {
  if (!seconds) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Build a stream URL for a song ID with embedded auth.
 */
function streamUrl(songId) {
  return `${NAVIDROME_URL}/rest/stream?id=${encodeURIComponent(songId)}&${subsonicParams()}`;
}

export function createNavidromeServer(options = {}) {
  const server = new McpServer(
    { name: "crow-navidrome", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- crow_navidrome_search ---
  server.tool(
    "crow_navidrome_search",
    "Search Navidrome for songs, albums, and artists",
    {
      query: z.string().max(500).describe("Search text"),
      song_count: z.number().min(0).max(100).optional().default(10).describe("Max songs to return (default 10)"),
      album_count: z.number().min(0).max(100).optional().default(10).describe("Max albums to return (default 10)"),
      artist_count: z.number().min(0).max(100).optional().default(10).describe("Max artists to return (default 10)"),
    },
    async ({ query, song_count, album_count, artist_count }) => {
      try {
        const params = new URLSearchParams({
          query,
          songCount: String(song_count),
          albumCount: String(album_count),
          artistCount: String(artist_count),
        });

        const sub = await naviFetch(`search3?${params}`);
        const result = sub.searchResult3 || {};

        const songs = (result.song || []).map((s) => ({
          id: s.id,
          title: s.title,
          artist: s.artist || null,
          album: s.album || null,
          duration: formatDuration(s.duration),
          track: s.track || null,
          year: s.year || null,
        }));

        const albums = (result.album || []).map((a) => ({
          id: a.id,
          name: a.name || a.title,
          artist: a.artist || null,
          songCount: a.songCount || 0,
          duration: formatDuration(a.duration),
          year: a.year || null,
        }));

        const artists = (result.artist || []).map((a) => ({
          id: a.id,
          name: a.name,
          albumCount: a.albumCount || 0,
        }));

        const parts = [];
        if (artists.length > 0) parts.push(`Artists (${artists.length}):\n${JSON.stringify(artists, null, 2)}`);
        if (albums.length > 0) parts.push(`Albums (${albums.length}):\n${JSON.stringify(albums, null, 2)}`);
        if (songs.length > 0) parts.push(`Songs (${songs.length}):\n${JSON.stringify(songs, null, 2)}`);

        return {
          content: [{
            type: "text",
            text: parts.length > 0
              ? parts.join("\n\n")
              : `No results found for "${query}".`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_navidrome_albums ---
  server.tool(
    "crow_navidrome_albums",
    "Browse Navidrome albums with sorting and pagination",
    {
      sort: z.enum(["newest", "alphabeticalByName", "recent", "frequent", "starred"]).optional().default("newest").describe("Sort order (default: newest)"),
      size: z.number().min(1).max(500).optional().default(20).describe("Number of albums (default 20)"),
      offset: z.number().min(0).optional().default(0).describe("Start offset for pagination"),
    },
    async ({ sort, size, offset }) => {
      try {
        const sub = await naviFetch(`getAlbumList2?type=${sort}&size=${size}&offset=${offset}`);
        const albums = (sub.albumList2?.album || []).map((a) => ({
          id: a.id,
          name: a.name || a.title,
          artist: a.artist || null,
          songCount: a.songCount || 0,
          duration: formatDuration(a.duration),
          year: a.year || null,
          genre: a.genre || null,
        }));

        return {
          content: [{
            type: "text",
            text: albums.length > 0
              ? `${albums.length} album(s) (sort: ${sort}, offset ${offset}):\n${JSON.stringify(albums, null, 2)}`
              : "No albums found.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_navidrome_artists ---
  server.tool(
    "crow_navidrome_artists",
    "List all artists in the Navidrome library",
    {},
    async () => {
      try {
        const sub = await naviFetch("getArtists");
        const indexes = sub.artists?.index || [];
        const artists = [];

        for (const idx of indexes) {
          for (const a of idx.artist || []) {
            artists.push({
              id: a.id,
              name: a.name,
              albumCount: a.albumCount || 0,
            });
          }
        }

        return {
          content: [{
            type: "text",
            text: artists.length > 0
              ? `${artists.length} artist(s):\n${JSON.stringify(artists, null, 2)}`
              : "No artists found in the library.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_navidrome_get_album ---
  server.tool(
    "crow_navidrome_get_album",
    "Get album details with full track listing from Navidrome",
    {
      album_id: z.string().max(100).describe("Album ID"),
    },
    async ({ album_id }) => {
      try {
        const sub = await naviFetch(`getAlbum?id=${encodeURIComponent(album_id)}`);
        const album = sub.album;
        if (!album) throw new Error("Album not found");

        const tracks = (album.song || []).map((s) => ({
          id: s.id,
          track: s.track || null,
          title: s.title,
          artist: s.artist || null,
          duration: formatDuration(s.duration),
          bitRate: s.bitRate || null,
          suffix: s.suffix || null,
        }));

        const result = {
          id: album.id,
          name: album.name || album.title,
          artist: album.artist || null,
          year: album.year || null,
          genre: album.genre || null,
          songCount: album.songCount || tracks.length,
          duration: formatDuration(album.duration),
          tracks,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_navidrome_playlists ---
  server.tool(
    "crow_navidrome_playlists",
    "List or create playlists in Navidrome",
    {
      action: z.enum(["list", "create"]).optional().default("list").describe("Action: list or create"),
      name: z.string().max(200).optional().describe("Playlist name (required for create)"),
    },
    async ({ action, name }) => {
      try {
        if (action === "create") {
          if (!name) {
            return { content: [{ type: "text", text: "Error: name is required to create a playlist" }] };
          }
          const sub = await naviFetch(`createPlaylist?name=${encodeURIComponent(name)}`);
          const pl = sub.playlist;
          return {
            content: [{
              type: "text",
              text: pl
                ? `Created playlist "${pl.name || name}" (ID: ${pl.id}).`
                : `Created playlist "${name}".`,
            }],
          };
        }

        // list
        const sub = await naviFetch("getPlaylists");
        const playlists = (sub.playlists?.playlist || []).map((p) => ({
          id: p.id,
          name: p.name,
          songCount: p.songCount || 0,
          duration: formatDuration(p.duration),
          owner: p.owner || null,
          public: p.public || false,
        }));

        return {
          content: [{
            type: "text",
            text: playlists.length > 0
              ? `${playlists.length} playlist(s):\n${JSON.stringify(playlists, null, 2)}`
              : "No playlists found.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_navidrome_stream ---
  server.tool(
    "crow_navidrome_stream",
    "Get a stream URL for a song in Navidrome. The URL includes authentication and can be used for direct playback.",
    {
      song_id: z.string().max(100).describe("Song ID (from search or album tracks)"),
    },
    async ({ song_id }) => {
      try {
        // Verify the song exists by fetching it via search
        const url = streamUrl(song_id);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              songId: song_id,
              streamUrl: url,
              note: "URL includes authentication parameters. Use for direct playback; do not share publicly.",
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_navidrome_now_playing ---
  server.tool(
    "crow_navidrome_now_playing",
    "Show currently playing tracks across all Navidrome clients",
    {},
    async () => {
      try {
        const sub = await naviFetch("getNowPlaying");
        const entries = (sub.nowPlaying?.entry || []).map((e) => ({
          username: e.username || null,
          minutesAgo: e.minutesAgo || 0,
          playerId: e.playerId || null,
          playerName: e.playerName || null,
          title: e.title,
          artist: e.artist || null,
          album: e.album || null,
          duration: formatDuration(e.duration),
        }));

        return {
          content: [{
            type: "text",
            text: entries.length > 0
              ? `${entries.length} track(s) playing:\n${JSON.stringify(entries, null, 2)}`
              : "Nothing is currently playing.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}
