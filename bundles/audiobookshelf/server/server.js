/**
 * Audiobookshelf MCP Server
 *
 * Provides tools to manage an Audiobookshelf server via REST API:
 * - Search audiobooks and podcasts
 * - List libraries
 * - Browse library items with sorting and pagination
 * - Get item details (chapters, duration, narrators)
 * - Get listening progress (in-progress items)
 * - List collections/series
 * - Get stream URL for playback
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const ABS_URL = (process.env.AUDIOBOOKSHELF_URL || "http://localhost:13378").replace(/\/+$/, "");
const ABS_API_KEY = process.env.AUDIOBOOKSHELF_API_KEY || "";

/**
 * Make an authenticated request to the Audiobookshelf API.
 * @param {string} path - API path (e.g., "/api/libraries")
 * @param {object} [options] - fetch options
 * @returns {Promise<any>} parsed JSON response
 */
async function absFetch(path, options = {}) {
  const url = `${ABS_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${ABS_API_KEY}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error("Authentication failed — check AUDIOBOOKSHELF_API_KEY");
      if (res.status === 404) throw new Error(`Not found: ${path}`);
      throw new Error(`Audiobookshelf API error: ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Audiobookshelf request timed out after 10s: ${path}`);
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Audiobookshelf at ${ABS_URL} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Format seconds to human-readable duration.
 */
function formatDuration(seconds) {
  if (!seconds) return null;
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function createAudiobookshelfServer(options = {}) {
  const server = new McpServer(
    { name: "crow-audiobookshelf", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- crow_audiobookshelf_search ---
  server.tool(
    "crow_audiobookshelf_search",
    "Search audiobooks and podcasts across all libraries by title, author, or narrator",
    {
      query: z.string().max(500).describe("Search text"),
      library_id: z.string().max(100).optional().describe("Limit search to a specific library ID"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Max results (default 20)"),
    },
    async ({ query, library_id, limit }) => {
      try {
        let libraries;
        if (library_id) {
          libraries = [{ id: library_id }];
        } else {
          const libData = await absFetch("/api/libraries");
          libraries = libData.libraries || libData || [];
        }

        const allResults = [];
        for (const lib of libraries) {
          const params = new URLSearchParams({ q: query, limit: String(limit) });
          const data = await absFetch(`/api/libraries/${lib.id}/search?${params}`);

          const books = (data.book || []).map((r) => {
            const item = r.libraryItem || r;
            const media = item.media || {};
            const meta = media.metadata || {};
            return {
              id: item.id,
              title: meta.title || item.name || null,
              author: meta.authorName || meta.authors?.map((a) => a.name).join(", ") || null,
              narrator: meta.narratorName || meta.narrators?.join(", ") || null,
              type: "book",
              duration: formatDuration(media.duration),
              year: meta.publishedYear || null,
              library: lib.name || lib.id,
            };
          });

          const podcasts = (data.podcast || []).map((r) => {
            const item = r.libraryItem || r;
            const media = item.media || {};
            const meta = media.metadata || {};
            return {
              id: item.id,
              title: meta.title || item.name || null,
              author: meta.author || null,
              type: "podcast",
              episodeCount: media.episodes?.length || media.numEpisodes || null,
              library: lib.name || lib.id,
            };
          });

          allResults.push(...books, ...podcasts);
        }

        return {
          content: [{
            type: "text",
            text: allResults.length > 0
              ? `Found ${allResults.length} result(s):\n${JSON.stringify(allResults.slice(0, limit), null, 2)}`
              : `No results found for "${query}".`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_audiobookshelf_libraries ---
  server.tool(
    "crow_audiobookshelf_libraries",
    "List all Audiobookshelf libraries (audiobook and podcast collections)",
    {},
    async () => {
      try {
        const data = await absFetch("/api/libraries");
        const libraries = (data.libraries || data || []).map((lib) => ({
          id: lib.id,
          name: lib.name,
          mediaType: lib.mediaType || null,
          folders: lib.folders?.map((f) => f.fullPath).join(", ") || null,
          stats: lib.stats || null,
        }));

        return {
          content: [{
            type: "text",
            text: libraries.length > 0
              ? `${libraries.length} library/libraries:\n${JSON.stringify(libraries, null, 2)}`
              : "No libraries configured.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_audiobookshelf_browse ---
  server.tool(
    "crow_audiobookshelf_browse",
    "Browse a library's items with sorting and pagination",
    {
      library_id: z.string().max(100).describe("Library ID (from libraries list)"),
      sort: z.enum(["title", "authorLF", "addedAt", "duration", "publishedYear"]).optional().default("title").describe("Sort field"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Items per page (default 20)"),
      page: z.number().min(0).optional().default(0).describe("Page number (0-based)"),
      filter: z.string().max(500).optional().describe("Filter string (e.g., genre, author)"),
    },
    async ({ library_id, sort, limit, page, filter }) => {
      try {
        const params = new URLSearchParams({
          sort: sort,
          limit: String(limit),
          page: String(page),
          desc: sort === "addedAt" ? "1" : "0",
        });
        if (filter) params.set("filter", filter);

        const data = await absFetch(`/api/libraries/${library_id}/items?${params}`);
        const total = data.total || 0;
        const items = (data.results || []).map((item) => {
          const media = item.media || {};
          const meta = media.metadata || {};
          return {
            id: item.id,
            title: meta.title || item.name || null,
            author: meta.authorName || meta.authors?.map((a) => a.name).join(", ") || null,
            duration: formatDuration(media.duration),
            year: meta.publishedYear || null,
            mediaType: item.mediaType || null,
            addedAt: item.addedAt ? new Date(item.addedAt).toISOString() : null,
          };
        });

        return {
          content: [{
            type: "text",
            text: items.length > 0
              ? `Showing ${items.length} of ${total} item(s) (page ${page}):\n${JSON.stringify(items, null, 2)}`
              : "No items found.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_audiobookshelf_get_item ---
  server.tool(
    "crow_audiobookshelf_get_item",
    "Get detailed information about an audiobook or podcast (chapters, duration, narrators, progress)",
    {
      item_id: z.string().max(100).describe("Item ID"),
    },
    async ({ item_id }) => {
      try {
        const item = await absFetch(`/api/items/${item_id}?expanded=1`);
        const media = item.media || {};
        const meta = media.metadata || {};

        const result = {
          id: item.id,
          title: meta.title || null,
          subtitle: meta.subtitle || null,
          author: meta.authorName || meta.authors?.map((a) => a.name).join(", ") || null,
          narrator: meta.narratorName || meta.narrators?.join(", ") || null,
          description: meta.description ? meta.description.slice(0, 500) + (meta.description.length > 500 ? "..." : "") : null,
          genres: meta.genres?.join(", ") || null,
          year: meta.publishedYear || null,
          publisher: meta.publisher || null,
          language: meta.language || null,
          duration: formatDuration(media.duration),
          mediaType: item.mediaType || null,
          chapters: media.chapters?.map((ch) => ({
            title: ch.title,
            start: formatDuration(ch.start),
            end: formatDuration(ch.end),
          })) || [],
          progress: item.userMediaProgress ? {
            percent: Math.round((item.userMediaProgress.progress || 0) * 100),
            currentTime: formatDuration(item.userMediaProgress.currentTime),
            isFinished: item.userMediaProgress.isFinished || false,
            lastUpdate: item.userMediaProgress.lastUpdate ? new Date(item.userMediaProgress.lastUpdate).toISOString() : null,
          } : null,
          numFiles: media.audioFiles?.length || media.tracks?.length || null,
          size: item.size ? `${Math.round(item.size / 1048576)}MB` : null,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_audiobookshelf_progress ---
  server.tool(
    "crow_audiobookshelf_progress",
    "Get all items currently in progress (listening progress across all libraries)",
    {},
    async () => {
      try {
        const data = await absFetch("/api/me/items-in-progress");
        const items = (data.libraryItems || data || []).map((item) => {
          const media = item.media || {};
          const meta = media.metadata || {};
          const progress = item.progressLastUpdate
            ? item
            : (item.userMediaProgress || {});

          return {
            id: item.id,
            title: meta.title || item.name || null,
            author: meta.authorName || meta.authors?.map((a) => a.name).join(", ") || null,
            duration: formatDuration(media.duration),
            progress: Math.round((progress.progress || 0) * 100) + "%",
            currentTime: formatDuration(progress.currentTime),
            lastPlayed: progress.lastUpdate ? new Date(progress.lastUpdate).toISOString() : null,
          };
        });

        return {
          content: [{
            type: "text",
            text: items.length > 0
              ? `${items.length} item(s) in progress:\n${JSON.stringify(items, null, 2)}`
              : "No items in progress.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_audiobookshelf_collections ---
  server.tool(
    "crow_audiobookshelf_collections",
    "List collections and series in a library",
    {
      library_id: z.string().max(100).describe("Library ID"),
    },
    async ({ library_id }) => {
      try {
        const data = await absFetch(`/api/libraries/${library_id}/collections`);
        const collections = (data.results || data || []).map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description || null,
          numBooks: c.books?.length || c.numBooks || null,
        }));

        // Also try series
        let series = [];
        try {
          const seriesData = await absFetch(`/api/libraries/${library_id}/series`);
          series = (seriesData.results || seriesData || []).map((s) => ({
            id: s.id,
            name: s.name,
            numBooks: s.books?.length || s.numBooks || null,
          }));
        } catch {
          // Series endpoint may not exist for podcast libraries
        }

        const result = { collections, series };

        return {
          content: [{
            type: "text",
            text: (collections.length > 0 || series.length > 0)
              ? `${collections.length} collection(s), ${series.length} series:\n${JSON.stringify(result, null, 2)}`
              : "No collections or series found.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_audiobookshelf_play ---
  server.tool(
    "crow_audiobookshelf_play",
    "Get a stream URL for an audiobook or podcast episode. Returns a playback URL.",
    {
      item_id: z.string().max(100).describe("Item ID to play"),
      episode_id: z.string().max(100).optional().describe("Episode ID for podcasts"),
    },
    async ({ item_id, episode_id }) => {
      try {
        // Get item details
        const item = await absFetch(`/api/items/${item_id}`);
        const media = item.media || {};
        const meta = media.metadata || {};

        // Build stream URL
        let streamUrl;
        if (episode_id) {
          streamUrl = `${ABS_URL}/api/items/${item_id}/play/${episode_id}`;
        } else {
          streamUrl = `${ABS_URL}/api/items/${item_id}/play`;
        }

        // Direct file stream (simpler, works in browsers)
        const fileStreamUrl = `${ABS_URL}/api/items/${item_id}/file/0?token=${ABS_API_KEY}`;

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              name: meta.title || null,
              author: meta.authorName || null,
              duration: formatDuration(media.duration),
              playbackUrl: streamUrl,
              directStreamUrl: fileStreamUrl,
              webPlayerUrl: `${ABS_URL}/item/${item_id}`,
              note: "Open webPlayerUrl in a browser for the full player experience.",
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}
