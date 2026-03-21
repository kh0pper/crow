/**
 * Jellyfin MCP Server
 *
 * Provides tools to manage a Jellyfin media server via REST API:
 * - Search library (movies, TV, music)
 * - Browse collections with sorting and pagination
 * - Get item details
 * - Start playback / get stream URLs
 * - View active sessions
 * - Remote control (play/pause, stop, seek, volume)
 * - List libraries/collections
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const JELLYFIN_URL = (process.env.JELLYFIN_URL || "http://localhost:8096").replace(/\/+$/, "");
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY || "";
const JELLYFIN_USER_ID = process.env.JELLYFIN_USER_ID || "";

/**
 * Make an authenticated request to the Jellyfin API.
 * @param {string} path - API path (e.g., "/Items")
 * @param {object} [options] - fetch options
 * @returns {Promise<any>} parsed JSON response
 */
async function jellyfinFetch(path, options = {}) {
  const url = `${JELLYFIN_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "X-Emby-Token": JELLYFIN_API_KEY,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error("Authentication failed — check JELLYFIN_API_KEY");
      if (res.status === 404) throw new Error(`Not found: ${path}`);
      throw new Error(`Jellyfin API error: ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Jellyfin request timed out after 10s: ${path}`);
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Jellyfin at ${JELLYFIN_URL} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Format runtime ticks (100-nanosecond intervals) to human-readable duration.
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

export function createJellyfinServer(options = {}) {
  const server = new McpServer(
    { name: "crow-jellyfin", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- crow_jellyfin_search ---
  server.tool(
    "crow_jellyfin_search",
    "Search the Jellyfin media library by title/name. Returns matching items with metadata.",
    {
      query: z.string().max(500).describe("Search text"),
      media_types: z.array(
        z.enum(["Movie", "Series", "Audio", "Episode", "MusicAlbum"])
      ).optional().describe("Filter by media types (default: all)"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Max results (default 20)"),
    },
    async ({ query, media_types, limit }) => {
      try {
        const params = new URLSearchParams({
          searchTerm: query,
          Limit: String(limit),
          Recursive: "true",
          Fields: "Overview,Genres,CommunityRating,RunTimeTicks,ProductionYear,DateCreated",
        });
        if (media_types?.length) {
          params.set("IncludeItemTypes", media_types.join(","));
        }
        if (JELLYFIN_USER_ID) {
          params.set("UserId", JELLYFIN_USER_ID);
        }

        const data = await jellyfinFetch(`/Items?${params}`);
        const items = (data.Items || []).map((item) => ({
          id: item.Id,
          name: item.Name,
          type: item.Type,
          year: item.ProductionYear || null,
          rating: item.CommunityRating ? Math.round(item.CommunityRating * 10) / 10 : null,
          runtime: formatTicks(item.RunTimeTicks),
          genres: item.Genres?.join(", ") || null,
          overview: item.Overview ? item.Overview.slice(0, 200) + (item.Overview.length > 200 ? "..." : "") : null,
        }));

        return {
          content: [{
            type: "text",
            text: items.length > 0
              ? `Found ${items.length} result(s):\n${JSON.stringify(items, null, 2)}`
              : `No results found for "${query}".`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_jellyfin_browse ---
  server.tool(
    "crow_jellyfin_browse",
    "Browse Jellyfin library by collection or media type with sorting and pagination",
    {
      parent_id: z.string().max(100).optional().describe("Parent folder/collection ID to browse within"),
      media_type: z.enum(["Movie", "Series", "Audio", "Episode", "MusicAlbum"]).optional().describe("Filter by media type"),
      sort_by: z.enum(["DateCreated", "SortName", "CommunityRating"]).optional().default("SortName").describe("Sort field"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Items per page (default 20)"),
      offset: z.number().min(0).optional().default(0).describe("Start offset for pagination"),
    },
    async ({ parent_id, media_type, sort_by, limit, offset }) => {
      try {
        const params = new URLSearchParams({
          Limit: String(limit),
          StartIndex: String(offset),
          Recursive: "true",
          SortBy: sort_by,
          SortOrder: sort_by === "CommunityRating" ? "Descending" : "Ascending",
          Fields: "Overview,Genres,CommunityRating,RunTimeTicks,ProductionYear",
        });
        if (parent_id) params.set("ParentId", parent_id);
        if (media_type) params.set("IncludeItemTypes", media_type);
        if (JELLYFIN_USER_ID) params.set("UserId", JELLYFIN_USER_ID);

        const data = await jellyfinFetch(`/Items?${params}`);
        const total = data.TotalRecordCount || 0;
        const items = (data.Items || []).map((item) => ({
          id: item.Id,
          name: item.Name,
          type: item.Type,
          year: item.ProductionYear || null,
          rating: item.CommunityRating ? Math.round(item.CommunityRating * 10) / 10 : null,
          runtime: formatTicks(item.RunTimeTicks),
          genres: item.Genres?.join(", ") || null,
        }));

        return {
          content: [{
            type: "text",
            text: items.length > 0
              ? `Showing ${items.length} of ${total} item(s) (offset ${offset}):\n${JSON.stringify(items, null, 2)}`
              : "No items found.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_jellyfin_get_item ---
  server.tool(
    "crow_jellyfin_get_item",
    "Get detailed information about a specific Jellyfin library item",
    {
      item_id: z.string().max(100).describe("Item ID"),
    },
    async ({ item_id }) => {
      try {
        const params = JELLYFIN_USER_ID ? `?UserId=${JELLYFIN_USER_ID}` : "";
        const item = await jellyfinFetch(`/Items/${encodeURIComponent(item_id)}${params}`);

        const result = {
          id: item.Id,
          name: item.Name,
          type: item.Type,
          year: item.ProductionYear || null,
          rating: item.CommunityRating ? Math.round(item.CommunityRating * 10) / 10 : null,
          runtime: formatTicks(item.RunTimeTicks),
          genres: item.Genres?.join(", ") || null,
          overview: item.Overview || null,
          studios: item.Studios?.map((s) => s.Name).join(", ") || null,
          people: item.People?.slice(0, 10).map((p) => `${p.Name} (${p.Type})`).join(", ") || null,
          mediaStreams: item.MediaStreams?.map((s) => ({
            type: s.Type,
            codec: s.Codec,
            language: s.Language || null,
            title: s.Title || null,
            index: s.Index,
          })) || [],
          path: item.Path || null,
          dateAdded: item.DateCreated || null,
          playCount: item.UserData?.PlayCount || 0,
          played: item.UserData?.Played || false,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_jellyfin_play ---
  server.tool(
    "crow_jellyfin_play",
    "Get a direct stream URL for a Jellyfin item. Use for playback or sharing.",
    {
      item_id: z.string().max(100).describe("Item ID to play"),
      audio_stream_index: z.number().optional().describe("Audio stream index (from get_item mediaStreams)"),
      subtitle_index: z.number().optional().describe("Subtitle stream index (from get_item mediaStreams)"),
    },
    async ({ item_id, audio_stream_index, subtitle_index }) => {
      try {
        // Get item to determine type
        const params = JELLYFIN_USER_ID ? `?UserId=${JELLYFIN_USER_ID}` : "";
        const item = await jellyfinFetch(`/Items/${encodeURIComponent(item_id)}${params}`);

        const isAudio = item.Type === "Audio" || item.Type === "MusicAlbum";
        const streamType = isAudio ? "Audio" : "Videos";
        const streamParams = new URLSearchParams({
          static: "true",
          api_key: JELLYFIN_API_KEY,
        });
        if (audio_stream_index !== undefined) {
          streamParams.set("AudioStreamIndex", String(audio_stream_index));
        }
        if (subtitle_index !== undefined) {
          streamParams.set("SubtitleStreamIndex", String(subtitle_index));
        }

        const streamUrl = `${JELLYFIN_URL}/${streamType}/${encodeURIComponent(item_id)}/stream?${streamParams}`;

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              name: item.Name,
              type: item.Type,
              streamUrl,
              runtime: formatTicks(item.RunTimeTicks),
              container: item.Container || null,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_jellyfin_now_playing ---
  server.tool(
    "crow_jellyfin_now_playing",
    "Get active Jellyfin sessions with current playback information",
    {},
    async () => {
      try {
        const sessions = await jellyfinFetch("/Sessions");
        const active = sessions
          .filter((s) => s.NowPlayingItem)
          .map((s) => ({
            sessionId: s.Id,
            client: s.Client,
            deviceName: s.DeviceName,
            userName: s.UserName,
            nowPlaying: {
              name: s.NowPlayingItem.Name,
              type: s.NowPlayingItem.Type,
              year: s.NowPlayingItem.ProductionYear || null,
              runtime: formatTicks(s.NowPlayingItem.RunTimeTicks),
            },
            playState: {
              isPaused: s.PlayState?.IsPaused || false,
              positionTicks: s.PlayState?.PositionTicks || 0,
              position: formatTicks(s.PlayState?.PositionTicks),
              volumeLevel: s.PlayState?.VolumeLevel ?? null,
              isMuted: s.PlayState?.IsMuted || false,
            },
          }));

        return {
          content: [{
            type: "text",
            text: active.length > 0
              ? `${active.length} active session(s):\n${JSON.stringify(active, null, 2)}`
              : "No active playback sessions.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_jellyfin_control ---
  server.tool(
    "crow_jellyfin_control",
    "Remote control a Jellyfin playback session: play/pause, stop, seek, skip, volume",
    {
      session_id: z.string().max(200).describe("Session ID (from now_playing)"),
      command: z.enum(["PlayPause", "Stop", "Seek", "NextTrack", "PreviousTrack", "SetVolume"]).describe("Playback command"),
      value: z.number().optional().describe("Value: volume 0-100, or seek position in ticks (10,000,000 ticks = 1 second)"),
    },
    async ({ session_id, command, value }) => {
      try {
        const sid = encodeURIComponent(session_id);

        if (command === "Seek" && value !== undefined) {
          await jellyfinFetch(`/Sessions/${sid}/Playing/Seek?seekPositionTicks=${value}`, { method: "POST" });
          return { content: [{ type: "text", text: `Seeked to ${formatTicks(value) || value}.` }] };
        }

        if (command === "SetVolume" && value !== undefined) {
          const vol = Math.max(0, Math.min(100, value));
          await jellyfinFetch(`/Sessions/${sid}/Command`, {
            method: "POST",
            body: JSON.stringify({ Name: "SetVolume", Arguments: { Volume: String(vol) } }),
          });
          return { content: [{ type: "text", text: `Volume set to ${vol}.` }] };
        }

        // PlayPause, Stop, NextTrack, PreviousTrack
        await jellyfinFetch(`/Sessions/${sid}/Playing/${command}`, { method: "POST" });

        const messages = {
          PlayPause: "Toggled play/pause.",
          Stop: "Playback stopped.",
          NextTrack: "Skipped to next track.",
          PreviousTrack: "Skipped to previous track.",
        };

        return { content: [{ type: "text", text: messages[command] || `Sent ${command}.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_jellyfin_collections ---
  server.tool(
    "crow_jellyfin_collections",
    "List all Jellyfin libraries and virtual folders (Movies, TV Shows, Music, etc.)",
    {},
    async () => {
      try {
        const data = await jellyfinFetch("/Library/VirtualFolders");
        const collections = (data || []).map((folder) => ({
          name: folder.Name,
          collectionType: folder.CollectionType || "mixed",
          itemId: folder.ItemId,
          locations: folder.Locations || [],
          refreshStatus: folder.RefreshStatus || null,
        }));

        return {
          content: [{
            type: "text",
            text: collections.length > 0
              ? `${collections.length} library folder(s):\n${JSON.stringify(collections, null, 2)}`
              : "No library folders configured.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}
