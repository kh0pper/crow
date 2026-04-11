/**
 * Wallabag MCP Server
 *
 * Provides tools to manage a Wallabag read-it-later instance via REST API:
 * - Search saved articles
 * - List articles with filters (archive, starred, tags)
 * - Get article content and metadata
 * - Save URLs to read later
 * - Update articles (star, archive, tag)
 * - Delete articles
 *
 * Authentication: OAuth2 password grant with automatic token refresh.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const WALLABAG_URL = (process.env.WALLABAG_URL || "http://localhost:8084").replace(/\/+$/, "");
const WALLABAG_CLIENT_ID = process.env.WALLABAG_CLIENT_ID || "";
const WALLABAG_CLIENT_SECRET = process.env.WALLABAG_CLIENT_SECRET || "";
const WALLABAG_USERNAME = process.env.WALLABAG_USERNAME || "";
const WALLABAG_PASSWORD = process.env.WALLABAG_PASSWORD || "";

let accessToken = null;
let tokenExpiry = 0;

/**
 * Get a valid OAuth2 access token, refreshing if expired.
 */
async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(`${WALLABAG_URL}/oauth/v2/token`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "password",
        client_id: WALLABAG_CLIENT_ID,
        client_secret: WALLABAG_CLIENT_SECRET,
        username: WALLABAG_USERNAME,
        password: WALLABAG_PASSWORD,
      }),
    });

    if (!res.ok) {
      throw new Error("Wallabag OAuth2 login failed — check client ID, secret, username, and password");
    }

    const data = await res.json();
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return accessToken;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Wallabag OAuth2 token request timed out");
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Wallabag at ${WALLABAG_URL} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Make an authenticated request to the Wallabag API.
 * Automatically retries once on 401 (token refresh).
 * @param {string} path - API path (e.g., "/api/entries.json")
 * @param {object} [options] - fetch options
 * @returns {Promise<any>} parsed JSON response
 */
