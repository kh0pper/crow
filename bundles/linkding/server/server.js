/**
 * Linkding MCP Server
 *
 * Provides tools to manage a Linkding bookmark manager via REST API:
 * - Search bookmarks by text
 * - List bookmarks with filters
 * - Get bookmark details
 * - Create new bookmarks
 * - Update existing bookmarks
 * - Delete bookmarks
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const LINKDING_URL = (process.env.LINKDING_URL || "http://localhost:9090").replace(/\/+$/, "");
const LINKDING_API_TOKEN = process.env.LINKDING_API_TOKEN || "";

/**
 * Make an authenticated request to the Linkding API.
 * @param {string} path - API path (e.g., "/api/bookmarks/")
 * @param {object} [options] - fetch options
 * @returns {Promise<any>} parsed JSON response
 */
async function linkdingFetch(path, options = {}) {
  const url = `${LINKDING_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Token ${LINKDING_API_TOKEN}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error("Authentication failed — check LINKDING_API_TOKEN");
      if (res.status === 404) throw new Error(`Not found: ${path}`);
      throw new Error(`Linkding API error: ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Linkding request timed out after 10s: ${path}`);
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Linkding at ${LINKDING_URL} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Format a bookmark object for display.
 */
function formatBookmark(b) {
  return {
    id: b.id,
    url: b.url,
    title: b.title || null,
    description: b.description || null,
    notes: b.notes || null,
    tags: b.tag_names || [],
    is_archived: b.is_archived || false,
    unread: b.unread || false,
    website_title: b.website_title || null,
    website_description: b.website_description ? b.website_description.slice(0, 200) : null,
    date_added: b.date_added || null,
    date_modified: b.date_modified || null,
  };
}

export function createLinkdingServer(options = {}) {
  const server = new McpServer(
    { name: "crow-linkding", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- crow_linkding_search ---
  server.tool(
    "crow_linkding_search",
    "Search Linkding bookmarks by text. Searches across URL, title, description, notes, and tags.",
    {
      q: z.string().max(500).describe("Search query text"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Max results (default 20)"),
      offset: z.number().min(0).optional().default(0).describe("Pagination offset"),
    },
    async ({ q, limit, offset }) => {
      try {
        const params = new URLSearchParams({
          q,
          limit: String(limit),
          offset: String(offset),
        });

        const data = await linkdingFetch(`/api/bookmarks/?${params}`);
        const total = data.count || 0;
        const bookmarks = (data.results || []).map(formatBookmark);

        return {
          content: [{
            type: "text",
            text: bookmarks.length > 0
              ? `Found ${total} bookmark(s) (showing ${bookmarks.length}, offset ${offset}):\n${JSON.stringify(bookmarks, null, 2)}`
              : `No bookmarks found for "${q}".`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_linkding_list ---
  server.tool(
    "crow_linkding_list",
    "List Linkding bookmarks with optional tag filtering and pagination",
    {
      q: z.string().max(500).optional().describe("Filter query (use #tag to filter by tag)"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Items per page (default 20)"),
      offset: z.number().min(0).optional().default(0).describe("Pagination offset"),
    },
    async ({ q, limit, offset }) => {
      try {
        const params = new URLSearchParams({
          limit: String(limit),
          offset: String(offset),
        });
        if (q) params.set("q", q);

        const data = await linkdingFetch(`/api/bookmarks/?${params}`);
        const total = data.count || 0;
        const bookmarks = (data.results || []).map(formatBookmark);

        return {
          content: [{
            type: "text",
            text: bookmarks.length > 0
              ? `Showing ${bookmarks.length} of ${total} bookmark(s) (offset ${offset}):\n${JSON.stringify(bookmarks, null, 2)}`
              : "No bookmarks found.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_linkding_get ---
  server.tool(
    "crow_linkding_get",
    "Get detailed information about a specific Linkding bookmark",
    {
      id: z.number().describe("Bookmark ID"),
    },
    async ({ id }) => {
      try {
        const bookmark = await linkdingFetch(`/api/bookmarks/${id}/`);
        return { content: [{ type: "text", text: JSON.stringify(formatBookmark(bookmark), null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_linkding_create ---
  server.tool(
    "crow_linkding_create",
    "Create a new bookmark in Linkding",
    {
      url: z.string().max(2000).describe("URL to bookmark"),
      title: z.string().max(500).optional().describe("Bookmark title (auto-fetched if omitted)"),
      description: z.string().max(5000).optional().describe("Bookmark description"),
      tag_names: z.array(z.string().max(100)).optional().describe("Tags to apply"),
      is_archived: z.boolean().optional().default(false).describe("Archive immediately"),
      unread: z.boolean().optional().default(false).describe("Mark as unread"),
    },
    async ({ url, title, description, tag_names, is_archived, unread }) => {
      try {
        const body = { url };
        if (title !== undefined) body.title = title;
        if (description !== undefined) body.description = description;
        if (tag_names !== undefined) body.tag_names = tag_names;
        if (is_archived) body.is_archived = is_archived;
        if (unread) body.unread = unread;

        const bookmark = await linkdingFetch("/api/bookmarks/", {
          method: "POST",
          body: JSON.stringify(body),
        });

        return {
          content: [{
            type: "text",
            text: `Bookmark created (ID ${bookmark.id}):\n${JSON.stringify(formatBookmark(bookmark), null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_linkding_update ---
  server.tool(
    "crow_linkding_update",
    "Update an existing Linkding bookmark",
    {
      id: z.number().describe("Bookmark ID to update"),
      url: z.string().max(2000).optional().describe("New URL"),
      title: z.string().max(500).optional().describe("New title"),
      description: z.string().max(5000).optional().describe("New description"),
      tag_names: z.array(z.string().max(100)).optional().describe("Replace tags"),
      is_archived: z.boolean().optional().describe("Archive or unarchive"),
      unread: z.boolean().optional().describe("Mark as read or unread"),
    },
    async ({ id, url, title, description, tag_names, is_archived, unread }) => {
      try {
        // Get current bookmark first for PATCH semantics
        const current = await linkdingFetch(`/api/bookmarks/${id}/`);
        const body = {
          url: url ?? current.url,
          title: title ?? current.title,
          description: description ?? current.description,
          tag_names: tag_names ?? current.tag_names,
        };
        if (is_archived !== undefined) body.is_archived = is_archived;
        if (unread !== undefined) body.unread = unread;

        const bookmark = await linkdingFetch(`/api/bookmarks/${id}/`, {
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

  // --- crow_linkding_delete ---
  server.tool(
    "crow_linkding_delete",
    "Delete a bookmark from Linkding. This is permanent.",
    {
      id: z.number().describe("Bookmark ID to delete"),
      confirm: z.literal("yes").describe("Must be 'yes' to confirm deletion"),
    },
    async ({ id }) => {
      try {
        await linkdingFetch(`/api/bookmarks/${id}/`, { method: "DELETE" });
        return { content: [{ type: "text", text: `Bookmark ${id} deleted.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}
