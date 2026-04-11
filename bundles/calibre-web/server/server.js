/**
 * Calibre-Web MCP Server
 *
 * Provides tools to interact with a Calibre-Web instance via its OPDS and JSON endpoints:
 * - Search books by title, author, or keyword
 * - List books with sorting and pagination
 * - Get detailed book metadata
 * - List and manage shelves
 * - Add books to shelves
 * - Track reading status
 * - Download books in available formats
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const CALIBRE_WEB_URL = (process.env.CALIBRE_WEB_URL || "http://localhost:8083").replace(/\/+$/, "");
const CALIBRE_WEB_API_KEY = process.env.CALIBRE_WEB_API_KEY || "";

/**
 * Make an authenticated request to the Calibre-Web API.
 * @param {string} path - API path
 * @param {object} [options] - fetch options
 * @returns {Promise<any>} parsed response (JSON or text)
 */
async function cwFetch(path, options = {}) {
  const url = `${CALIBRE_WEB_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const headers = {
      "Authorization": `Bearer ${CALIBRE_WEB_API_KEY}`,
      "Content-Type": "application/json",
      ...options.headers,
    };

    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers,
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error("Authentication failed — check CALIBRE_WEB_API_KEY");
      if (res.status === 404) throw new Error(`Not found: ${path}`);
      throw new Error(`Calibre-Web API error: ${res.status} ${res.statusText}`);
    }

    const contentType = res.headers.get("content-type") || "";
    const text = await res.text();

    if (contentType.includes("json")) {
      return JSON.parse(text);
    }

    // OPDS returns XML; try to parse JSON first, fall back to text
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Calibre-Web request timed out after 10s: ${path}`);
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Calibre-Web at ${CALIBRE_WEB_URL} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse an OPDS XML feed into a list of entries.
 * Simple regex-based parser for OPDS Atom feeds.
 */
function parseOpdsEntries(xml) {
  if (typeof xml !== "string") return [];
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[1];
    const getTag = (tag) => {
      const m = entryXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return m ? m[1].trim() : null;
    };

    // Get all link elements
    const links = [];
    const linkRegex = /<link([^>]*)\/?\s*>/g;
    let linkMatch;
    while ((linkMatch = linkRegex.exec(entryXml)) !== null) {
      const attrs = linkMatch[1];
      const href = (attrs.match(/href="([^"]*)"/) || [])[1] || null;
      const rel = (attrs.match(/rel="([^"]*)"/) || [])[1] || null;
      const type = (attrs.match(/type="([^"]*)"/) || [])[1] || null;
      if (href) links.push({ href, rel, type });
    }

    const idTag = getTag("id");
    const idMatch = idTag ? idTag.match(/(\d+)/) : null;

    entries.push({
      id: idMatch ? parseInt(idMatch[1], 10) : null,
      title: getTag("title"),
      author: getTag("name"),
      summary: getTag("summary") || getTag("content"),
      updated: getTag("updated"),
      links,
    });
  }
  return entries;
}

/**
 * Extract total results from OPDS feed.
 */
function getOpdsTotalResults(xml) {
  if (typeof xml !== "string") return null;
  const m = xml.match(/<opensearch:totalResults>(\d+)<\/opensearch:totalResults>/);
  return m ? parseInt(m[1], 10) : null;
}

