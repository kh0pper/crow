/**
 * Reader MCP server. Milestone 1 tools:
 *   crow_reader_ingest, crow_reader_list, crow_reader_get
 * Later plans add: annotations, annotate, store_summary, search,
 * read_section, export.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { ingestDocument } from "./import.js";
import { listDocuments, getDocument } from "./queries.js";
import { loadConfig } from "./config.js";

const text = (t) => ({ content: [{ type: "text", text: t }] });
const errorText = (t) => ({ content: [{ type: "text", text: t }], isError: true });

export function createReaderServer(db, options = {}) {
  const server = new McpServer(
    { name: "crow-reader", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: options.instructions },
  );

  server.tool(
    "crow_reader_ingest",
    "Import a document into the reader library from a local file path or a URL. Stores the original as the archival copy, extracts readable paragraphs, and returns the document id and extraction status.",
    {
      path: z.string().optional().describe("Absolute local file path (pdf, html, txt, md)"),
      url: z.string().url().optional().describe("URL to fetch (web page or PDF)"),
      title: z.string().optional(),
      tags: z.string().optional().describe("Comma-separated tags"),
      ocr: z.boolean().optional().describe("Force Tesseract OCR for scanned PDFs"),
    },
    async ({ path, url, title, tags, ocr }) => {
      if (!path && !url) return errorText("Provide path or url");
      try {
        const config = loadConfig();
        let input;
        if (url) {
          input = { sourceType: "url", url, title, tags, ocr };
        } else {
          // Path allowlist: local reads only under configured roots
          // (default: the user home directory).
          const { resolve } = await import("node:path");
          const { homedir } = await import("node:os");
          const roots = (config.READER_INGEST_ROOTS || homedir())
            .split(":").filter(Boolean).map((r) => resolve(r));
          const target = resolve(path);
          if (!roots.some((r) => target === r || target.startsWith(r + "/"))) {
            return errorText(`Path outside READER_INGEST_ROOTS allowlist: ${target}`);
          }
          input = { sourceType: "mcp", buffer: readFileSync(target),
                    filename: basename(target), title, tags, ocr };
        }
        const result = await ingestDocument(db, config, input);
        return text(JSON.stringify(result, null, 2));
      } catch (err) {
        return errorText(`Ingest failed: ${err.message}`);
      }
    },
  );

  server.tool(
    "crow_reader_list",
    "List reader library documents with extraction status and reading progress. Optional FTS query and tag filter.",
    {
      query: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    async ({ query, tag, limit }) => {
      const rows = await listDocuments(db, { query, tag, limit: limit || 50 });
      return text(JSON.stringify(rows, null, 2));
    },
  );

  server.tool(
    "crow_reader_get",
    "Get one document's metadata, extraction diagnostics, and section list.",
    { id: z.number().int().positive() },
    async ({ id }) => {
      const got = await getDocument(db, id);
      if (!got) return errorText(`No document ${id}`);
      return text(JSON.stringify(got, null, 2));
    },
  );

  return server;
}
