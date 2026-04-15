/**
 * Meta Glasses MCP Server
 *
 * Exposes tools other skills (or Claude) can use to drive the paired glasses
 * indirectly — status probes, canned TTS, photo capture pokes. Actual audio
 * and camera flow is handled by the bundle's panel/routes.js endpoints; the
 * MCP tools here are intentionally thin.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function createMetaGlassesServer(options = {}) {
  const server = new McpServer(
    { name: "crow-meta-glasses", version: "0.1.0" },
    { instructions: options.instructions },
  );

  server.tool(
    "crow_glasses_status",
    "List paired Meta Ray-Ban Meta (Gen 2) glasses devices and their connection state.",
    {},
    async () => {
      // This tool runs in the MCP server process (stdio), which doesn't have
      // direct access to the gateway's DB client. Consumers should call
      // /api/meta-glasses/devices instead for authoritative data. We return
      // a hint so the LLM doesn't fabricate device state.
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            note: "Live device state is served by the Meta Glasses panel. Ask the user to open /dashboard/meta-glasses or call GET /api/meta-glasses/devices.",
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    "crow_glasses_speak",
    "Send a text line to be spoken through paired glasses. Requires the user to have at least one glasses device paired and online. Returns a hint string only — the panel handles delivery via WebSocket.",
    {
      text: z.string().min(1).max(1000).describe("What to say"),
      device_id: z.string().optional().describe("Target a specific device; omit to broadcast to all paired devices."),
    },
    async ({ text, device_id }) => {
      return {
        content: [{
          type: "text",
          text: `Queued for speech: ${JSON.stringify({ text, device_id: device_id || "broadcast" })}. The dispatch happens via the panel's /api/meta-glasses/say endpoint when the companion app holds an active /session socket.`,
        }],
      };
    },
  );

  server.tool(
    "crow_glasses_search_photos",
    "Search the glasses photo library by caption or extracted text (OCR). Returns top matches with presigned URLs, captions, and capture timestamps.",
    {
      query: z.string().min(1).max(500).describe("Free-text query; matched against caption + OCR via FTS5."),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)."),
    },
    async ({ query, limit = 10 }) => {
      try {
        const { createDbClient, sanitizeFtsQuery } = await import("../../../servers/db.js");
        const db = createDbClient();
        try {
          const q = sanitizeFtsQuery ? sanitizeFtsQuery(query) : query.replace(/['"]/g, " ");
          const { rows } = await db.execute({
            sql: `SELECT g.id, g.disk_path, g.caption, g.ocr_text, g.captured_at
                  FROM glasses_photos g JOIN glasses_photos_fts f ON g.id = f.rowid
                  WHERE glasses_photos_fts MATCH ?
                  ORDER BY g.captured_at DESC LIMIT ?`,
            args: [q, limit],
          });
          const hits = rows.map(r => ({
            id: Number(r.id),
            caption: r.caption,
            ocr_text: r.ocr_text,
            captured_at: r.captured_at,
            url: `/api/meta-glasses/photo/${encodeURIComponent(String(r.disk_path).split("/").pop())}`,
          }));
          return { content: [{ type: "text", text: JSON.stringify({ query, count: hits.length, hits }, null, 2) }] };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Search failed: ${err.message}` }], isError: true };
      }
    },
  );

  // ---- Phase 6: note sessions ----

  async function loadDb() {
    return import("../../../servers/db.js");
  }

  async function getOrCreateDefaultProject(db) {
    const { readSetting, writeSetting } = await import("../../../servers/gateway/dashboard/settings/registry.js");
    const cached = await readSetting(db, "meta_glasses_default_project_id");
    if (cached && /^\d+$/.test(cached)) return Number(cached);
    const ins = await db.execute({
      sql: `INSERT INTO research_projects (name, description, type, created_at)
            VALUES ('Glasses Dictation', 'Auto-captured notes from Meta glasses', 'research', datetime('now'))`,
      args: [],
    });
    const id = Number(ins.lastInsertRowid);
    try { await writeSetting(db, "meta_glasses_default_project_id", String(id), { scope: "local" }); } catch {}
    return id;
  }

  server.tool(
    "crow_glasses_start_note_session",
    "Begin a note-taking session. Returns a session id. Use mode='dictation' for one-shot, 'session' for multi-turn discrete events.",
    {
      topic: z.string().max(200).optional(),
      mode: z.enum(["dictation", "session", "continuous"]).optional().describe("Default: 'session'. 'continuous' is reserved; use 'session' unless you know the phone supports continuous streaming."),
      device_id: z.string().min(1).max(200).describe("The glasses device id taking notes."),
      project_id: z.number().int().optional(),
    },
    async ({ topic, mode = "session", device_id, project_id }) => {
      try {
        const { createDbClient } = await loadDb();
        const db = createDbClient();
        try {
          const pid = project_id || await getOrCreateDefaultProject(db);
          const noteIns = await db.execute({
            sql: `INSERT INTO research_notes (project_id, content, created_at, updated_at)
                  VALUES (?, ?, datetime('now'), datetime('now'))`,
            args: [pid, topic ? `# ${topic}\n\n` : ""],
          });
          const note_id = Number(noteIns.lastInsertRowid);
          const sessIns = await db.execute({
            sql: `INSERT INTO glasses_note_sessions (device_id, topic, mode, project_id, note_id, status)
                  VALUES (?, ?, ?, ?, ?, 'active')`,
            args: [device_id, topic || null, mode, pid, note_id],
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                session_id: Number(sessIns.lastInsertRowid),
                note_id, project_id: pid, mode, topic,
                needs_consent: mode === "continuous",
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "crow_glasses_add_to_note",
    "Append a line to an active glasses note session. If session_id is omitted, the most-recent active session for the device is used.",
    {
      text: z.string().min(1).max(10000),
      session_id: z.number().int().optional(),
      device_id: z.string().min(1).max(200).describe("Required if session_id is omitted so the server can locate the active session."),
    },
    async ({ text, session_id, device_id }) => {
      try {
        const { createDbClient } = await loadDb();
        const db = createDbClient();
        try {
          let sid = session_id;
          if (!sid) {
            const { rows } = await db.execute({
              sql: `SELECT id, note_id FROM glasses_note_sessions
                    WHERE device_id = ? AND status = 'active'
                    ORDER BY started_at DESC LIMIT 1`,
              args: [device_id],
            });
            if (!rows[0]) return { content: [{ type: "text", text: "No active session for device." }], isError: true };
            sid = rows[0].id;
          }
          const s = await db.execute({ sql: `SELECT note_id FROM glasses_note_sessions WHERE id = ?`, args: [sid] });
          if (!s.rows[0]) return { content: [{ type: "text", text: "Session not found." }], isError: true };
          const noteId = s.rows[0].note_id;
          const stamp = new Date().toTimeString().slice(0, 5);
          const line = `[${stamp}] ${text}\n`;
          await db.execute({
            sql: `UPDATE research_notes SET content = COALESCE(content, '') || ?, updated_at = datetime('now') WHERE id = ?`,
            args: [line, noteId],
          });
          return { content: [{ type: "text", text: `Appended: '${line.trim()}'. Say 'undo that' to remove if needed.` }] };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "crow_glasses_end_note_session",
    "End a glasses note session. Marks the session 'ended' and returns the backing note id for the operator to review in the Nest.",
    {
      session_id: z.number().int().optional(),
      device_id: z.string().min(1).max(200),
    },
    async ({ session_id, device_id }) => {
      try {
        const { createDbClient } = await loadDb();
        const db = createDbClient();
        try {
          let sid = session_id;
          if (!sid) {
            const { rows } = await db.execute({
              sql: `SELECT id FROM glasses_note_sessions
                    WHERE device_id = ? AND status = 'active'
                    ORDER BY started_at DESC LIMIT 1`,
              args: [device_id],
            });
            if (!rows[0]) return { content: [{ type: "text", text: "No active session for device." }], isError: true };
            sid = rows[0].id;
          }
          await db.execute({
            sql: `UPDATE glasses_note_sessions SET status = 'ended', ended_at = datetime('now') WHERE id = ?`,
            args: [sid],
          });
          const { rows } = await db.execute({
            sql: `SELECT note_id, topic FROM glasses_note_sessions WHERE id = ?`,
            args: [sid],
          });
          const note_id = rows[0]?.note_id;
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                session_id: Number(sid),
                note_id, topic: rows[0]?.topic,
                summary: "Session ended. Summarization + action-item extraction pipeline is deferred to a follow-up — the raw note is available in the Nest.",
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "crow_glasses_capture_photo",
    "Ask paired glasses to capture a still photo. Returns a hint string — the photo itself arrives asynchronously on the bundle's /session WebSocket.",
    {
      device_id: z.string().optional().describe("Target a specific device; omit to target the primary."),
    },
    async ({ device_id }) => {
      return {
        content: [{
          type: "text",
          text: `Photo capture requested for ${device_id || "primary device"}. Result lands in S3 and a presigned URL is returned on the session WebSocket.`,
        }],
      };
    },
  );

  return server;
}
