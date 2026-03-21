/**
 * Plex MCP Server
 *
 * Provides tools to interact with a Plex Media Server via REST API:
 * - Search library (movies, TV shows, episodes, music)
 * - Browse library sections with sorting and pagination
 * - Get detailed item metadata
 * - View On Deck (continue watching)
 * - Start playback on a Plex client
 * - Remote control (play, pause, stop, skip, seek, volume)
 * - List library sections
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const PLEX_URL = (process.env.PLEX_URL || "http://localhost:32400").replace(/\/+$/, "");
const PLEX_TOKEN = process.env.PLEX_TOKEN || "";

/**
 * Make an authenticated request to the Plex API.
 * @param {string} path - API path (e.g., "/library/sections")
 * @param {object} [options] - fetch options
 * @returns {Promise<any>} parsed JSON response
 */
async function plexFetch(path, options = {}) {
  const separator = path.includes("?") ? "&" : "?";
  const url = `${PLEX_URL}${path}${separator}X-Plex-Token=${encodeURIComponent(PLEX_TOKEN)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "X-Plex-Client-Identifier": "crow-mcp",
        "X-Plex-Product": "Crow",
        "X-Plex-Version": "1.0.0",
        ...options.headers,
      },
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error("Authentication failed — check PLEX_TOKEN");
      if (res.status === 404) throw new Error(`Not found: ${path}`);
      throw new Error(`Plex API error: ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Plex request timed out after 10s: ${path}`);
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Plex at ${PLEX_URL} — is the server running?`);
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
 * Extract a clean item summary from Plex metadata.
 */
function summarizeItem(item) {
  const result = {
    ratingKey: item.ratingKey,
    title: item.title,
    type: item.type,
  };

  if (item.parentTitle) result.show = item.parentTitle;
  if (item.grandparentTitle) result.show = item.grandparentTitle;
  if (item.parentIndex !== undefined) result.season = item.parentIndex;
  if (item.index !== undefined) result.episode = item.index;
  if (item.year) result.year = item.year;
  if (item.originallyAvailableAt) result.aired = item.originallyAvailableAt;
  if (item.rating) result.rating = Math.round(item.rating * 10) / 10;
  if (item.audienceRating) result.audienceRating = Math.round(item.audienceRating * 10) / 10;
  if (item.duration) result.runtime = formatDuration(item.duration);
  if (item.Genre) result.genres = item.Genre.map((g) => g.tag).join(", ");
  if (item.summary) result.summary = item.summary.length > 300 ? item.summary.slice(0, 300) + "..." : item.summary;
  if (item.viewCount) result.playCount = item.viewCount;
  if (item.viewOffset) result.resumePosition = formatDuration(item.viewOffset);
  if (item.addedAt) result.addedAt = new Date(item.addedAt * 1000).toISOString().slice(0, 10);
  if (item.leafCount !== undefined) result.episodes = item.leafCount;
  if (item.childCount !== undefined) result.seasons = item.childCount;

  return result;
}

