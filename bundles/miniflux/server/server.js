/**
 * Miniflux MCP Server
 *
 * Provides tools to manage a Miniflux RSS reader via REST API:
 * - List feeds with unread counts
 * - Subscribe to new feeds
 * - List entries with filters (unread, starred, feed, category)
 * - Get full entry content
 * - Mark entries as read
 * - Toggle bookmark/star
 * - Remove feeds
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const MINIFLUX_URL = (process.env.MINIFLUX_URL || "http://localhost:8085").replace(/\/+$/, "");
const MINIFLUX_API_KEY = process.env.MINIFLUX_API_KEY || "";

/**
 * Make an authenticated request to the Miniflux API.
 * @param {string} path - API path (e.g., "/v1/feeds")
 * @param {object} [options] - fetch options
 * @returns {Promise<any>} parsed JSON response
 */
async function minifluxFetch(path, options = {}) {
  const url = `${MINIFLUX_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "X-Auth-Token": MINIFLUX_API_KEY,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error("Authentication failed — check MINIFLUX_API_KEY");
      if (res.status === 404) throw new Error(`Not found: ${path}`);
      const body = await res.text().catch(() => "");
      throw new Error(`Miniflux API error: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Miniflux request timed out after 10s: ${path}`);
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Miniflux at ${MINIFLUX_URL} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export function createMinifluxServer(options = {}) {
  const server = new McpServer(
    { name: "crow-miniflux", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- crow_miniflux_feeds ---
  server.tool(
    "crow_miniflux_feeds",
    "List all RSS feeds with unread counts and metadata",
    {},
    async () => {
      try {
        const feeds = await minifluxFetch("/v1/feeds");
        const items = (feeds || []).map((f) => ({
          id: f.id,
          title: f.title,
          site_url: f.site_url || null,
          feed_url: f.feed_url,
          category: f.category?.title || null,
          category_id: f.category?.id || null,
          unread: f.unread_count || 0,
          error_count: f.parsing_error_count || 0,
          last_checked: f.checked_at || null,
        }));

        return {
          content: [{
            type: "text",
            text: items.length > 0
              ? `${items.length} feed(s):\n${JSON.stringify(items, null, 2)}`
              : "No feeds configured. Use crow_miniflux_add_feed to subscribe.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_miniflux_add_feed ---
  server.tool(
    "crow_miniflux_add_feed",
    "Subscribe to a new RSS/Atom feed by URL",
    {
      url: z.string().max(2000).describe("Feed URL (RSS or Atom)"),
      category_id: z.number().optional().describe("Category ID to assign (from feeds list)"),
    },
    async ({ url, category_id }) => {
      try {
        const body = { feed_url: url };
        if (category_id) body.category_id = category_id;

        const result = await minifluxFetch("/v1/feeds", {
          method: "POST",
          body: JSON.stringify(body),
        });

        return {
          content: [{
            type: "text",
            text: `Subscribed to feed (ID: ${result.feed_id || result.id}).\nURL: ${url}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_miniflux_entries ---
  server.tool(
    "crow_miniflux_entries",
    "List feed entries with filters (unread, starred, by feed or category)",
    {
      status: z.enum(["unread", "read", "removed"]).optional().describe("Filter by status (default: all)"),
      starred: z.boolean().optional().describe("Filter starred/bookmarked entries only"),
      feed_id: z.number().optional().describe("Filter by feed ID"),
      category_id: z.number().optional().describe("Filter by category ID"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Max results (default 20)"),
      offset: z.number().min(0).optional().default(0).describe("Pagination offset"),
      search: z.string().max(500).optional().describe("Search within entries"),
    },
    async ({ status, starred, feed_id, category_id, limit, offset, search }) => {
      try {
        const params = new URLSearchParams({
          limit: String(limit),
          offset: String(offset),
          direction: "desc",
          order: "published_at",
        });
        if (status) params.set("status", status);
        if (starred) params.set("starred", "true");
        if (category_id) params.set("category_id", String(category_id));
        if (search) params.set("search", search);

        let path = "/v1/entries";
        if (feed_id) {
          path = `/v1/feeds/${feed_id}/entries`;
        }

        const data = await minifluxFetch(`${path}?${params}`);
        const total = data.total || 0;
        const entries = (data.entries || []).map((e) => ({
          id: e.id,
          title: e.title,
          author: e.author || null,
          feed: e.feed?.title || null,
          published: e.published_at || null,
          status: e.status,
          starred: e.starred || false,
          url: e.url || null,
          reading_time: e.reading_time ? `${e.reading_time} min` : null,
        }));

        return {
          content: [{
            type: "text",
            text: entries.length > 0
              ? `Showing ${entries.length} of ${total} entries (offset ${offset}):\n${JSON.stringify(entries, null, 2)}`
              : "No entries found matching filters.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_miniflux_get_entry ---
  server.tool(
    "crow_miniflux_get_entry",
    "Get the full content of a specific feed entry",
    {
      entry_id: z.number().describe("Entry ID"),
    },
    async ({ entry_id }) => {
      try {
        const entry = await minifluxFetch(`/v1/entries/${entry_id}`);

        const result = {
          id: entry.id,
          title: entry.title,
          author: entry.author || null,
          feed: entry.feed?.title || null,
          published: entry.published_at || null,
          url: entry.url || null,
          status: entry.status,
          starred: entry.starred || false,
          reading_time: entry.reading_time ? `${entry.reading_time} min` : null,
          content: entry.content || null,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_miniflux_mark_read ---
  server.tool(
    "crow_miniflux_mark_read",
    "Mark entries as read. Pass specific entry IDs or 'all' to mark everything read.",
    {
      entry_ids: z.array(z.number()).optional().describe("Specific entry IDs to mark as read"),
      all: z.boolean().optional().describe("Set to true to mark ALL entries as read"),
    },
    async ({ entry_ids, all }) => {
      try {
        if (all) {
          // Mark all as read using the user endpoint
          await minifluxFetch("/v1/entries", {
            method: "PUT",
            body: JSON.stringify({ status: "read" }),
          });
          return { content: [{ type: "text", text: "All entries marked as read." }] };
        }

        if (!entry_ids || entry_ids.length === 0) {
          return { content: [{ type: "text", text: "Provide entry_ids or set all: true." }] };
        }

        await minifluxFetch("/v1/entries", {
          method: "PUT",
          body: JSON.stringify({ entry_ids, status: "read" }),
        });

        return {
          content: [{
            type: "text",
            text: `Marked ${entry_ids.length} entry/entries as read.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_miniflux_star ---
  server.tool(
    "crow_miniflux_star",
    "Toggle bookmark/star on a feed entry",
    {
      entry_id: z.number().describe("Entry ID to toggle star"),
    },
    async ({ entry_id }) => {
      try {
        await minifluxFetch(`/v1/entries/${entry_id}/bookmark`, { method: "PUT" });
        return { content: [{ type: "text", text: `Toggled star on entry ${entry_id}.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_miniflux_remove_feed ---
  server.tool(
    "crow_miniflux_remove_feed",
    "Unsubscribe from a feed. This removes the feed and all its entries permanently.",
    {
      feed_id: z.number().describe("Feed ID to remove"),
      confirm: z.literal("yes").describe("Must be 'yes' to confirm deletion"),
    },
    async ({ feed_id, confirm }) => {
      try {
        if (confirm !== "yes") {
          return { content: [{ type: "text", text: "Deletion cancelled — confirm must be 'yes'." }] };
        }

        await minifluxFetch(`/v1/feeds/${feed_id}`, { method: "DELETE" });
        return { content: [{ type: "text", text: `Feed ${feed_id} removed.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}
