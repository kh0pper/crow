/**
 * Shiori MCP Server
 *
 * Provides tools to manage a Shiori bookmark manager via REST API:
 * - Search bookmarks by keyword
 * - List bookmarks with pagination
 * - Get bookmark details and cached content
 * - Save new URLs with optional archiving
 * - Update bookmark tags and title
 * - Delete bookmarks
 *
 * Shiori uses session-based auth: login first to get a session token,
 * then use it as a Bearer token. Re-authenticate on 401.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SHIORI_URL = (process.env.SHIORI_URL || "http://localhost:8086").replace(/\/+$/, "");
const SHIORI_USERNAME = process.env.SHIORI_USERNAME || "shiori";
const SHIORI_PASSWORD = process.env.SHIORI_PASSWORD || "";

let sessionToken = null;

/**
 * Authenticate with Shiori and get a session token.
 */
async function getSession() {
  if (sessionToken) return sessionToken;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(`${SHIORI_URL}/api/v1/auth/login`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: SHIORI_USERNAME,
        password: SHIORI_PASSWORD,
        remember_me: true,
      }),
    });

    if (!res.ok) throw new Error("Shiori login failed — check SHIORI_USERNAME and SHIORI_PASSWORD");

    const data = await res.json();
    sessionToken = data.message?.session || data.token || data.message;
    return sessionToken;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Shiori login timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Shiori at ${SHIORI_URL} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Make an authenticated request to the Shiori API.
 * Automatically re-authenticates on 401/403.
 * @param {string} path - API path (e.g., "/api/v1/bookmarks")
 * @param {object} [options] - fetch options
 * @param {boolean} [isRetry] - internal retry flag
 * @returns {Promise<any>} parsed JSON response
 */
async function shioriFetch(path, options = {}, isRetry = false) {
  const token = await getSession();
  const url = `${SHIORI_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Session-Id": token,
        ...options.headers,
      },
    });

    // Re-authenticate on 401/403 (session expired)
    if ((res.status === 401 || res.status === 403) && !isRetry) {
      sessionToken = null;
      return shioriFetch(path, options, true);
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error("Authentication failed — check SHIORI_USERNAME and SHIORI_PASSWORD");
      if (res.status === 404) throw new Error(`Not found: ${path}`);
      throw new Error(`Shiori API error: ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Shiori request timed out after 10s: ${path}`);
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Shiori at ${SHIORI_URL} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Format a Shiori bookmark for display.
 */
function formatBookmark(b) {
  return {
    id: b.id,
    url: b.url,
    title: b.title || null,
    excerpt: b.excerpt ? b.excerpt.slice(0, 300) : null,
    tags: (b.tags || []).map((t) => t.name || t),
    hasArchive: b.hasArchive || false,
    public: b.public || 0,
    imageURL: b.imageURL || null,
    createdAt: b.createdAt || b.created || null,
    modifiedAt: b.modifiedAt || b.modified || null,
  };
}

export function createShioriServer(options = {}) {
  const server = new McpServer(
    { name: "crow-shiori", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- crow_shiori_search ---
  server.tool(
    "crow_shiori_search",
    "Search Shiori bookmarks by keyword. Searches across URL, title, and excerpt.",
    {
      keyword: z.string().max(500).describe("Search keyword"),
      page: z.number().min(1).optional().default(1).describe("Page number (default 1)"),
    },
    async ({ keyword, page }) => {
      try {
        const params = new URLSearchParams({
          keyword,
          page: String(page),
        });

        const data = await shioriFetch(`/api/v1/bookmarks?${params}`);
        const bookmarks = (data.bookmarks || data || []).map(formatBookmark);

        return {
          content: [{
            type: "text",
            text: bookmarks.length > 0
              ? `Found ${bookmarks.length} bookmark(s) (page ${page}):\n${JSON.stringify(bookmarks, null, 2)}`
              : `No bookmarks found for "${keyword}".`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_shiori_list ---
  server.tool(
    "crow_shiori_list",
    "List Shiori bookmarks with pagination",
    {
      page: z.number().min(1).optional().default(1).describe("Page number (default 1)"),
    },
    async ({ page }) => {
      try {
        const params = new URLSearchParams({ page: String(page) });
        const data = await shioriFetch(`/api/v1/bookmarks?${params}`);
        const bookmarks = (data.bookmarks || data || []).map(formatBookmark);

        return {
          content: [{
            type: "text",
            text: bookmarks.length > 0
              ? `Page ${page} — ${bookmarks.length} bookmark(s):\n${JSON.stringify(bookmarks, null, 2)}`
              : "No bookmarks found.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_shiori_get ---
  server.tool(
    "crow_shiori_get",
    "Get detailed information about a specific Shiori bookmark, including cached content status",
    {
      id: z.number().describe("Bookmark ID"),
    },
    async ({ id }) => {
      try {
        const bookmark = await shioriFetch(`/api/v1/bookmarks/${id}`);
        return { content: [{ type: "text", text: JSON.stringify(formatBookmark(bookmark), null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_shiori_save ---
  server.tool(
    "crow_shiori_save",
    "Save a URL to Shiori. Optionally archive the page content for offline reading.",
    {
      url: z.string().max(2000).describe("URL to save"),
      title: z.string().max(500).optional().describe("Custom title (auto-fetched if omitted)"),
      tags: z.array(z.string().max(100)).optional().describe("Tags to apply"),
      createArchive: z.boolean().optional().default(true).describe("Cache page content for offline reading (default true)"),
    },
    async ({ url, title, tags, createArchive }) => {
      try {
        const body = {
          url,
          createArchive,
        };
        if (title) body.title = title;
        if (tags && tags.length > 0) {
          body.tags = tags.map((t) => ({ name: t }));
        }

        const bookmark = await shioriFetch("/api/v1/bookmarks", {
          method: "POST",
          body: JSON.stringify(body),
        });

        return {
          content: [{
            type: "text",
            text: `Bookmark saved (ID ${bookmark.id}):\n${JSON.stringify(formatBookmark(bookmark), null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_shiori_update ---
  server.tool(
    "crow_shiori_update",
    "Update a Shiori bookmark's title or tags",
    {
      id: z.number().describe("Bookmark ID to update"),
      title: z.string().max(500).optional().describe("New title"),
      tags: z.array(z.string().max(100)).optional().describe("Replace tags"),
    },
    async ({ id, title, tags }) => {
      try {
        // Get current bookmark
        const current = await shioriFetch(`/api/v1/bookmarks/${id}`);
        const body = {
          id,
          url: current.url,
          title: title ?? current.title,
        };
        if (tags !== undefined) {
          body.tags = tags.map((t) => ({ name: t }));
        } else if (current.tags) {
          body.tags = current.tags;
        }

        const bookmark = await shioriFetch("/api/v1/bookmarks", {
          method: "PUT",
          body: JSON.stringify(body),
        });

        return {
          content: [{
            type: "text",
            text: `Bookmark ${id} updated:\n${JSON.stringify(formatBookmark(bookmark), null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_shiori_delete ---
  server.tool(
    "crow_shiori_delete",
    "Delete a bookmark from Shiori. This is permanent and removes any cached content.",
    {
      id: z.number().describe("Bookmark ID to delete"),
      confirm: z.literal("yes").describe("Must be 'yes' to confirm deletion"),
    },
    async ({ id }) => {
      try {
        await shioriFetch("/api/v1/bookmarks", {
          method: "DELETE",
          body: JSON.stringify([id]),
        });
        return { content: [{ type: "text", text: `Bookmark ${id} deleted.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}
