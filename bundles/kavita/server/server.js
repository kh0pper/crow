/**
 * Kavita MCP Server
 *
 * Provides tools to manage a Kavita manga/comics/ebook server via REST API:
 * - Search series (manga, comics, ebooks)
 * - List libraries with stats
 * - Browse series with filters and pagination
 * - Get series details (volumes, chapters, metadata)
 * - Track reading progress
 * - Manage want-to-read list
 * - View recently added series
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const KAVITA_URL = (process.env.KAVITA_URL || "http://localhost:5000").replace(/\/+$/, "");
const KAVITA_USERNAME = process.env.KAVITA_USERNAME || "";
const KAVITA_PASSWORD = process.env.KAVITA_PASSWORD || "";

let cachedToken = null;
let tokenExpiry = 0;

/**
 * Authenticate with Kavita and get a JWT token.
 * Caches the token for 1 hour.
 */
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(`${KAVITA_URL}/api/Account/login`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: KAVITA_USERNAME, password: KAVITA_PASSWORD }),
    });

    if (!res.ok) {
      throw new Error("Kavita login failed — check KAVITA_USERNAME and KAVITA_PASSWORD");
    }

    const data = await res.json();
    cachedToken = data.token;
    tokenExpiry = Date.now() + 3600000; // 1 hour
    return cachedToken;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Kavita login timed out after 10s`);
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Kavita at ${KAVITA_URL} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Make an authenticated request to the Kavita API.
 * Automatically handles JWT auth and retries on 401.
 * @param {string} path - API path (e.g., "/api/Library")
 * @param {object} [options] - fetch options
 * @returns {Promise<any>} parsed JSON response
 */
async function kavitaFetch(path, options = {}) {
  const doFetch = async (token) => {
    const url = `${KAVITA_URL}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      });

      if (res.status === 401) return null; // signal retry
      if (!res.ok) {
        if (res.status === 404) throw new Error(`Not found: ${path}`);
        throw new Error(`Kavita API error: ${res.status} ${res.statusText}`);
      }

      const text = await res.text();
      return text ? JSON.parse(text) : {};
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(`Kavita request timed out after 10s: ${path}`);
      }
      if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
        throw new Error(`Cannot reach Kavita at ${KAVITA_URL} — is the server running?`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  };

  // First attempt
  let token = await getToken();
  let result = await doFetch(token);

  // On 401, invalidate cache and retry once
  if (result === null) {
    cachedToken = null;
    tokenExpiry = 0;
    token = await getToken();
    result = await doFetch(token);
    if (result === null) {
      throw new Error("Kavita authentication failed after retry — check credentials");
    }
  }

  return result;
}

