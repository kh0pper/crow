/**
 * TriliumNext MCP Server
 *
 * Provides tools to manage a TriliumNext knowledge base via ETAPI:
 * - Search notes (full-text and title-only)
 * - Get, create, update, delete notes
 * - Browse note tree
 * - Get/set note attributes
 * - Clip web pages as notes
 * - Export notes
 * - Recently modified notes
 * - Day notes (journal)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EtapiClient } from "./etapi.js";

const TRILIUM_URL = (process.env.TRILIUM_URL || "http://localhost:8088").replace(/\/+$/, "");
const TRILIUM_ETAPI_TOKEN = process.env.TRILIUM_ETAPI_TOKEN || "";

export function createTriliumServer(options = {}) {
  const server = new McpServer(
    { name: "crow-trilium", version: "1.0.0" },
    { instructions: options.instructions },
  );

  const etapi = new EtapiClient({ url: TRILIUM_URL, token: TRILIUM_ETAPI_TOKEN });

  // --- crow_trilium_search ---
  server.tool(
    "crow_trilium_search",
    "Full-text search across TriliumNext notes. Returns matching notes with metadata.",
    {
      query: z.string().max(500).describe("Search text"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Max results (default 20)"),
      fast_search: z.boolean().optional().default(false).describe("Title-only search (faster)"),
    },
    async ({ query, limit, fast_search }) => {
      try {
        const searchQuery = fast_search ? `note.title =* "${query}"` : query;
        const params = new URLSearchParams({
          search: searchQuery,
          limit: String(limit),
        });
        if (fast_search) {
          params.set("fastSearch", "true");
        }

        const data = await etapi.get(`notes?${params}`);
        const notes = (data.results || []).map((note) => ({
          noteId: note.noteId,
          title: note.title,
          type: note.type,
          dateModified: note.dateModified || null,
          dateCreated: note.dateCreated || null,
          isProtected: note.isProtected || false,
        }));

        return {
          content: [{
            type: "text",
            text: notes.length > 0
              ? `Found ${notes.length} note(s):\n${JSON.stringify(notes, null, 2)}`
              : `No notes found for "${query}".`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_trilium_get_note ---
  server.tool(
    "crow_trilium_get_note",
    "Get a note's content and metadata from TriliumNext.",
    {
      note_id: z.string().max(100).describe("Note ID"),
    },
    async ({ note_id }) => {
      try {
        const [note, content] = await Promise.all([
          etapi.get(`notes/${encodeURIComponent(note_id)}`),
          etapi.get(`notes/${encodeURIComponent(note_id)}/content`),
        ]);

        const result = {
          noteId: note.noteId,
          title: note.title,
          type: note.type,
          mime: note.mime || null,
          dateCreated: note.dateCreated || null,
          dateModified: note.dateModified || null,
          isProtected: note.isProtected || false,
          content: typeof content === "string" ? content : JSON.stringify(content),
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_trilium_create_note ---
  server.tool(
    "crow_trilium_create_note",
    "Create a new note in TriliumNext under a specified parent.",
    {
      parent_note_id: z.string().max(100).optional().default("root").describe("Parent note ID (default: root)"),
      title: z.string().max(500).describe("Note title"),
      content: z.string().max(50000).describe("Note content (HTML for text type, plain text for code)"),
      type: z.enum(["text", "code", "render", "book"]).optional().default("text").describe("Note type (default: text)"),
    },
    async ({ parent_note_id, title, content, type }) => {
      try {
        const result = await etapi.post("create-note", {
          parentNoteId: parent_note_id,
          title,
          content,
          type,
        });

        return {
          content: [{
            type: "text",
            text: `Note created:\n${JSON.stringify({
              noteId: result.note?.noteId,
              title: result.note?.title,
              type: result.note?.type,
              parentNoteId: parent_note_id,
            }, null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_trilium_update_note ---
  server.tool(
    "crow_trilium_update_note",
    "Update a note's title and/or content in TriliumNext.",
    {
      note_id: z.string().max(100).describe("Note ID to update"),
      title: z.string().max(500).optional().describe("New title (if changing)"),
      content: z.string().max(50000).optional().describe("New content (if changing)"),
    },
    async ({ note_id, title, content }) => {
      try {
        if (!title && content === undefined) {
          return { content: [{ type: "text", text: "Nothing to update — provide title and/or content." }] };
        }

        const encoded = encodeURIComponent(note_id);
        const updates = [];

        if (title) {
          await etapi.patch(`notes/${encoded}`, { title });
          updates.push(`title → "${title}"`);
        }

        if (content !== undefined) {
          await etapi.put(`notes/${encoded}/content`, content);
          updates.push("content updated");
        }

        return {
          content: [{
            type: "text",
            text: `Note ${note_id} updated: ${updates.join(", ")}.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_trilium_delete_note ---
  server.tool(
    "crow_trilium_delete_note",
    "Delete a note from TriliumNext. Requires explicit confirmation.",
    {
      note_id: z.string().max(100).describe("Note ID to delete"),
      confirm: z.enum(["yes"]).describe('Must be "yes" to confirm deletion'),
    },
    async ({ note_id, confirm }) => {
      try {
        if (confirm !== "yes") {
          return { content: [{ type: "text", text: 'Deletion cancelled — confirm must be "yes".' }] };
        }

        await etapi.delete(`notes/${encodeURIComponent(note_id)}`);

        return {
          content: [{
            type: "text",
            text: `Note ${note_id} deleted.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_trilium_browse_tree ---
  server.tool(
    "crow_trilium_browse_tree",
    "Browse the TriliumNext note tree from a starting note, showing children to a given depth.",
    {
      note_id: z.string().max(100).optional().default("root").describe("Starting note ID (default: root)"),
      depth: z.number().min(1).max(5).optional().default(2).describe("How deep to traverse (default 2, max 5)"),
    },
    async ({ note_id, depth }) => {
      try {
        async function buildTree(id, currentDepth) {
          const note = await etapi.get(`notes/${encodeURIComponent(id)}`);
          const node = {
            noteId: note.noteId,
            title: note.title,
            type: note.type,
            childCount: note.childNoteIds?.length || 0,
          };

          if (currentDepth < depth && note.childNoteIds?.length > 0) {
            // Limit children to prevent huge responses
            const childIds = note.childNoteIds.slice(0, 50);
            node.children = [];
            for (const childId of childIds) {
              try {
                const child = await buildTree(childId, currentDepth + 1);
                node.children.push(child);
              } catch {
                // Skip inaccessible children (protected, etc.)
              }
            }
            if (note.childNoteIds.length > 50) {
              node.truncated = `${note.childNoteIds.length - 50} more children not shown`;
            }
          }

          return node;
        }

        const tree = await buildTree(note_id, 0);

        return { content: [{ type: "text", text: JSON.stringify(tree, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_trilium_get_attributes ---
  server.tool(
    "crow_trilium_get_attributes",
    "Get all attributes (labels and relations) of a TriliumNext note.",
    {
      note_id: z.string().max(100).describe("Note ID"),
    },
    async ({ note_id }) => {
      try {
        const attrs = await etapi.get(`notes/${encodeURIComponent(note_id)}/attributes`);
        const list = (Array.isArray(attrs) ? attrs : []).map((a) => ({
          attributeId: a.attributeId,
          type: a.type,
          name: a.name,
          value: a.value,
          isInheritable: a.isInheritable || false,
        }));

        return {
          content: [{
            type: "text",
            text: list.length > 0
              ? `${list.length} attribute(s):\n${JSON.stringify(list, null, 2)}`
              : "No attributes found on this note.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_trilium_clip_web ---
  server.tool(
    "crow_trilium_clip_web",
    "Clip a web page and save it as a note in TriliumNext. Fetches the URL, extracts text content, and creates a note.",
    {
      url: z.string().max(2000).describe("URL to clip"),
      parent_note_id: z.string().max(100).optional().default("root").describe("Parent note ID (default: root)"),
      title: z.string().max(500).optional().describe("Custom title (auto-detected from page if omitted)"),
    },
    async ({ url, parent_note_id, title }) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        let html;
        try {
          const res = await fetch(url, {
            signal: controller.signal,
            headers: { "User-Agent": "Crow/1.0 (Web Clipper)" },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          html = await res.text();
        } catch (err) {
          if (err.name === "AbortError") throw new Error("Web page fetch timed out after 15s");
          throw new Error(`Failed to fetch URL: ${err.message}`);
        } finally {
          clearTimeout(timeout);
        }

        // Extract title from page if not provided
        let noteTitle = title;
        if (!noteTitle) {
          const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          noteTitle = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : url;
        }

        // Strip HTML tags to get text content, preserve basic structure
        const textContent = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<nav[\s\S]*?<\/nav>/gi, "")
          .replace(/<header[\s\S]*?<\/header>/gi, "")
          .replace(/<footer[\s\S]*?<\/footer>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\s+/g, " ")
          .trim();

        // Create as HTML note with source URL
        const noteContent = `<p><strong>Source:</strong> <a href="${url}">${url}</a></p><hr/><p>${textContent.slice(0, 45000)}</p>`;

        const result = await etapi.post("create-note", {
          parentNoteId: parent_note_id,
          title: noteTitle,
          content: noteContent,
          type: "text",
        });

        return {
          content: [{
            type: "text",
            text: `Web page clipped:\n${JSON.stringify({
              noteId: result.note?.noteId,
              title: noteTitle,
              sourceUrl: url,
              contentLength: textContent.length,
              parentNoteId: parent_note_id,
            }, null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_trilium_export ---
  server.tool(
    "crow_trilium_export",
    "Export a TriliumNext note in HTML or Markdown format.",
    {
      note_id: z.string().max(100).describe("Note ID to export"),
      format: z.enum(["html", "markdown"]).optional().default("html").describe("Export format (default: html)"),
    },
    async ({ note_id, format }) => {
      try {
        const encoded = encodeURIComponent(note_id);

        // Get note metadata
        const note = await etapi.get(`notes/${encoded}`);

        // Get content
        const content = await etapi.get(`notes/${encoded}/content`);
        const textContent = typeof content === "string" ? content : JSON.stringify(content);

        let exported;
        if (format === "markdown") {
          // Simple HTML-to-markdown conversion for text notes
          exported = textContent
            .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "# $1\n\n")
            .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "## $1\n\n")
            .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "### $1\n\n")
            .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "#### $1\n\n")
            .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
            .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**")
            .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*")
            .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "*$1*")
            .replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
            .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n")
            .replace(/<[^>]+>/g, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        } else {
          exported = textContent;
        }

        return {
          content: [{
            type: "text",
            text: `# ${note.title}\n\nFormat: ${format}\nNote ID: ${note.noteId}\nType: ${note.type}\n\n---\n\n${exported}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_trilium_recent ---
  server.tool(
    "crow_trilium_recent",
    "List recently modified notes in TriliumNext.",
    {
      limit: z.number().min(1).max(50).optional().default(10).describe("Number of recent notes (default 10)"),
    },
    async ({ limit }) => {
      try {
        const params = new URLSearchParams({
          search: "note.noteId != 'root'",
          limit: String(limit),
          orderBy: "dateModified",
          orderDirection: "desc",
        });

        const data = await etapi.get(`notes?${params}`);
        const notes = (data.results || []).map((note) => ({
          noteId: note.noteId,
          title: note.title,
          type: note.type,
          dateModified: note.dateModified || null,
        }));

        return {
          content: [{
            type: "text",
            text: notes.length > 0
              ? `${notes.length} recently modified note(s):\n${JSON.stringify(notes, null, 2)}`
              : "No recent notes found.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_trilium_day_note ---
  server.tool(
    "crow_trilium_day_note",
    "Get or create today's day note (journal entry) in TriliumNext.",
    {
      date: z.string().max(10).optional().describe("Date in YYYY-MM-DD format (default: today)"),
    },
    async ({ date }) => {
      try {
        const targetDate = date || new Date().toISOString().slice(0, 10);

        const note = await etapi.get(`calendar/days/${targetDate}`);

        return {
          content: [{
            type: "text",
            text: `Day note for ${targetDate}:\n${JSON.stringify({
              noteId: note.noteId,
              title: note.title,
              type: note.type,
              dateCreated: note.dateCreated || null,
              dateModified: note.dateModified || null,
            }, null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}