async function wallabagFetch(path, options = {}, retried = false) {
  const token = await getAccessToken();
  const url = `${WALLABAG_URL}${path}`;
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

    if (res.status === 401 && !retried) {
      accessToken = null;
      tokenExpiry = 0;
      clearTimeout(timeout);
      return wallabagFetch(path, options, true);
    }

    if (!res.ok) {
      if (res.status === 401) throw new Error("Authentication failed — check Wallabag OAuth2 credentials");
      if (res.status === 404) throw new Error(`Not found: ${path}`);
      throw new Error(`Wallabag API error: ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Wallabag request timed out after 10s: ${path}`);
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Wallabag at ${WALLABAG_URL} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Format reading time estimate.
 */
function formatReadingTime(minutes) {
  if (!minutes) return null;
  if (minutes < 1) return "< 1 min";
  return `${minutes} min`;
}

export function createWallabagServer(options = {}) {
  const server = new McpServer(
    { name: "crow-wallabag", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- crow_wallabag_search ---
  server.tool(
    "crow_wallabag_search",
    "Search saved articles in Wallabag by keyword. Searches titles and content.",
    {
      query: z.string().max(500).describe("Search text"),
      archive: z.enum(["0", "1"]).optional().describe("Filter: 0 = unread, 1 = archived"),
      starred: z.enum(["0", "1"]).optional().describe("Filter: 0 = not starred, 1 = starred"),
      tags: z.string().max(500).optional().describe("Filter by tag slugs (comma-separated)"),
      page: z.number().min(1).optional().default(1).describe("Page number"),
      perPage: z.number().min(1).max(100).optional().default(20).describe("Results per page"),
    },
    async ({ query, archive, starred, tags, page, perPage }) => {
      try {
        const params = new URLSearchParams({
          search: query,
          page: String(page),
          perPage: String(perPage),
          sort: "updated",
          order: "desc",
        });
        if (archive !== undefined) params.set("archive", archive);
        if (starred !== undefined) params.set("starred", starred);
        if (tags) params.set("tags", tags);

        const data = await wallabagFetch(`/api/entries.json?${params}`);
        const total = data.total || 0;
        const entries = (data._embedded?.items || []).map((e) => ({
          id: e.id,
          title: e.title,
          url: e.url,
          domain: e.domain_name || null,
          is_archived: e.is_archived === 1,
          is_starred: e.is_starred === 1,
          tags: (e.tags || []).map((t) => t.label),
          reading_time: formatReadingTime(e.reading_time),
          created_at: e.created_at,
          preview: e.content ? e.content.replace(/<[^>]*>/g, "").slice(0, 200) + "..." : null,
        }));

        return {
          content: [{
            type: "text",
            text: entries.length > 0
              ? `Found ${total} article(s) matching "${query}" (page ${page}):\n${JSON.stringify(entries, null, 2)}`
              : `No articles found for "${query}".`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_wallabag_list ---
  server.tool(
    "crow_wallabag_list",
    "List saved articles with optional filters (archive status, starred, tags, sorting)",
    {
      archive: z.enum(["0", "1"]).optional().describe("Filter: 0 = unread, 1 = archived"),
      starred: z.enum(["0", "1"]).optional().describe("Filter: 0 = not starred, 1 = starred"),
      tags: z.string().max(500).optional().describe("Filter by tag slugs (comma-separated)"),
      sort: z.enum(["created", "updated", "archived"]).optional().default("created").describe("Sort field"),
      order: z.enum(["asc", "desc"]).optional().default("desc").describe("Sort order"),
      page: z.number().min(1).optional().default(1).describe("Page number"),
      perPage: z.number().min(1).max(100).optional().default(20).describe("Results per page"),
    },
    async ({ archive, starred, tags, sort, order, page, perPage }) => {
      try {
        const params = new URLSearchParams({
          sort,
          order,
          page: String(page),
          perPage: String(perPage),
        });
        if (archive !== undefined) params.set("archive", archive);
        if (starred !== undefined) params.set("starred", starred);
        if (tags) params.set("tags", tags);

        const data = await wallabagFetch(`/api/entries.json?${params}`);
        const total = data.total || 0;
        const entries = (data._embedded?.items || []).map((e) => ({
          id: e.id,
          title: e.title,
          url: e.url,
          domain: e.domain_name || null,
          is_archived: e.is_archived === 1,
          is_starred: e.is_starred === 1,
          tags: (e.tags || []).map((t) => t.label),
          reading_time: formatReadingTime(e.reading_time),
          created_at: e.created_at,
        }));

        return {
          content: [{
            type: "text",
            text: entries.length > 0
              ? `${total} article(s) total (page ${page}):\n${JSON.stringify(entries, null, 2)}`
              : "No articles match the given filters.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_wallabag_get ---
  server.tool(
    "crow_wallabag_get",
    "Get the full content and metadata of a saved article",
    {
      entry_id: z.number().describe("Article entry ID"),
    },
    async ({ entry_id }) => {
      try {
        const e = await wallabagFetch(`/api/entries/${entry_id}.json`);

        const result = {
          id: e.id,
          title: e.title,
          url: e.url,
          domain: e.domain_name || null,
          is_archived: e.is_archived === 1,
          is_starred: e.is_starred === 1,
          tags: (e.tags || []).map((t) => t.label),
          reading_time: formatReadingTime(e.reading_time),
          created_at: e.created_at,
          updated_at: e.updated_at,
          published_at: e.published_at || null,
          published_by: e.published_by?.join(", ") || null,
          preview_picture: e.preview_picture || null,
          content: e.content
            ? e.content.replace(/<[^>]*>/g, "").slice(0, 3000) + (e.content.length > 3000 ? "\n... (truncated)" : "")
            : null,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_wallabag_save ---
  server.tool(
    "crow_wallabag_save",
    "Save a URL to Wallabag for reading later. Wallabag fetches and stores the article content.",
    {
      url: z.string().max(2000).describe("URL to save"),
      title: z.string().max(500).optional().describe("Override article title"),
      tags: z.string().max(500).optional().describe("Comma-separated tags to assign"),
      starred: z.boolean().optional().default(false).describe("Mark as starred/favorite"),
    },
    async ({ url, title, tags, starred }) => {
      try {
        const body = { url };
        if (title) body.title = title;
        if (tags) body.tags = tags;
        if (starred) body.starred = 1;

        const e = await wallabagFetch("/api/entries.json", {
          method: "POST",
          body: JSON.stringify(body),
        });

        return {
          content: [{
            type: "text",
            text: `Article saved:\n${JSON.stringify({
              id: e.id,
              title: e.title,
              url: e.url,
              domain: e.domain_name || null,
              reading_time: formatReadingTime(e.reading_time),
              tags: (e.tags || []).map((t) => t.label),
            }, null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_wallabag_update ---
  server.tool(
    "crow_wallabag_update",
    "Update an article: toggle starred/archived status, change tags",
    {
      entry_id: z.number().describe("Article entry ID"),
      starred: z.boolean().optional().describe("Set starred status"),
      archive: z.boolean().optional().describe("Set archived status (marks as read)"),
      tags: z.string().max(500).optional().describe("Set tags (comma-separated, replaces existing)"),
      title: z.string().max(500).optional().describe("Update title"),
    },
    async ({ entry_id, starred, archive, tags, title }) => {
      try {
        const body = {};
        if (starred !== undefined) body.starred = starred ? 1 : 0;
        if (archive !== undefined) body.archive = archive ? 1 : 0;
        if (tags !== undefined) body.tags = tags;
        if (title !== undefined) body.title = title;

        if (Object.keys(body).length === 0) {
          throw new Error("No fields to update — provide at least one of: starred, archive, tags, title");
        }

        const e = await wallabagFetch(`/api/entries/${entry_id}.json`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });

        return {
          content: [{
            type: "text",
            text: `Article ${entry_id} updated:\n${JSON.stringify({
              id: e.id,
              title: e.title,
              is_archived: e.is_archived === 1,
              is_starred: e.is_starred === 1,
              tags: (e.tags || []).map((t) => t.label),
            }, null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_wallabag_delete ---
  server.tool(
    "crow_wallabag_delete",
    "Permanently delete a saved article from Wallabag",
    {
      entry_id: z.number().describe("Article entry ID to delete"),
      confirm: z.literal("yes").describe("Confirm deletion by passing 'yes'"),
    },
    async ({ entry_id }) => {
      try {
        await wallabagFetch(`/api/entries/${entry_id}.json`, {
          method: "DELETE",
        });

        return {
          content: [{
            type: "text",
            text: `Article ${entry_id} has been permanently deleted.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}
