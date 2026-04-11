/**
 * Paperless-ngx MCP Server
 *
 * Provides tools to manage a Paperless-ngx instance via REST API:
 * - Search documents (full-text OCR search)
 * - List documents with filters (tags, correspondent, date range)
 * - Get document metadata and content preview
 * - Download original/archived documents
 * - Upload documents
 * - List and create tags
 * - List and create correspondents
 * - Update document metadata
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const PAPERLESS_URL = (process.env.PAPERLESS_URL || "http://localhost:8000").replace(/\/+$/, "");
const PAPERLESS_API_TOKEN = process.env.PAPERLESS_API_TOKEN || "";

/**
 * Make an authenticated request to the Paperless-ngx API.
 * @param {string} path - API path (e.g., "/api/documents/")
 * @param {object} [options] - fetch options
 * @returns {Promise<any>} parsed JSON response
 */
async function paperlessFetch(path, options = {}) {
  const url = `${PAPERLESS_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Token ${PAPERLESS_API_TOKEN}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error("Authentication failed — check PAPERLESS_API_TOKEN");
      if (res.status === 404) throw new Error(`Not found: ${path}`);
      throw new Error(`Paperless API error: ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Paperless request timed out after 15s: ${path}`);
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Paperless-ngx at ${PAPERLESS_URL} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Make a multipart upload request to Paperless-ngx.
 */
async function paperlessUpload(path, formData) {
  const url = `${PAPERLESS_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Token ${PAPERLESS_API_TOKEN}`,
      },
      body: formData,
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error("Authentication failed — check PAPERLESS_API_TOKEN");
      throw new Error(`Paperless upload error: ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Document upload timed out after 60s");
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Paperless-ngx at ${PAPERLESS_URL} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export function createPaperlessServer(options = {}) {
  const server = new McpServer(
    { name: "crow-paperless", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- crow_paperless_search ---
  server.tool(
    "crow_paperless_search",
    "Full-text search across all documents in Paperless-ngx (searches OCR content, titles, tags, correspondents)",
    {
      query: z.string().max(500).describe("Search text (searches OCR content, titles, and metadata)"),
      ordering: z.enum(["created", "-created", "modified", "-modified", "title", "-title", "added", "-added"]).optional().default("-created").describe("Sort order (prefix - for descending)"),
      page: z.number().min(1).optional().default(1).describe("Page number"),
      page_size: z.number().min(1).max(100).optional().default(20).describe("Results per page (default 20)"),
    },
    async ({ query, ordering, page, page_size }) => {
      try {
        const params = new URLSearchParams({
          query,
          ordering,
          page: String(page),
          page_size: String(page_size),
        });

        const data = await paperlessFetch(`/api/documents/?${params}`);
        const total = data.count || 0;
        const docs = (data.results || []).map((doc) => ({
          id: doc.id,
          title: doc.title,
          correspondent: doc.correspondent_name || null,
          document_type: doc.document_type_name || null,
          tags: doc.tags_name || [],
          created: doc.created,
          added: doc.added,
          content_preview: doc.content ? doc.content.slice(0, 300) + (doc.content.length > 300 ? "..." : "") : null,
        }));

        return {
          content: [{
            type: "text",
            text: docs.length > 0
              ? `Found ${total} document(s) (showing page ${page}):\n${JSON.stringify(docs, null, 2)}`
              : `No documents found for "${query}".`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_paperless_list ---
  server.tool(
    "crow_paperless_list",
    "List documents with optional filters (tags, correspondent, document type, date range)",
    {
      tags: z.array(z.number()).optional().describe("Filter by tag IDs"),
      correspondent: z.number().optional().describe("Filter by correspondent ID"),
      document_type: z.number().optional().describe("Filter by document type ID"),
      created_after: z.string().max(20).optional().describe("Filter: created after date (YYYY-MM-DD)"),
      created_before: z.string().max(20).optional().describe("Filter: created before date (YYYY-MM-DD)"),
      ordering: z.enum(["created", "-created", "modified", "-modified", "title", "-title", "added", "-added"]).optional().default("-created"),
      page: z.number().min(1).optional().default(1),
      page_size: z.number().min(1).max(100).optional().default(20),
    },
    async ({ tags, correspondent, document_type, created_after, created_before, ordering, page, page_size }) => {
      try {
        const params = new URLSearchParams({
          ordering,
          page: String(page),
          page_size: String(page_size),
        });
        if (tags?.length) {
          tags.forEach((t) => params.append("tags__id__in", String(t)));
        }
        if (correspondent !== undefined) params.set("correspondent__id", String(correspondent));
        if (document_type !== undefined) params.set("document_type__id", String(document_type));
        if (created_after) params.set("created__date__gt", created_after);
        if (created_before) params.set("created__date__lt", created_before);

        const data = await paperlessFetch(`/api/documents/?${params}`);
        const total = data.count || 0;
        const docs = (data.results || []).map((doc) => ({
          id: doc.id,
          title: doc.title,
          correspondent: doc.correspondent_name || null,
          document_type: doc.document_type_name || null,
          tags: doc.tags_name || [],
          created: doc.created,
          added: doc.added,
        }));

        return {
          content: [{
            type: "text",
            text: docs.length > 0
              ? `${total} document(s) total (showing page ${page}):\n${JSON.stringify(docs, null, 2)}`
              : "No documents match the given filters.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_paperless_get ---
  server.tool(
    "crow_paperless_get",
    "Get detailed metadata and content preview for a specific document",
    {
      document_id: z.number().describe("Document ID"),
    },
    async ({ document_id }) => {
      try {
        const doc = await paperlessFetch(`/api/documents/${document_id}/`);

        const result = {
          id: doc.id,
          title: doc.title,
          correspondent: doc.correspondent_name || null,
          document_type: doc.document_type_name || null,
          tags: doc.tags_name || [],
          created: doc.created,
          modified: doc.modified,
          added: doc.added,
          archive_serial_number: doc.archive_serial_number || null,
          original_filename: doc.original_file_name || null,
          content: doc.content ? doc.content.slice(0, 2000) + (doc.content.length > 2000 ? "\n... (truncated)" : "") : null,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_paperless_download ---
  server.tool(
    "crow_paperless_download",
    "Get a download URL for the original or archived version of a document",
    {
      document_id: z.number().describe("Document ID"),
      version: z.enum(["original", "archived"]).optional().default("archived").describe("Which version to download (default: archived/OCR version)"),
    },
    async ({ document_id, version }) => {
      try {
        // Verify the document exists first
        await paperlessFetch(`/api/documents/${document_id}/`);

        const suffix = version === "original" ? "download" : "download";
        const versionPath = version === "original" ? "original" : "archived";
        const downloadUrl = `${PAPERLESS_URL}/api/documents/${document_id}/${suffix}/`;
        const previewUrl = `${PAPERLESS_URL}/api/documents/${document_id}/preview/`;

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              document_id,
              version,
              download_url: downloadUrl,
              preview_url: previewUrl,
              note: `Add "?original=true" to the download URL for the original file. URLs require Token auth header.`,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_paperless_upload ---
  server.tool(
    "crow_paperless_upload",
    "Upload a document to Paperless-ngx for OCR processing and archiving",
    {
      content_base64: z.string().max(50000000).describe("Base64-encoded file content"),
      filename: z.string().max(500).describe("Original filename (e.g., receipt.pdf)"),
      title: z.string().max(500).optional().describe("Document title (auto-generated if omitted)"),
      tags: z.array(z.number()).optional().describe("Tag IDs to assign"),
      correspondent: z.number().optional().describe("Correspondent ID to assign"),
    },
    async ({ content_base64, filename, title, tags, correspondent }) => {
      try {
        const buffer = Buffer.from(content_base64, "base64");
        const blob = new Blob([buffer]);

        const formData = new FormData();
        formData.append("document", blob, filename);
        if (title) formData.append("title", title);
        if (tags?.length) {
          tags.forEach((t) => formData.append("tags", String(t)));
        }
        if (correspondent !== undefined) formData.append("correspondent", String(correspondent));

        const result = await paperlessUpload("/api/documents/post_document/", formData);

        return {
          content: [{
            type: "text",
            text: `Document uploaded successfully. Task ID: ${result.task_id || result || "queued"}. Paperless-ngx will process and OCR the document in the background.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_paperless_tags ---
  server.tool(
    "crow_paperless_tags",
    "List all tags or create a new tag in Paperless-ngx",
    {
      action: z.enum(["list", "create"]).describe("Action to perform"),
      name: z.string().max(200).optional().describe("Tag name (required for create)"),
      color: z.string().max(7).optional().describe("Tag color hex (e.g., #ff0000)"),
    },
    async ({ action, name, color }) => {
      try {
        if (action === "create") {
          if (!name) throw new Error("Tag name is required for create action");
          const body = { name };
          if (color) body.color = color;
          const tag = await paperlessFetch("/api/tags/", {
            method: "POST",
            body: JSON.stringify(body),
          });
          return {
            content: [{
              type: "text",
              text: `Tag created: ${JSON.stringify({ id: tag.id, name: tag.name, color: tag.color }, null, 2)}`,
            }],
          };
        }

        // list
        const data = await paperlessFetch("/api/tags/?page_size=100");
        const tags = (data.results || []).map((t) => ({
          id: t.id,
          name: t.name,
          color: t.color || null,
          document_count: t.document_count || 0,
        }));

        return {
          content: [{
            type: "text",
            text: tags.length > 0
              ? `${tags.length} tag(s):\n${JSON.stringify(tags, null, 2)}`
              : "No tags found.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_paperless_correspondents ---
  server.tool(
    "crow_paperless_correspondents",
    "List all correspondents or create a new correspondent in Paperless-ngx",
    {
      action: z.enum(["list", "create"]).describe("Action to perform"),
      name: z.string().max(200).optional().describe("Correspondent name (required for create)"),
    },
    async ({ action, name }) => {
      try {
        if (action === "create") {
          if (!name) throw new Error("Correspondent name is required for create action");
          const corr = await paperlessFetch("/api/correspondents/", {
            method: "POST",
            body: JSON.stringify({ name }),
          });
          return {
            content: [{
              type: "text",
              text: `Correspondent created: ${JSON.stringify({ id: corr.id, name: corr.name }, null, 2)}`,
            }],
          };
        }

        // list
        const data = await paperlessFetch("/api/correspondents/?page_size=100");
        const correspondents = (data.results || []).map((c) => ({
          id: c.id,
          name: c.name,
          document_count: c.document_count || 0,
        }));

        return {
          content: [{
            type: "text",
            text: correspondents.length > 0
              ? `${correspondents.length} correspondent(s):\n${JSON.stringify(correspondents, null, 2)}`
              : "No correspondents found.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_paperless_update ---
  server.tool(
    "crow_paperless_update",
    "Update document metadata (title, tags, correspondent, document type)",
    {
      document_id: z.number().describe("Document ID to update"),
      title: z.string().max(500).optional().describe("New title"),
      tags: z.array(z.number()).optional().describe("New tag IDs (replaces all existing tags)"),
      correspondent: z.number().nullable().optional().describe("Correspondent ID (null to clear)"),
      document_type: z.number().nullable().optional().describe("Document type ID (null to clear)"),
      archive_serial_number: z.number().nullable().optional().describe("Archive serial number (null to clear)"),
    },
    async ({ document_id, title, tags, correspondent, document_type, archive_serial_number }) => {
      try {
        const body = {};
        if (title !== undefined) body.title = title;
        if (tags !== undefined) body.tags = tags;
        if (correspondent !== undefined) body.correspondent = correspondent;
        if (document_type !== undefined) body.document_type = document_type;
        if (archive_serial_number !== undefined) body.archive_serial_number = archive_serial_number;

        if (Object.keys(body).length === 0) {
          throw new Error("No fields to update — provide at least one of: title, tags, correspondent, document_type, archive_serial_number");
        }

        const doc = await paperlessFetch(`/api/documents/${document_id}/`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });

        return {
          content: [{
            type: "text",
            text: `Document ${document_id} updated:\n${JSON.stringify({
              id: doc.id,
              title: doc.title,
              correspondent: doc.correspondent_name || null,
              document_type: doc.document_type_name || null,
              tags: doc.tags_name || [],
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
