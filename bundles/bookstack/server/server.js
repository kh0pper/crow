/**
 * BookStack MCP Server
 *
 * Provides tools to manage a BookStack wiki via REST API:
 * - Search across all content
 * - List shelves and books
 * - Get page content (markdown/HTML)
 * - Create and update pages
 * - List chapters in a book
 * - Delete pages or chapters
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const BOOKSTACK_URL = (process.env.BOOKSTACK_URL || "http://localhost:6875").replace(/\/+$/, "");
const BOOKSTACK_TOKEN_ID = process.env.BOOKSTACK_TOKEN_ID || "";
const BOOKSTACK_TOKEN_SECRET = process.env.BOOKSTACK_TOKEN_SECRET || "";

/**
 * Make an authenticated request to the BookStack API.
 * @param {string} path - API path (e.g., "/api/search")
 * @param {object} [options] - fetch options
 * @returns {Promise<any>} parsed JSON response
 */
async function bookstackFetch(path, options = {}) {
  const url = `${BOOKSTACK_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "Authorization": `Token ${BOOKSTACK_TOKEN_ID}:${BOOKSTACK_TOKEN_SECRET}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error("Authentication failed — check BOOKSTACK_TOKEN_ID and BOOKSTACK_TOKEN_SECRET");
      if (res.status === 403) throw new Error("Permission denied — the API token lacks access to this resource");
      if (res.status === 404) throw new Error(`Not found: ${path}`);
      throw new Error(`BookStack API error: ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`BookStack request timed out after 10s: ${path}`);
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach BookStack at ${BOOKSTACK_URL} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export function createBookstackServer(options = {}) {
  const server = new McpServer(
    { name: "crow-bookstack", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- crow_bookstack_search ---
  server.tool(
    "crow_bookstack_search",
    "Full-text search across all BookStack content (pages, chapters, books, shelves)",
    {
      query: z.string().max(500).describe("Search text"),
      page: z.number().min(1).optional().default(1).describe("Page number (default 1)"),
      count: z.number().min(1).max(100).optional().default(20).describe("Results per page (default 20)"),
    },
    async ({ query, page, count }) => {
      try {
        const params = new URLSearchParams({
          query,
          page: String(page),
          count: String(count),
        });

        const data = await bookstackFetch(`/api/search?${params}`);
        const results = (data.data || []).map((item) => ({
          id: item.id,
          name: item.name,
          type: item.type,
          url: item.url || null,
          preview: item.preview_html
            ? item.preview_html.replace(/<[^>]*>/g, "").slice(0, 200)
            : null,
          tags: item.tags?.map((t) => t.name) || [],
        }));

        const total = data.total || results.length;

        return {
          content: [{
            type: "text",
            text: results.length > 0
              ? `Found ${total} result(s) (page ${page}):\n${JSON.stringify(results, null, 2)}`
              : `No results found for "${query}".`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_bookstack_shelves ---
  server.tool(
    "crow_bookstack_shelves",
    "List all shelves in BookStack with book counts",
    {
      count: z.number().min(1).max(500).optional().default(100).describe("Max results (default 100)"),
      offset: z.number().min(0).optional().default(0).describe("Start offset for pagination"),
    },
    async ({ count, offset }) => {
      try {
        const params = new URLSearchParams({
          count: String(count),
          offset: String(offset),
          sort: "+name",
        });

        const data = await bookstackFetch(`/api/shelves?${params}`);
        const shelves = (data.data || []).map((shelf) => ({
          id: shelf.id,
          name: shelf.name,
          slug: shelf.slug,
          description: shelf.description ? shelf.description.slice(0, 200) : null,
          created_at: shelf.created_at,
          updated_at: shelf.updated_at,
        }));

        const total = data.total || shelves.length;

        return {
          content: [{
            type: "text",
            text: shelves.length > 0
              ? `${total} shelf/shelves (showing ${shelves.length}, offset ${offset}):\n${JSON.stringify(shelves, null, 2)}`
              : "No shelves found.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_bookstack_books ---
  server.tool(
    "crow_bookstack_books",
    "List books in BookStack, optionally filtered or sorted",
    {
      count: z.number().min(1).max(500).optional().default(100).describe("Max results (default 100)"),
      offset: z.number().min(0).optional().default(0).describe("Start offset for pagination"),
      sort: z.enum(["name", "created_at", "updated_at"]).optional().default("name").describe("Sort field"),
    },
    async ({ count, offset, sort }) => {
      try {
        const params = new URLSearchParams({
          count: String(count),
          offset: String(offset),
          sort: `+${sort}`,
        });

        const data = await bookstackFetch(`/api/books?${params}`);
        const books = (data.data || []).map((book) => ({
          id: book.id,
          name: book.name,
          slug: book.slug,
          description: book.description ? book.description.slice(0, 200) : null,
          created_at: book.created_at,
          updated_at: book.updated_at,
        }));

        const total = data.total || books.length;

        return {
          content: [{
            type: "text",
            text: books.length > 0
              ? `${total} book(s) (showing ${books.length}, offset ${offset}):\n${JSON.stringify(books, null, 2)}`
              : "No books found.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_bookstack_get_page ---
  server.tool(
    "crow_bookstack_get_page",
    "Get a page's content and metadata from BookStack (returns markdown if available)",
    {
      id: z.number().describe("Page ID"),
    },
    async ({ id }) => {
      try {
        const page = await bookstackFetch(`/api/pages/${id}`);

        const result = {
          id: page.id,
          name: page.name,
          slug: page.slug,
          book_id: page.book_id,
          chapter_id: page.chapter_id || null,
          priority: page.priority,
          created_at: page.created_at,
          updated_at: page.updated_at,
          created_by: page.created_by?.name || null,
          updated_by: page.updated_by?.name || null,
          revision_count: page.revision_count || null,
          tags: page.tags?.map((t) => ({ name: t.name, value: t.value })) || [],
          content: page.markdown || page.html || "",
          content_type: page.markdown ? "markdown" : "html",
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_bookstack_create_page ---
  server.tool(
    "crow_bookstack_create_page",
    "Create a new page in BookStack within a book or chapter",
    {
      name: z.string().max(500).describe("Page title"),
      book_id: z.number().optional().describe("Book ID (required if no chapter_id)"),
      chapter_id: z.number().optional().describe("Chapter ID (required if no book_id)"),
      markdown: z.string().max(50000).optional().describe("Page content in Markdown"),
      html: z.string().max(50000).optional().describe("Page content in HTML (used if no markdown)"),
    },
    async ({ name, book_id, chapter_id, markdown, html }) => {
      try {
        if (!book_id && !chapter_id) {
          return { content: [{ type: "text", text: "Error: Provide either book_id or chapter_id" }] };
        }

        const body = { name };
        if (book_id) body.book_id = book_id;
        if (chapter_id) body.chapter_id = chapter_id;
        if (markdown) body.markdown = markdown;
        else if (html) body.html = html;

        const page = await bookstackFetch("/api/pages", {
          method: "POST",
          body: JSON.stringify(body),
        });

        return {
          content: [{
            type: "text",
            text: `Page created:\n${JSON.stringify({
              id: page.id,
              name: page.name,
              slug: page.slug,
              book_id: page.book_id,
              chapter_id: page.chapter_id || null,
            }, null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_bookstack_update_page ---
  server.tool(
    "crow_bookstack_update_page",
    "Update a page's title and/or content in BookStack",
    {
      id: z.number().describe("Page ID"),
      name: z.string().max(500).optional().describe("New page title"),
      markdown: z.string().max(50000).optional().describe("New content in Markdown"),
      html: z.string().max(50000).optional().describe("New content in HTML (used if no markdown)"),
    },
    async ({ id, name, markdown, html }) => {
      try {
        const body = {};
        if (name) body.name = name;
        if (markdown) body.markdown = markdown;
        else if (html) body.html = html;

        if (Object.keys(body).length === 0) {
          return { content: [{ type: "text", text: "Error: Provide at least one field to update (name, markdown, or html)" }] };
        }

        const page = await bookstackFetch(`/api/pages/${id}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });

        return {
          content: [{
            type: "text",
            text: `Page updated:\n${JSON.stringify({
              id: page.id,
              name: page.name,
              slug: page.slug,
              updated_at: page.updated_at,
            }, null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_bookstack_chapters ---
  server.tool(
    "crow_bookstack_chapters",
    "List chapters in a BookStack book",
    {
      book_id: z.number().describe("Book ID to list chapters for"),
      count: z.number().min(1).max(500).optional().default(100).describe("Max results (default 100)"),
      offset: z.number().min(0).optional().default(0).describe("Start offset for pagination"),
    },
    async ({ book_id, count, offset }) => {
      try {
        // Get book details which include chapters
        const book = await bookstackFetch(`/api/books/${book_id}`);
        const contents = book.contents || [];

        const chapters = contents
          .filter((item) => item.type === "chapter")
          .slice(offset, offset + count)
          .map((ch) => ({
            id: ch.id,
            name: ch.name,
            slug: ch.slug,
            priority: ch.priority,
            pages: ch.pages?.length || 0,
          }));

        const pages = contents
          .filter((item) => item.type === "page")
          .slice(0, 10)
          .map((p) => ({
            id: p.id,
            name: p.name,
            slug: p.slug,
            priority: p.priority,
          }));

        return {
          content: [{
            type: "text",
            text: `Book "${book.name}" contents:\n\nChapters (${chapters.length}):\n${JSON.stringify(chapters, null, 2)}\n\nTop-level pages (${pages.length}):\n${JSON.stringify(pages, null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_bookstack_delete ---
  server.tool(
    "crow_bookstack_delete",
    "Delete a page or chapter from BookStack (irreversible)",
    {
      id: z.number().describe("ID of the page or chapter to delete"),
      type: z.enum(["page", "chapter"]).describe("Type of item to delete"),
      confirm: z.literal("yes").describe('Must be "yes" to confirm deletion'),
    },
    async ({ id, type }) => {
      try {
        const endpoint = type === "page" ? "pages" : "chapters";
        await bookstackFetch(`/api/${endpoint}/${id}`, { method: "DELETE" });

        return {
          content: [{
            type: "text",
            text: `${type === "page" ? "Page" : "Chapter"} ${id} deleted successfully.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}
