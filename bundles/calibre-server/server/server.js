/**
 * Calibre Server MCP Server
 *
 * Provides tools to interact with a Calibre content server via its JSON API:
 * - Search books by title, author, or keyword
 * - List books with sorting and pagination
 * - Get detailed book metadata
 * - Download books in available formats
 * - List categories (authors, tags, series, publishers)
 * - Browse books within a category
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const CALIBRE_URL = (process.env.CALIBRE_URL || "http://localhost:8081").replace(/\/+$/, "");
const CALIBRE_USERNAME = process.env.CALIBRE_USERNAME || "";
const CALIBRE_PASSWORD = process.env.CALIBRE_PASSWORD || "";

/**
 * Make an authenticated request to the Calibre content server API.
 * @param {string} path - API path (e.g., "/ajax/search")
 * @param {object} [options] - fetch options
 * @returns {Promise<any>} parsed JSON response
 */
async function calibreFetch(path, options = {}) {
  const url = `${CALIBRE_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const headers = {
      "Content-Type": "application/json",
      ...options.headers,
    };

    if (CALIBRE_USERNAME && CALIBRE_PASSWORD) {
      const credentials = btoa(`${CALIBRE_USERNAME}:${CALIBRE_PASSWORD}`);
      headers["Authorization"] = `Basic ${credentials}`;
    }

    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers,
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error("Authentication failed — check CALIBRE_USERNAME and CALIBRE_PASSWORD");
      if (res.status === 404) throw new Error(`Not found: ${path}`);
      throw new Error(`Calibre API error: ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Calibre request timed out after 10s: ${path}`);
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Calibre at ${CALIBRE_URL} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Format a book object from the Calibre API into a concise summary.
 */
function formatBook(book) {
  return {
    id: book.application_id || book.id,
    title: book.title || "Unknown",
    authors: Array.isArray(book.authors) ? book.authors.join(", ") : (book.authors || "Unknown"),
    tags: Array.isArray(book.tags) ? book.tags.join(", ") : (book.tags || null),
    series: book.series || null,
    series_index: book.series_index || null,
    publisher: book.publisher || null,
    pubdate: book.pubdate || null,
    rating: book.rating || null,
    formats: Array.isArray(book.formats) ? book.formats : (book.available_formats || []),
    languages: Array.isArray(book.languages) ? book.languages.join(", ") : null,
    identifiers: book.identifiers || {},
  };
}

export function createCalibreServer(options = {}) {
  const server = new McpServer(
    { name: "crow-calibre-server", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- crow_calibre_search ---
  server.tool(
    "crow_calibre_search",
    "Search the Calibre library by title, author, or keyword. Returns matching books with metadata.",
    {
      query: z.string().max(500).describe("Search text (title, author, or keyword)"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Max results (default 20)"),
      offset: z.number().min(0).optional().default(0).describe("Start offset for pagination"),
    },
    async ({ query, limit, offset }) => {
      try {
        const params = new URLSearchParams({
          query: query,
          num: String(limit),
          offset: String(offset),
          sort: "title",
          sort_order: "asc",
        });

        const data = await calibreFetch(`/ajax/search?${params}`);
        const bookIds = data.book_ids || [];

        if (bookIds.length === 0) {
          return {
            content: [{ type: "text", text: `No results found for "${query}".` }],
          };
        }

        // Fetch details for found books
        const idsParam = bookIds.slice(0, limit).join(",");
        const books = await calibreFetch(`/ajax/books?ids=${idsParam}`);

        const items = Object.values(books).map(formatBook);

        return {
          content: [{
            type: "text",
            text: `Found ${data.total_num || items.length} result(s) (showing ${items.length}):\n${JSON.stringify(items, null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_calibre_list_books ---
  server.tool(
    "crow_calibre_list_books",
    "List books in the Calibre library with sorting and pagination",
    {
      sort_by: z.enum(["title", "authors", "rating", "timestamp", "pubdate", "last_modified"]).optional().default("title").describe("Sort field"),
      sort_order: z.enum(["asc", "desc"]).optional().default("asc").describe("Sort order"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Items per page (default 20)"),
      offset: z.number().min(0).optional().default(0).describe("Start offset for pagination"),
    },
    async ({ sort_by, sort_order, limit, offset }) => {
      try {
        const params = new URLSearchParams({
          num: String(limit),
          offset: String(offset),
          sort: sort_by,
          sort_order: sort_order,
        });

        const data = await calibreFetch(`/ajax/search?${params}`);
        const bookIds = data.book_ids || [];
        const total = data.total_num || 0;

        if (bookIds.length === 0) {
          return { content: [{ type: "text", text: "No books found in library." }] };
        }

        const idsParam = bookIds.join(",");
        const books = await calibreFetch(`/ajax/books?ids=${idsParam}`);
        const items = Object.values(books).map(formatBook);

        return {
          content: [{
            type: "text",
            text: `Showing ${items.length} of ${total} book(s) (offset ${offset}):\n${JSON.stringify(items, null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_calibre_get_book ---
  server.tool(
    "crow_calibre_get_book",
    "Get detailed metadata for a specific book by ID",
    {
      book_id: z.number().describe("Book ID"),
    },
    async ({ book_id }) => {
      try {
        const books = await calibreFetch(`/ajax/books?ids=${book_id}`);
        const book = books[String(book_id)];

        if (!book) {
          return { content: [{ type: "text", text: `Book with ID ${book_id} not found.` }] };
        }

        const result = {
          id: book.application_id || book_id,
          title: book.title || "Unknown",
          authors: Array.isArray(book.authors) ? book.authors.join(", ") : (book.authors || "Unknown"),
          tags: Array.isArray(book.tags) ? book.tags.join(", ") : null,
          series: book.series || null,
          series_index: book.series_index || null,
          publisher: book.publisher || null,
          pubdate: book.pubdate || null,
          rating: book.rating || null,
          comments: book.comments || null,
          formats: Array.isArray(book.formats) ? book.formats : (book.available_formats || []),
          languages: Array.isArray(book.languages) ? book.languages.join(", ") : null,
          identifiers: book.identifiers || {},
          last_modified: book.last_modified || null,
          timestamp: book.timestamp || null,
          cover: book.cover ? `${CALIBRE_URL}${book.cover}` : null,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_calibre_download ---
  server.tool(
    "crow_calibre_download",
    "Get a download URL for a book in a specified format (EPUB, PDF, MOBI, AZW3, etc.)",
    {
      book_id: z.number().describe("Book ID"),
      format: z.string().max(20).describe("File format (e.g., EPUB, PDF, MOBI, AZW3, TXT, CBZ)"),
    },
    async ({ book_id, format }) => {
      try {
        // Verify the book exists and has the requested format
        const books = await calibreFetch(`/ajax/books?ids=${book_id}`);
        const book = books[String(book_id)];

        if (!book) {
          return { content: [{ type: "text", text: `Book with ID ${book_id} not found.` }] };
        }

        const formats = Array.isArray(book.formats) ? book.formats : (book.available_formats || []);
        const upperFormat = format.toUpperCase();
        const available = formats.map((f) => f.toUpperCase());

        if (!available.includes(upperFormat)) {
          return {
            content: [{
              type: "text",
              text: `Format "${upperFormat}" not available for "${book.title}". Available formats: ${available.join(", ") || "none"}`,
            }],
          };
        }

        const downloadUrl = `${CALIBRE_URL}/get/${upperFormat}/${book_id}`;
        const authNote = CALIBRE_USERNAME ? " (requires authentication)" : "";

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              title: book.title,
              format: upperFormat,
              downloadUrl,
              note: `Direct download link${authNote}. Open in browser or use curl/wget.`,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_calibre_list_categories ---
  server.tool(
    "crow_calibre_list_categories",
    "List available categories in the Calibre library (authors, tags, series, publishers, languages, ratings)",
    {},
    async () => {
      try {
        const data = await calibreFetch("/ajax/categories");
        const categories = (data || []).map((cat) => ({
          name: cat.name,
          url: cat.url,
          icon: cat.icon || null,
          count: cat.count || null,
        }));

        return {
          content: [{
            type: "text",
            text: categories.length > 0
              ? `${categories.length} category type(s):\n${JSON.stringify(categories, null, 2)}`
              : "No categories found.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_calibre_browse_category ---
  server.tool(
    "crow_calibre_browse_category",
    "Browse books within a specific category (e.g., a particular author, tag, or series)",
    {
      category: z.string().max(100).describe("Category type (e.g., 'authors', 'tags', 'series', 'publisher', 'languages', 'rating')"),
      item_id: z.string().max(200).optional().describe("Specific item within the category (e.g., author name encoded). Omit to list all items in the category."),
      limit: z.number().min(1).max(100).optional().default(20).describe("Max results (default 20)"),
      offset: z.number().min(0).optional().default(0).describe("Start offset for pagination"),
    },
    async ({ category, item_id, limit, offset }) => {
      try {
        if (!item_id) {
          // List all items in this category
          const params = new URLSearchParams({
            num: String(limit),
            offset: String(offset),
          });
          const data = await calibreFetch(`/ajax/category/${encodeURIComponent(category)}?${params}`);
          const items = (data.items || []).map((item) => ({
            name: item.name,
            count: item.count || null,
            url: item.url || null,
            id: item.id || null,
          }));

          const total = data.total_num || items.length;

          return {
            content: [{
              type: "text",
              text: items.length > 0
                ? `Showing ${items.length} of ${total} ${category} (offset ${offset}):\n${JSON.stringify(items, null, 2)}`
                : `No items found in category "${category}".`,
            }],
          };
        }

        // List books within a specific category item
        const params = new URLSearchParams({
          num: String(limit),
          offset: String(offset),
        });
        const data = await calibreFetch(`/ajax/category/${encodeURIComponent(category)}/${encodeURIComponent(item_id)}?${params}`);
        const bookIds = data.book_ids || [];

        if (bookIds.length === 0) {
          return {
            content: [{ type: "text", text: `No books found in ${category}/${item_id}.` }],
          };
        }

        const idsParam = bookIds.join(",");
        const books = await calibreFetch(`/ajax/books?ids=${idsParam}`);
        const items = Object.values(books).map(formatBook);

        return {
          content: [{
            type: "text",
            text: `${items.length} book(s) in ${category}/${item_id}:\n${JSON.stringify(items, null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}