export function createPlexServer(options = {}) {
  const server = new McpServer(
    { name: "crow-plex", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- crow_plex_search ---
  server.tool(
    "crow_plex_search",
    "Search the Plex media library by title/name. Returns matching items with metadata.",
    {
      query: z.string().max(500).describe("Search text"),
      media_type: z.enum(["movie", "show", "episode", "artist", "album", "track"]).optional()
        .describe("Filter by media type (default: search all)"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Max results (default 20)"),
    },
    async ({ query, media_type, limit }) => {
      try {
        const typeMap = { movie: 1, show: 2, episode: 4, artist: 8, album: 9, track: 10 };
        const params = new URLSearchParams({ query });
        if (media_type && typeMap[media_type]) {
          params.set("type", String(typeMap[media_type]));
        }
        params.set("limit", String(limit));

        const data = await plexFetch(`/search?${params}`);
        const container = data.MediaContainer || {};
        const results = (container.Metadata || []).map(summarizeItem);

        return {
          content: [{
            type: "text",
            text: results.length > 0
              ? `Found ${results.length} result(s):\n${JSON.stringify(results, null, 2)}`
              : `No results found for "${query}".`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_plex_browse ---
  server.tool(
    "crow_plex_browse",
    "Browse a Plex library section with sorting and pagination",
    {
      section_id: z.string().max(50).describe("Library section ID (from crow_plex_libraries)"),
      sort: z.enum(["addedAt", "titleSort", "rating", "year", "lastViewedAt"]).optional().default("titleSort")
        .describe("Sort field (default: titleSort)"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Items per page (default 20)"),
      offset: z.number().min(0).optional().default(0).describe("Start offset for pagination"),
    },
    async ({ section_id, sort, limit, offset }) => {
      try {
        const sortOrder = (sort === "rating" || sort === "addedAt" || sort === "lastViewedAt") ? "desc" : "asc";
        const params = new URLSearchParams({
          sort: `${sort}:${sortOrder}`,
          "X-Plex-Container-Start": String(offset),
          "X-Plex-Container-Size": String(limit),
        });

        const data = await plexFetch(`/library/sections/${encodeURIComponent(section_id)}/all?${params}`);
        const container = data.MediaContainer || {};
        const total = container.totalSize || container.size || 0;
        const items = (container.Metadata || []).map(summarizeItem);

        return {
          content: [{
            type: "text",
            text: items.length > 0
              ? `Showing ${items.length} of ${total} item(s) (offset ${offset}):\n${JSON.stringify(items, null, 2)}`
              : "No items found in this section.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_plex_get_item ---
  server.tool(
    "crow_plex_get_item",
    "Get detailed metadata for a specific Plex library item",
    {
      rating_key: z.string().max(50).describe("Item rating key (from search or browse results)"),
    },
    async ({ rating_key }) => {
      try {
        const data = await plexFetch(`/library/metadata/${encodeURIComponent(rating_key)}`);
        const container = data.MediaContainer || {};
        const items = container.Metadata || [];

        if (items.length === 0) {
          return { content: [{ type: "text", text: `No item found with rating key ${rating_key}.` }] };
        }

        const item = items[0];
        const result = summarizeItem(item);

        // Add detailed media info
        if (item.Media?.length) {
          result.media = item.Media.map((m) => ({
            videoResolution: m.videoResolution || null,
            videoCodec: m.videoCodec || null,
            audioCodec: m.audioCodec || null,
            audioChannels: m.audioChannels || null,
            container: m.container || null,
            bitrate: m.bitrate ? `${Math.round(m.bitrate / 1000)}Mbps` : null,
          }));
        }

        // Directors, actors
        if (item.Director) result.directors = item.Director.map((d) => d.tag).join(", ");
        if (item.Role) result.cast = item.Role.slice(0, 10).map((r) => r.tag + (r.role ? ` as ${r.role}` : "")).join(", ");
        if (item.Studio) result.studio = item.Studio?.map ? item.Studio.map((s) => s.tag).join(", ") : item.studio;
        if (item.contentRating) result.contentRating = item.contentRating;

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_plex_on_deck ---
  server.tool(
    "crow_plex_on_deck",
    "Get the On Deck list — items ready to continue watching or recently added unwatched items",
    {},
    async () => {
      try {
        const data = await plexFetch("/library/onDeck");
        const container = data.MediaContainer || {};
        const items = (container.Metadata || []).map(summarizeItem);

        return {
          content: [{
            type: "text",
            text: items.length > 0
              ? `${items.length} item(s) on deck:\n${JSON.stringify(items, null, 2)}`
              : "Nothing on deck — all caught up!",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_plex_play ---
  server.tool(
    "crow_plex_play",
    "Start playback of an item on a Plex client. Lists available clients if no client_id is provided.",
    {
      rating_key: z.string().max(50).describe("Item rating key to play"),
      client_id: z.string().max(200).optional().describe("Plex client machine identifier (omit to list available clients)"),
    },
    async ({ rating_key, client_id }) => {
      try {
        // If no client_id, list available clients
        if (!client_id) {
          const sessionsData = await plexFetch("/clients");
          const container = sessionsData.MediaContainer || {};
          const clients = (container.Server || []).map((c) => ({
            name: c.name,
            machineIdentifier: c.machineIdentifier,
            product: c.product,
            platform: c.platform,
            address: c.address,
          }));

          if (clients.length === 0) {
            return {
              content: [{
                type: "text",
                text: "No Plex clients are currently available. Open Plex on a device first, then try again.",
              }],
            };
          }

          return {
            content: [{
              type: "text",
              text: `Available Plex clients — provide a machineIdentifier as client_id:\n${JSON.stringify(clients, null, 2)}`,
            }],
          };
        }

        // Get the server machine identifier
        const identity = await plexFetch("/identity");
        const machineId = process.env.PLEX_MACHINE_ID || identity.MediaContainer?.machineIdentifier || "";

        const params = new URLSearchParams({
          key: `/library/metadata/${rating_key}`,
          machineIdentifier: machineId,
          address: new URL(PLEX_URL).hostname,
          port: String(new URL(PLEX_URL).port || 32400),
        });

        // Send play command to the client
        const clientUrl = `${PLEX_URL}/player/playback/playMedia?${params}`;
        await fetch(clientUrl, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Plex-Token": PLEX_TOKEN,
            "X-Plex-Client-Identifier": "crow-mcp",
            "X-Plex-Target-Client-Identifier": client_id,
          },
        });

        return { content: [{ type: "text", text: `Playing item ${rating_key} on client ${client_id}.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_plex_control ---
  server.tool(
    "crow_plex_control",
    "Transport controls for Plex playback: play, pause, stop, skip, seek, volume",
    {
      client_id: z.string().max(200).describe("Plex client machine identifier (from crow_plex_play client list)"),
      command: z.enum(["play", "pause", "stop", "skipNext", "skipPrevious", "seekTo", "setVolume"])
        .describe("Playback command"),
      value: z.number().optional().describe("Value: seek position in milliseconds, or volume 0-100"),
    },
    async ({ client_id, command, value }) => {
      try {
        let path;
        const messages = {
          play: "Resumed playback.",
          pause: "Paused playback.",
          stop: "Playback stopped.",
          skipNext: "Skipped to next.",
          skipPrevious: "Skipped to previous.",
          seekTo: `Seeked to ${formatDuration(value)}.`,
          setVolume: `Volume set to ${value}.`,
        };

        if (command === "seekTo") {
          if (value === undefined) {
            return { content: [{ type: "text", text: "Provide a value (position in milliseconds) for seekTo." }] };
          }
          path = `/player/playback/seekTo?offset=${value}`;
        } else if (command === "setVolume") {
          if (value === undefined) {
            return { content: [{ type: "text", text: "Provide a value (0-100) for setVolume." }] };
          }
          const vol = Math.max(0, Math.min(100, value));
          path = `/player/playback/setParameters?volume=${vol}`;
        } else {
          path = `/player/playback/${command}`;
        }

        await fetch(`${PLEX_URL}${path}`, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Plex-Token": PLEX_TOKEN,
            "X-Plex-Client-Identifier": "crow-mcp",
            "X-Plex-Target-Client-Identifier": client_id,
          },
        });

        return { content: [{ type: "text", text: messages[command] }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_plex_libraries ---
  server.tool(
    "crow_plex_libraries",
    "List all Plex library sections (Movies, TV Shows, Music, etc.)",
    {},
    async () => {
      try {
        const data = await plexFetch("/library/sections");
        const container = data.MediaContainer || {};
        const sections = (container.Directory || []).map((s) => ({
          id: s.key,
          title: s.title,
          type: s.type,
          agent: s.agent,
          scanner: s.scanner,
          language: s.language || null,
          refreshing: s.refreshing || false,
          locations: s.Location?.map((l) => l.path) || [],
        }));

        return {
          content: [{
            type: "text",
            text: sections.length > 0
              ? `${sections.length} library section(s):\n${JSON.stringify(sections, null, 2)}`
              : "No library sections configured.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}
