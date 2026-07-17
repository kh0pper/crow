/**
 * Crow PM Workspace MCP Server
 *
 * Factory: createPmWorkspaceServer(db, options?)
 * Tools: crow_pm_note_create, crow_pm_note_get, crow_pm_note_list,
 *        crow_pm_search, crow_pm_digest_preview, crow_pm_digest_send,
 *        crow_pm_sync_run, crow_pm_sync_status, crow_pm_status
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { resolveDbPath, resolveTasksDbPath } from "./db.js";
import { createNote, getNote, listNotes, searchNotes } from "./notes.js";
import { ocrNote } from "./ocr.js";
import { indexNote } from "./memory-index.js";
import { smtpConfigured } from "./mailer.js";
import { preview, runDigest } from "./digest/index.js";
import { runSync } from "./sync/monday.js";
import { loadSyncConfig } from "./sync/mapping.js";

function text(t) {
  return { content: [{ type: "text", text: t }] };
}

function errorText(t) {
  return { content: [{ type: "text", text: t }], isError: true };
}

export function createPmWorkspaceServer(db, options = {}) {
  const server = new McpServer(
    { name: "crow-pm-workspace", version: "1.0.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  // ── Notes ──

  server.tool(
    "crow_pm_note_create",
    "Create a PM Workspace note. kind 'markdown' takes content_md; kind 'drawing' takes strokes_json (editor canvas JSON) and optionally image_data_url (PNG snapshot for OCR). Drawing notes are usually created from the panel editor — use markdown here unless you have canvas data.",
    {
      title: z.string().min(1).max(300).describe("Note title"),
      kind: z.enum(["markdown", "drawing"]).default("markdown").describe("Note kind"),
      content_md: z.string().max(200_000).optional().describe("Markdown body (markdown notes)"),
      strokes_json: z.string().max(2_000_000).optional().describe("Canvas serialization JSON (drawing notes)"),
      image_data_url: z.string().max(20_000_000).optional().describe("PNG data URL snapshot (drawing notes)"),
      tags: z.string().max(500).optional().describe("Comma-separated tags"),
      board_ref: z.string().max(200).optional().describe("Optional related board/tracker reference"),
      index_memory: z.boolean().default(true).describe("Also index the note into crow memories (best-effort embed)"),
    },
    async ({ title, kind, content_md, strokes_json, image_data_url, tags, board_ref, index_memory }) => {
      const note = await createNote(db, { title, kind, content_md, strokes_json, image_data_url, tags, board_ref });
      let indexed = null;
      if (index_memory && (note.content_md || note.ocr_text)) {
        indexed = await indexNote(db, note, loadConfig());
      }
      return text(JSON.stringify({ note: { ...note, strokes_json: undefined }, indexed }, null, 2));
    }
  );

  server.tool(
    "crow_pm_note_get",
    "Get a PM Workspace note by id, including its full content, OCR text, and tags.",
    {
      id: z.number().int().positive().describe("Note id"),
      include_strokes: z.boolean().default(false).describe("Include the raw canvas strokes JSON (large)"),
    },
    async ({ id, include_strokes }) => {
      const note = await getNote(db, id);
      if (!note) return errorText(`Note ${id} not found.`);
      if (!include_strokes) note.strokes_json = note.strokes_json ? "(omitted — pass include_strokes:true)" : null;
      return text(JSON.stringify(note, null, 2));
    }
  );

  server.tool(
    "crow_pm_note_list",
    "List PM Workspace notes (most recently updated first), with short excerpts.",
    {
      kind: z.enum(["markdown", "drawing"]).optional().describe("Filter by kind"),
      tag: z.string().max(100).optional().describe("Filter by tag substring"),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    },
    async ({ kind, tag, limit, offset }) => {
      const rows = await listNotes(db, { kind, tag, limit, offset });
      return text(JSON.stringify(rows, null, 2));
    }
  );

  server.tool(
    "crow_pm_ocr_note",
    "Run handwriting OCR on a drawing note's PNG snapshot via the configured vision endpoint, store the transcription, and index it into memories.",
    {
      id: z.number().int().positive().describe("Drawing note id"),
    },
    async ({ id }) => {
      const note = await getNote(db, id);
      if (!note) return errorText(`Note ${id} not found.`);
      if (note.kind !== "drawing") return errorText(`Note ${id} is not a drawing note.`);
      if (!note.image_path) return errorText(`Note ${id} has no PNG snapshot yet (save it from the drawing editor first).`);
      const config = loadConfig();
      try {
        const result = await ocrNote(db, note, config);
        const fresh = await getNote(db, id);
        const indexed = await indexNote(db, fresh, config);
        return text(JSON.stringify({ ok: true, ocr_text: result.text, indexed }, null, 2));
      } catch (err) {
        return errorText(`OCR failed: ${err.message}`);
      }
    }
  );

  server.tool(
    "crow_pm_search",
    "Search PM Workspace notes. Default is FTS over titles, markdown, OCR text, and tags. With semantic:true, also ranks crow memories by embedding similarity when an embed endpoint is configured.",
    {
      query: z.string().min(1).max(500).describe("Search query"),
      limit: z.number().int().min(1).max(50).default(20),
      semantic: z.boolean().default(false).describe("Also run embeddings-similarity search over memories"),
    },
    async ({ query, limit, semantic }) => {
      const fts = await searchNotes(db, query, { limit });
      const out = { fts };

      if (semantic) {
        const config = loadConfig();
        out.semantic = await semanticSearch(db, query, config, limit).catch((err) => ({
          error: `semantic search unavailable: ${err.message}`,
        }));
      }
      return text(JSON.stringify(out, null, 2));
    }
  );

  // ── Digest ──

  server.tool(
    "crow_pm_digest_preview",
    "Assemble and render today's digest WITHOUT saving or sending anything. Returns the plain-text rendering plus a summary of which adapters were available.",
    {},
    async () => {
      const config = loadConfig();
      const result = await preview(db, config);
      return text(JSON.stringify({
        date: result.date,
        summary: result.summary,
        adapters: result.sections.map((s) => ({ title: s.title, available: s.available, reason: s.reason || null })),
        text: result.text,
      }, null, 2));
    }
  );

  server.tool(
    "crow_pm_digest_send",
    "Run today's digest for real: save a pm_digests row, email it when SMTP is configured, and push a short ntfy summary when NTFY_TOPIC is set.",
    {
      force: z.boolean().default(false).describe("Re-run even if today's digest row already exists"),
    },
    async ({ force }) => {
      const config = loadConfig();
      const result = await runDigest(db, config, { force });
      return text(JSON.stringify(result, null, 2));
    }
  );

  // ── Sync ──

  server.tool(
    "crow_pm_sync_run",
    "Run one deterministic Monday.com sync pass over every board in the sync config (mirror boards pull into trackers; twoway boards three-way merge with the kanban tasks DB).",
    {},
    async () => {
      const config = loadConfig();
      const result = await runSync(db, config);
      return text(JSON.stringify(result, null, 2));
    }
  );

  server.tool(
    "crow_pm_sync_status",
    "Show Monday sync health: per-board mapped-item counts, last-synced times, and the recent pm_sync_log tail (conflicts, flags, errors).",
    {
      log_limit: z.number().int().min(1).max(100).default(20).describe("How many recent log rows to include"),
    },
    async ({ log_limit }) => {
      const state = await db.execute({
        sql: `SELECT board_id, local_kind, COUNT(*) AS items, MAX(last_synced_at) AS last_synced
              FROM pm_sync_state GROUP BY board_id, local_kind ORDER BY board_id`,
        args: [],
      });
      const log = await db.execute({
        sql: `SELECT run_at, direction, board_id, action, item_ref, detail, ok
              FROM pm_sync_log ORDER BY id DESC LIMIT ?`,
        args: [log_limit],
      });
      return text(JSON.stringify({ boards: state.rows, recent_log: log.rows }, null, 2));
    }
  );

  // ── Status ──

  server.tool(
    "crow_pm_status",
    "Report PM Workspace configuration: which digest adapters and integrations are configured, DB paths in use, embed/OCR endpoints, and cron settings.",
    {},
    async () => {
      const config = loadConfig();
      let syncBoards = 0;
      let syncError = null;
      try {
        const sc = loadSyncConfig(config);
        syncBoards = sc.boards.length;
      } catch (err) {
        syncError = err.message;
      }
      const tasksDbPath = resolveTasksDbPath(config);
      const status = {
        db_path: resolveDbPath(),
        tasks_db: { path: tasksDbPath, exists: existsSync(tasksDbPath) },
        crons: {
          enabled: config.PM_RUN_CRON === "1",
          digest_cron: config.DIGEST_CRON,
          sync_cron: config.SYNC_CRON,
        },
        adapters: {
          smtp: smtpConfigured(config),
          ntfy: Boolean(config.NTFY_TOPIC),
          google: Boolean(config.GOOGLE_TOKEN_FILE && existsSync(config.GOOGLE_TOKEN_FILE)),
          box: false,
          outlook: false,
        },
        ocr: {
          configured: Boolean(config.OCR_VISION_URL && config.OCR_VISION_MODEL),
          url: config.OCR_VISION_URL || null,
          model: config.OCR_VISION_MODEL || null,
        },
        embed: {
          configured: Boolean(config.PM_EMBED_URL && config.PM_EMBED_MODEL),
          url: config.PM_EMBED_URL || null,
          model: config.PM_EMBED_MODEL || null,
        },
        monday: {
          token: Boolean(config.MONDAY_TOKEN),
          sync_config_file: config.SYNC_CONFIG_FILE || null,
          boards: syncBoards,
          config_error: syncError,
        },
      };
      return text(JSON.stringify(status, null, 2));
    }
  );

  return server;
}

// ── Semantic search helper (kept simple: brute-force cosine over blobs) ──

async function semanticSearch(db, query, config, limit) {
  if (!config.PM_EMBED_URL || !config.PM_EMBED_MODEL) {
    return { error: "PM_EMBED_URL/PM_EMBED_MODEL not configured" };
  }
  const res = await fetch(config.PM_EMBED_URL.replace(/\/+$/, "") + "/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.PM_EMBED_MODEL, input: [query] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return { error: `embed HTTP ${res.status}` };
  const json = await res.json();
  const q = Float32Array.from(json?.data?.[0]?.embedding || []);
  if (q.length === 0) return { error: "embed endpoint returned no vector" };

  const { rows } = await db.execute({
    sql: `SELECT e.memory_id, e.vec, m.content, m.source
          FROM memory_embeddings_blob e
          JOIN memories m ON m.id = e.memory_id
          WHERE e.model = ?`,
    args: [config.PM_EMBED_MODEL],
  });

  const scored = [];
  for (const row of rows) {
    const buf = Buffer.isBuffer(row.vec) ? row.vec : Buffer.from(row.vec);
    const aligned = buf.byteOffset % 4 === 0 ? buf : Buffer.from(buf);
    const v = new Float32Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 4));
    if (v.length !== q.length) continue;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < q.length; i++) {
      dot += q[i] * v[i];
      na += q[i] * q[i];
      nb += v[i] * v[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    scored.push({
      memory_id: row.memory_id,
      source: row.source,
      score: denom > 0 ? dot / denom : 0,
      excerpt: String(row.content || "").slice(0, 200),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return { model: config.PM_EMBED_MODEL, results: scored.slice(0, limit) };
}