export function createKavitaServer(options = {}) {
  const server = new McpServer(
    { name: "crow-kavita", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- crow_kavita_search ---
  server.tool(
    "crow_kavita_search",
    "Search Kavita for manga, comics, and ebooks by title or keyword",
    {
      query: z.string().max(500).describe("Search text"),
    },
    async ({ query }) => {
      try {
        const data = await kavitaFetch(`/api/Series/search?queryString=${encodeURIComponent(query)}`);

        const series = (data.series || []).map((s) => ({
          id: s.seriesId || s.id,
          name: s.name,
          localizedName: s.localizedName || null,
          format: formatType(s.format),
          libraryName: s.libraryName || null,
        }));

        return {
          content: [{
            type: "text",
            text: series.length > 0
              ? `Found ${series.length} result(s):\n${JSON.stringify(series, null, 2)}`
              : `No results found for "${query}".`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_kavita_libraries ---
  server.tool(
    "crow_kavita_libraries",
    "List all Kavita libraries with type and folder info",
    {},
    async () => {
      try {
        const data = await kavitaFetch("/api/Library");

        const libraries = (data || []).map((lib) => ({
          id: lib.id,
          name: lib.name,
          type: lib.type,
          folders: lib.folders?.map((f) => f.path) || [],
          lastScanned: lib.lastScanned || null,
        }));

        return {
          content: [{
            type: "text",
            text: libraries.length > 0
              ? `${libraries.length} library(ies):\n${JSON.stringify(libraries, null, 2)}`
              : "No libraries configured.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_kavita_browse ---
  server.tool(
    "crow_kavita_browse",
    "Browse Kavita series in a library with pagination",
    {
      library_id: z.number().describe("Library ID (from crow_kavita_libraries)"),
      page: z.number().min(1).optional().default(1).describe("Page number (default 1)"),
      page_size: z.number().min(1).max(100).optional().default(20).describe("Items per page (default 20)"),
    },
    async ({ library_id, page, page_size }) => {
      try {
        const data = await kavitaFetch(
          `/api/Series?libraryId=${library_id}&pageNumber=${page}&pageSize=${page_size}`
        );

        const series = (Array.isArray(data) ? data : data.content || []).map((s) => ({
          id: s.id,
          name: s.name,
          localizedName: s.localizedName || null,
          format: formatType(s.format),
          pages: s.pages || 0,
          pagesRead: s.pagesRead || 0,
          lastChapterAdded: s.lastChapterAdded || null,
        }));

        return {
          content: [{
            type: "text",
            text: series.length > 0
              ? `Page ${page} (${series.length} series):\n${JSON.stringify(series, null, 2)}`
              : "No series found in this library.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_kavita_get_series ---
  server.tool(
    "crow_kavita_get_series",
    "Get detailed information about a Kavita series including volumes, chapters, and metadata",
    {
      series_id: z.number().describe("Series ID"),
    },
    async ({ series_id }) => {
      try {
        const [series, metadata] = await Promise.all([
          kavitaFetch(`/api/Series/${series_id}`),
          kavitaFetch(`/api/Series/metadata?seriesId=${series_id}`).catch(() => null),
        ]);

        const result = {
          id: series.id,
          name: series.name,
          localizedName: series.localizedName || null,
          format: formatType(series.format),
          pages: series.pages || 0,
          pagesRead: series.pagesRead || 0,
          created: series.created || null,
          lastChapterAdded: series.lastChapterAdded || null,
          summary: metadata?.summary || null,
          genres: metadata?.genres?.map((g) => g.title).join(", ") || null,
          tags: metadata?.tags?.map((t) => t.title).join(", ") || null,
          writers: metadata?.writers?.map((w) => w.name).join(", ") || null,
          ageRating: metadata?.ageRating || null,
          publicationStatus: metadata?.publicationStatus || null,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_kavita_reading_progress ---
  server.tool(
    "crow_kavita_reading_progress",
    "Get reading progress for a Kavita series",
    {
      series_id: z.number().describe("Series ID"),
    },
    async ({ series_id }) => {
      try {
        const data = await kavitaFetch(`/api/Reader/progress?seriesId=${series_id}`);

        const result = {
          seriesId: series_id,
          pagesRead: data.pagesRead || 0,
          totalPages: data.totalPages || 0,
          lastReadingProgress: data.lastModified || null,
          percentComplete: data.totalPages > 0
            ? Math.round((data.pagesRead / data.totalPages) * 100)
            : 0,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_kavita_want_to_read ---
  server.tool(
    "crow_kavita_want_to_read",
    "Manage the Kavita want-to-read list: add, remove, or list series",
    {
      action: z.enum(["add", "remove", "list"]).describe("Action to perform"),
      series_id: z.number().optional().describe("Series ID (required for add/remove)"),
    },
    async ({ action, series_id }) => {
      try {
        if (action === "list") {
          const data = await kavitaFetch("/api/Want-to-read");
          const series = (data || []).map((s) => ({
            id: s.id,
            name: s.name,
            format: formatType(s.format),
            pages: s.pages || 0,
          }));

          return {
            content: [{
              type: "text",
              text: series.length > 0
                ? `${series.length} series on want-to-read list:\n${JSON.stringify(series, null, 2)}`
                : "Want-to-read list is empty.",
            }],
          };
        }

        if (series_id === undefined) {
          return { content: [{ type: "text", text: "Error: series_id is required for add/remove" }] };
        }

        if (action === "add") {
          await kavitaFetch("/api/Want-to-read", {
            method: "POST",
            body: JSON.stringify({ seriesIds: [series_id] }),
          });
          return { content: [{ type: "text", text: `Added series ${series_id} to want-to-read list.` }] };
        }

        if (action === "remove") {
          await kavitaFetch("/api/Want-to-read", {
            method: "DELETE",
            body: JSON.stringify({ seriesIds: [series_id] }),
          });
          return { content: [{ type: "text", text: `Removed series ${series_id} from want-to-read list.` }] };
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_kavita_recently_added ---
  server.tool(
    "crow_kavita_recently_added",
    "List recently added series in Kavita",
    {
      library_id: z.number().optional().describe("Filter by library ID (optional)"),
      page: z.number().min(1).optional().default(1).describe("Page number (default 1)"),
      page_size: z.number().min(1).max(100).optional().default(20).describe("Items per page (default 20)"),
    },
    async ({ library_id, page, page_size }) => {
      try {
        let path = `/api/Series/recently-added?pageNumber=${page}&pageSize=${page_size}`;
        if (library_id !== undefined) {
          path += `&libraryId=${library_id}`;
        }

        const data = await kavitaFetch(path);
        const series = (Array.isArray(data) ? data : data.content || []).map((s) => ({
          id: s.id,
          name: s.name,
          format: formatType(s.format),
          libraryName: s.libraryName || null,
          lastChapterAdded: s.lastChapterAdded || null,
          pages: s.pages || 0,
        }));

        return {
          content: [{
            type: "text",
            text: series.length > 0
              ? `${series.length} recently added series:\n${JSON.stringify(series, null, 2)}`
              : "No recently added series found.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}

/**
 * Convert Kavita format enum to human-readable string.
 */
function formatType(format) {
  const types = {
    0: "Image",
    1: "Archive",
    2: "Unknown",
    3: "EPUB",
    4: "PDF",
    5: "Image",
  };
  return types[format] || "Unknown";
}