export function createCalibreWebServer(options = {}) {
  const server = new McpServer(
    { name: "crow-calibre-web", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- crow_calibreweb_search ---
  server.tool(
    "crow_calibreweb_search",
    "Search the Calibre-Web library by title, author, or keyword. Returns matching books.",
    {
      query: z.string().max(500).describe("Search text (title, author, or keyword)"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Max results (default 20)"),
    },
    async ({ query, limit }) => {
      try {
        const params = new URLSearchParams({ query });
        const data = await cwFetch(`/opds/search?${params}`);
        const entries = parseOpdsEntries(data);
        const total = getOpdsTotalResults(data);

        const items = entries.slice(0, limit).map((entry) => ({
          id: entry.id,
          title: entry.title,
          author: entry.author,
          summary: entry.summary ? entry.summary.slice(0, 200) + (entry.summary.length > 200 ? "..." : "") : null,
          downloadLinks: entry.links
            .filter((l) => l.rel === "http://opds-spec.org/acquisition" || (l.type && l.type.includes("application")))
            .map((l) => ({ format: l.type, url: `${CALIBRE_WEB_URL}${l.href}` })),
          readerUrl: entry.id ? `${CALIBRE_WEB_URL}/read/${entry.id}` : null,
        }));

        return {
          content: [{
            type: "text",
            text: items.length > 0
              ? `Found ${total || items.length} result(s):\n${JSON.stringify(items, null, 2)}`
              : `No results found for "${query}".`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_calibreweb_list_books ---
  server.tool(
    "crow_calibreweb_list_books",
    "List books in the Calibre-Web library. Browse by newest, oldest, or rated.",
    {
      sort_by: z.enum(["new", "old", "rated", "hot", "author", "title"]).optional().default("new").describe("Sort/browse mode"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Max results (default 20)"),
    },
    async ({ sort_by, limit }) => {
      try {
        const feedMap = {
          new: "/opds/new",
          old: "/opds",
          rated: "/opds/rated",
          hot: "/opds/hot",
          author: "/opds/author",
          title: "/opds",
        };

        const data = await cwFetch(feedMap[sort_by] || "/opds");
        const entries = parseOpdsEntries(data);
        const total = getOpdsTotalResults(data);

        const items = entries.slice(0, limit).map((entry) => ({
          id: entry.id,
          title: entry.title,
          author: entry.author,
          updated: entry.updated || null,
        }));

        return {
          content: [{
            type: "text",
            text: items.length > 0
              ? `Showing ${items.length} of ${total || items.length} book(s) (sorted by ${sort_by}):\n${JSON.stringify(items, null, 2)}`
              : "No books found.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_calibreweb_get_book ---
  server.tool(
    "crow_calibreweb_get_book",
    "Get detailed information about a specific book by ID, including reader URL and download links",
    {
      book_id: z.number().describe("Book ID"),
    },
    async ({ book_id }) => {
      try {
        // Fetch the book via OPDS search
        const data = await cwFetch(`/opds/search?query=id:${book_id}`);
        const entries = parseOpdsEntries(data);
        const entry = entries.find((e) => e.id === book_id) || entries[0];

        if (!entry) {
          return { content: [{ type: "text", text: `Book with ID ${book_id} not found.` }] };
        }

        const result = {
          id: entry.id,
          title: entry.title,
          author: entry.author,
          summary: entry.summary || null,
          updated: entry.updated || null,
          readerUrl: `${CALIBRE_WEB_URL}/read/${book_id}`,
          downloadLinks: entry.links
            .filter((l) => l.rel === "http://opds-spec.org/acquisition" || (l.type && l.type.includes("application")))
            .map((l) => ({
              format: l.type,
              url: `${CALIBRE_WEB_URL}${l.href}`,
            })),
          coverUrl: entry.links
            .filter((l) => l.rel === "http://opds-spec.org/image" || (l.type && l.type.includes("image")))
            .map((l) => `${CALIBRE_WEB_URL}${l.href}`)[0] || null,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_calibreweb_shelves ---
  server.tool(
    "crow_calibreweb_shelves",
    "List available shelves (bookshelves/collections) in Calibre-Web",
    {},
    async () => {
      try {
        const data = await cwFetch("/opds/shelf");
        const entries = parseOpdsEntries(data);

        const shelves = entries.map((entry) => ({
          id: entry.id,
          name: entry.title,
          updated: entry.updated || null,
        }));

        return {
          content: [{
            type: "text",
            text: shelves.length > 0
              ? `${shelves.length} shelf/shelves:\n${JSON.stringify(shelves, null, 2)}`
              : "No shelves found. Create shelves in the Calibre-Web interface.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_calibreweb_add_to_shelf ---
  server.tool(
    "crow_calibreweb_add_to_shelf",
    "Add a book to a shelf in Calibre-Web",
    {
      shelf_id: z.number().describe("Shelf ID"),
      book_id: z.number().describe("Book ID to add"),
    },
    async ({ shelf_id, book_id }) => {
      try {
        await cwFetch(`/shelf/add/${shelf_id}/${book_id}`, { method: "POST" });

        return {
          content: [{
            type: "text",
            text: `Book ${book_id} added to shelf ${shelf_id}.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_calibreweb_reading_status ---
  server.tool(
    "crow_calibreweb_reading_status",
    "Get or set reading status for a book (read, unread, reading)",
    {
      book_id: z.number().describe("Book ID"),
      status: z.enum(["read", "unread", "reading"]).optional().describe("Set reading status (omit to just check current status)"),
    },
    async ({ book_id, status }) => {
      try {
        if (status) {
          const statusMap = { read: 1, unread: 0, reading: 2 };
          await cwFetch(`/ajax/toggleread/${book_id}`, {
            method: "POST",
            body: JSON.stringify({ read_status: statusMap[status] }),
          });

          return {
            content: [{
              type: "text",
              text: `Reading status for book ${book_id} set to "${status}".`,
            }],
          };
        }

        // Get current status by fetching book details
        const data = await cwFetch(`/opds/search?query=id:${book_id}`);
        const entries = parseOpdsEntries(data);
        const entry = entries.find((e) => e.id === book_id) || entries[0];

        return {
          content: [{
            type: "text",
            text: entry
              ? `Book: ${entry.title} by ${entry.author}\nReader URL: ${CALIBRE_WEB_URL}/read/${book_id}`
              : `Book with ID ${book_id} not found.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_calibreweb_download ---
  server.tool(
    "crow_calibreweb_download",
    "Get a download URL for a book in a specified format, or get the web reader URL",
    {
      book_id: z.number().describe("Book ID"),
      format: z.string().max(20).optional().describe("File format (e.g., epub, pdf, mobi). Omit for web reader URL."),
    },
    async ({ book_id, format }) => {
      try {
        if (!format) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                book_id,
                readerUrl: `${CALIBRE_WEB_URL}/read/${book_id}`,
                note: "Open this URL in a browser to read the book online.",
              }, null, 2),
            }],
          };
        }

        const downloadUrl = `${CALIBRE_WEB_URL}/download/${book_id}/${format.toLowerCase()}`;

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              book_id,
              format: format.toUpperCase(),
              downloadUrl,
              readerUrl: `${CALIBRE_WEB_URL}/read/${book_id}`,
              note: "Download link requires authentication. Open in browser or use the reader URL to read online.",
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
