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

// Phase 6 C.1: tolerate three JSON output shapes from the summarization
// LLM call: bare `{...}`, fenced ```json {...} ```, or surrounding prose
// with a `{...}` somewhere inside. Returns null only when ALL three fail
// — the caller persists the raw text into glasses_note_sessions.summary_raw
// so an operator can debug from the Nest later instead of chasing logs.
function robustJsonExtract(text) {
  if (!text || typeof text !== "string") return null;
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// Phase 6 C.1: summarize a glasses dictation session into { summary,
// action_items[] }. Provider-agnostic — uses the gateway's chat adapter
// with NO tools (a one-shot completion). Returns parse_error +
// raw_excerpt so the caller can persist diagnostics on extraction
// failure instead of silently returning empty.
export async function summarizeSession({ noteId, topic }, db) {
  const { rows } = await db.execute({
    sql: "SELECT content FROM research_notes WHERE id = ?",
    args: [noteId],
  });
  const body = String(rows[0]?.content || "");
  if (!body.trim()) return { summary: null, action_items: [] };

  // Resolve AI provider from dashboard ai_profiles (default profile),
  // not .env — the gateway runs without .env AI_PROVIDER set when an
  // operator drives configuration through the Nest's Settings → AI
  // Profiles UI. Mirrors recordGlassesPhoto's vision-profile lookup.
  let adapter;
  try {
    const { getAiProfiles, createAdapterFromProfile } = await import("../../../servers/gateway/ai/provider.js");
    const profiles = await getAiProfiles(db, { includeKeys: true });
    const profile = profiles.find(p => p.isDefault) || profiles[0];
    if (!profile) {
      return { summary: null, action_items: [], parse_error: "No AI profile configured." };
    }
    ({ adapter } = await createAdapterFromProfile(profile, profile.defaultModel, db));
  } catch (err) {
    return { summary: null, action_items: [], parse_error: `AI provider unavailable: ${err.message}` };
  }

  const systemPrompt = `You are a meeting note summarizer. Output ONLY a JSON object with exactly two top-level keys: "summary" (string, 2-3 sentences capturing the gist) and "action_items" (array of objects, each with required "text" string and optional "owner" string and optional "due" ISO date string). Respond with ONLY the JSON object — no prose, no markdown fences.`;
  const userPrompt = `Notes from session "${topic || "(untitled)"}":\n\n${body}`;
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  let text = "";
  try {
    for await (const ev of adapter.chatStream(messages, [], { maxTokens: 2000, temperature: 0.2 })) {
      if (ev.type === "content_delta") text += ev.text;
    }
  } catch (err) {
    return { summary: null, action_items: [], parse_error: `LLM call failed: ${err.message}` };
  }

  const parsed = robustJsonExtract(text);
  if (!parsed || typeof parsed !== "object") {
    return {
      summary: null,
      action_items: [],
      parse_error: "Could not parse JSON from LLM response.",
      raw_excerpt: text.slice(0, 500),
      raw_full: text,
    };
  }
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : null,
    action_items: Array.isArray(parsed.action_items)
      ? parsed.action_items.filter(it => it && typeof it.text === "string")
      : [],
  };
}

const CONFIRM_MAX_RETRIES = 3;

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
    "Begin a note-taking session. Returns a session id. Use mode='dictation' for one-shot, 'session' for multi-turn discrete events, 'continuous' for up-to-2-hour streaming transcription (requires explicit user consent on the NEXT voice turn via crow_glasses_confirm_continuous_recording).",
    {
      topic: z.string().max(200).optional(),
      mode: z.enum(["dictation", "session", "continuous"]).optional().describe("Default: 'session'. 'continuous' marks the session awaiting-consent — you MUST read the returned consent_prompt aloud; the user confirms on the next voice turn via crow_glasses_confirm_continuous_recording. If you call start with continuous twice in a row without the user confirming, the second call will be rejected with consent_pending."),
      device_id: z.string().min(1).max(200).describe("The glasses device id taking notes."),
      project_id: z.number().int().optional(),
    },
    async ({ topic, mode = "session", device_id, project_id }) => {
      try {
        const { createDbClient } = await loadDb();
        const db = createDbClient();
        try {
          // Phase 6 C.3: continuous mode is consent-gated. Before creating
          // a new awaiting-consent session, reject if the device already
          // has one active — otherwise the LLM could roll the 120-s
          // freshness timer by calling start_note_session twice.
          if (mode === "continuous") {
            const existing = await db.execute({
              sql: `SELECT id FROM glasses_note_sessions
                    WHERE device_id = ?
                      AND status = 'active'
                      AND COALESCE(awaiting_consent, 0) = 1
                      AND consent_expires_at > datetime('now')
                    LIMIT 1`,
              args: [device_id],
            });
            if (existing.rows[0]) {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    error: "consent_pending",
                    existing_session_id: Number(existing.rows[0].id),
                    message: "Another continuous-mode session is awaiting consent. Wait for the user to confirm, or call crow_glasses_end_note_session on the existing session first.",
                  }, null, 2),
                }],
                isError: true,
              };
            }
          }

          const pid = project_id || await getOrCreateDefaultProject(db);
          const noteIns = await db.execute({
            sql: `INSERT INTO research_notes (project_id, content, created_at, updated_at)
                  VALUES (?, ?, datetime('now'), datetime('now'))`,
            args: [pid, topic ? `# ${topic}\n\n` : ""],
          });
          const note_id = Number(noteIns.lastInsertRowid);
          const isContinuous = mode === "continuous";
          const sessIns = await db.execute({
            sql: `INSERT INTO glasses_note_sessions (device_id, topic, mode, project_id, note_id, status, awaiting_consent, consent_expires_at)
                  VALUES (?, ?, ?, ?, ?, 'active', ?, ${isContinuous ? "datetime('now', '+120 seconds')" : "NULL"})`,
            args: [device_id, topic || null, mode, pid, note_id, isContinuous ? 1 : 0],
          });
          const session_id = Number(sessIns.lastInsertRowid);
          const payload = {
            session_id, note_id, project_id: pid, mode, topic,
            needs_consent: isContinuous,
          };
          if (isContinuous) {
            payload.consent_prompt = "I'll record and transcribe continuously for up to 2 hours. Confirm by saying 'yes, record' or 'cancel'.";
            payload.consent_expires_in_seconds = 120;
          }
          return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  // Phase 6 C.3: user explicitly authorizes continuous recording. The MCP
  // tool only validates DB state + clears the awaiting_consent flag; the
  // panel layer (runVoiceTurn) intercepts the _note_stream_begin sentinel
  // and actually sends the WebSocket envelope. This keeps the stdio MCP
  // process free of WS/session access, same pattern as
  // crow_glasses_capture_and_attach_photo.
  server.tool(
    "crow_glasses_confirm_continuous_recording",
    "Confirm the user's explicit consent to start continuous recording. MUST only be called when the user affirmatively responds to the consent prompt returned by crow_glasses_start_note_session({ mode: 'continuous' }). REJECTS if no matching awaiting-consent session exists, if the 120-second freshness window has expired, or if the session is no longer active. On any rejection, DO NOT retry — the user must re-initiate by starting a new session.",
    {
      session_id: z.number().int().describe("The session_id returned by the preceding crow_glasses_start_note_session({ mode: 'continuous' }) call."),
      device_id: z.string().min(1).max(200).describe("The glasses device id that will record."),
    },
    async ({ session_id, device_id }) => {
      try {
        const { createDbClient } = await loadDb();
        const db = createDbClient();
        try {
          // Fetch session state atomically with freshness check in SQL.
          const { rows } = await db.execute({
            sql: `SELECT id, mode, status, COALESCE(awaiting_consent, 0) AS awaiting_consent,
                         consent_expires_at, note_id, topic, project_id
                    FROM glasses_note_sessions
                   WHERE id = ? AND device_id = ?
                   LIMIT 1`,
            args: [session_id, device_id],
          });
          const sess = rows[0];
          if (!sess) {
            return { content: [{ type: "text", text: JSON.stringify({ error: "not_found", message: "Session not found or belongs to a different device." }, null, 2) }], isError: true };
          }
          if (sess.status !== "active") {
            return { content: [{ type: "text", text: JSON.stringify({ error: "not_active", status: sess.status, message: "Session is no longer active. Start a new one." }, null, 2) }], isError: true };
          }
          if (sess.mode !== "continuous") {
            return { content: [{ type: "text", text: JSON.stringify({ error: "wrong_mode", mode: sess.mode, message: "This tool only confirms continuous-mode sessions." }, null, 2) }], isError: true };
          }
          if (Number(sess.awaiting_consent) !== 1) {
            return { content: [{ type: "text", text: JSON.stringify({ error: "already_confirmed_or_not_awaiting", message: "This session is not awaiting consent (already confirmed, or was never started in continuous mode)." }, null, 2) }], isError: true };
          }
          // Freshness check — 120-second window from start_note_session.
          const fresh = await db.execute({
            sql: `SELECT (consent_expires_at > datetime('now')) AS fresh FROM glasses_note_sessions WHERE id = ?`,
            args: [session_id],
          });
          if (!Number(fresh.rows[0]?.fresh)) {
            // Consent window elapsed — force-cancel the stale session so the
            // device isn't blocked by a lingering awaiting_consent row.
            await db.execute({
              sql: `UPDATE glasses_note_sessions
                       SET status = 'cancelled', ended_at = datetime('now'),
                           awaiting_consent = 0, consent_expires_at = NULL
                     WHERE id = ?`,
              args: [session_id],
            });
            return { content: [{ type: "text", text: JSON.stringify({ error: "consent_expired", message: "The 120-second consent window elapsed. Session cancelled — ask the user to re-initiate." }, null, 2) }], isError: true };
          }
          // Accept: clear this session's consent flag and cancel any sibling
          // awaiting-consent sessions for the same device (defensive cleanup
          // in case the LLM created duplicates).
          await db.execute({
            sql: `UPDATE glasses_note_sessions
                     SET awaiting_consent = 0, consent_expires_at = NULL
                   WHERE id = ?`,
            args: [session_id],
          });
          await db.execute({
            sql: `UPDATE glasses_note_sessions
                     SET status = 'cancelled', ended_at = datetime('now'),
                         awaiting_consent = 0, consent_expires_at = NULL
                   WHERE device_id = ?
                     AND id != ?
                     AND status = 'active'
                     AND COALESCE(awaiting_consent, 0) = 1`,
            args: [device_id, session_id],
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                _note_stream_begin: {
                  device_id,
                  session_id: Number(session_id),
                  note_id: sess.note_id ? Number(sess.note_id) : null,
                  topic: sess.topic || null,
                },
                prose: "Recording started. I'll transcribe continuously until you say 'stop recording' or the 2-hour cap is reached.",
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Failed: ${err.message}` }], isError: true };
      }
    }
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
    "End a glasses note session. Runs summarization + action-item extraction via the configured AI provider, prepends a '## Summary' block to the backing note, and returns the structured result. The LLM should read the action_items back to the user and call crow_glasses_confirm_action_items on the next turn.",
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
          // Look up note + topic before flipping status, so we can summarize.
          const meta = await db.execute({
            sql: `SELECT note_id, topic, mode FROM glasses_note_sessions WHERE id = ?`,
            args: [sid],
          });
          const noteId = meta.rows[0]?.note_id;
          const topic = meta.rows[0]?.topic;
          const mode = meta.rows[0]?.mode;
          if (!noteId) {
            await db.execute({
              sql: `UPDATE glasses_note_sessions SET status = 'ended', ended_at = datetime('now') WHERE id = ?`,
              args: [sid],
            });
            return { content: [{ type: "text", text: "Session has no backing note; ended without summary." }], isError: true };
          }

          const result = await summarizeSession({ noteId, topic }, db);
          const actionItemsJson = JSON.stringify(result.action_items || []);

          // Persist summary fields. summary_raw captures the unparseable LLM
          // output for post-hoc debugging when robustJsonExtract failed.
          if (result.parse_error && result.raw_full) {
            await db.execute({
              sql: `UPDATE glasses_note_sessions
                    SET status = 'ended', ended_at = datetime('now'),
                        summary = NULL, action_items_json = '[]', summary_raw = ?
                    WHERE id = ?`,
              args: [String(result.raw_full).slice(0, 50_000), sid],
            });
          } else {
            await db.execute({
              sql: `UPDATE glasses_note_sessions
                    SET status = 'ended', ended_at = datetime('now'),
                        summary = ?, action_items_json = ?
                    WHERE id = ?`,
              args: [result.summary, actionItemsJson, sid],
            });
            // Prepend the summary block to the note so the operator sees it
            // first when reviewing in the Nest. Skip if no summary parsed.
            if (result.summary) {
              const block = `## Summary\n${result.summary}\n\n`;
              await db.execute({
                sql: `UPDATE research_notes
                      SET content = ? || COALESCE(content, ''), updated_at = datetime('now')
                      WHERE id = ?`,
                args: [block, noteId],
              });
            }
          }

          const out = {
            session_id: Number(sid),
            note_id: noteId,
            topic,
            summary: result.summary,
            action_items: result.action_items || [],
            needs_confirmation: (result.action_items || []).length > 0,
          };
          if (result.parse_error) {
            out.parse_error = result.parse_error;
            out.raw_excerpt = result.raw_excerpt;
          }
          // Phase 6 C.3: if this was a continuous-mode session, emit the
          // _note_stream_end sentinel so the panel (runVoiceTurn) tears down
          // the server-side note_stream state + WS envelope on the next
          // tool-result iteration. Non-continuous modes ignore this.
          if (mode === "continuous") {
            out._note_stream_end = {
              device_id,
              session_id: Number(sid),
              reason: "user_stop",
            };
          }
          return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "crow_glasses_undo_last_append",
    "Remove the most recently appended line from an active glasses note session. Use when the user says 'undo that' shortly after a wrong dictation. Returns the removed line text.",
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
          const sess = await db.execute({ sql: `SELECT note_id FROM glasses_note_sessions WHERE id = ?`, args: [sid] });
          const noteId = sess.rows[0]?.note_id;
          if (!noteId) return { content: [{ type: "text", text: "Session has no backing note." }], isError: true };
          const noteRow = await db.execute({ sql: `SELECT content FROM research_notes WHERE id = ?`, args: [noteId] });
          const content = String(noteRow.rows[0]?.content || "");
          if (!content) return { content: [{ type: "text", text: "Nothing to undo (note is empty)." }] };

          // crow_glasses_add_to_note appends `[HH:MM] <text>\n` lines.
          // Strip the LAST such line. If the last non-empty line doesn't
          // match that shape, decline rather than mangling a header or
          // operator-edited paragraph.
          const trimmed = content.replace(/\n+$/, "");
          const lastNl = trimmed.lastIndexOf("\n");
          const lastLine = lastNl === -1 ? trimmed : trimmed.slice(lastNl + 1);
          if (!/^\[\d{2}:\d{2}\] /.test(lastLine)) {
            return { content: [{ type: "text", text: "Last line wasn't a dictated entry — refusing to mutate." }], isError: true };
          }
          const remainder = lastNl === -1 ? "" : trimmed.slice(0, lastNl);
          const newContent = remainder ? remainder + "\n" : "";
          await db.execute({
            sql: `UPDATE research_notes SET content = ?, updated_at = datetime('now') WHERE id = ?`,
            args: [newContent, noteId],
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ session_id: Number(sid), removed: lastLine }, null, 2),
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
    "crow_glasses_confirm_action_items",
    "Confirm which action items from a just-summarized session to convert into Crow notifications. `keep` is 'all', 'none', or an array of 1-indexed item numbers. Retry budget: a malformed `keep` returns an error and increments confirm_retry_count; after 3 failures the call fails closed (zero items kept) so the operator must re-summarize.",
    {
      session_id: z.number().int(),
      keep: z.union([
        z.literal("all"),
        z.literal("none"),
        z.array(z.number().int().min(1).max(100)),
      ]),
    },
    async ({ session_id, keep }) => {
      try {
        const { createDbClient } = await loadDb();
        const db = createDbClient();
        try {
          const sess = await db.execute({
            sql: `SELECT id, action_items_json, COALESCE(confirm_retry_count, 0) AS retries
                  FROM glasses_note_sessions WHERE id = ?`,
            args: [session_id],
          });
          if (!sess.rows[0]) return { content: [{ type: "text", text: "Session not found." }], isError: true };
          const retries = Number(sess.rows[0].retries || 0);
          let items = [];
          try { items = JSON.parse(sess.rows[0].action_items_json || "[]"); } catch {}
          if (!Array.isArray(items)) items = [];

          // Normalize and validate `keep`. On malformed: increment retry
          // budget; if exhausted, fail closed (zero items kept).
          let toKeep = [];
          let invalid = false;
          if (keep === "all") {
            toKeep = items.slice();
          } else if (keep === "none") {
            toKeep = [];
          } else if (Array.isArray(keep)) {
            const seen = new Set();
            for (const idx of keep) {
              const n = Number(idx);
              if (!Number.isInteger(n) || n < 1 || n > items.length) { invalid = true; break; }
              if (!seen.has(n)) { seen.add(n); toKeep.push(items[n - 1]); }
            }
          } else {
            invalid = true;
          }

          if (invalid) {
            const newRetries = retries + 1;
            await db.execute({
              sql: `UPDATE glasses_note_sessions
                    SET confirm_retry_count = COALESCE(confirm_retry_count, 0) + 1
                    WHERE id = ?`,
              args: [session_id],
            });
            const remaining = Math.max(0, CONFIRM_MAX_RETRIES - newRetries);
            if (remaining === 0) {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    error: "confirm_failed_closed",
                    message: "0 items kept — ask the operator to re-summarize if needed.",
                    retries_remaining: 0,
                  }),
                }],
                isError: true,
              };
            }
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  error: "invalid_keep",
                  message: `\`keep\` must be 'all', 'none', or an array of 1-indexed integers in [1, ${items.length}].`,
                  retries_remaining: remaining,
                }),
              }],
              isError: true,
            };
          }

          // Insert notifications for kept items. Per the plan:
          // notifications is NOT in SYNCED_TABLES — action items surface
          // on whichever instance ran summarization; paired Crows get
          // their own from their own sessions.
          const { createNotification } = await import("../../../servers/shared/notifications.js");
          let created = 0;
          const failures = [];
          for (const it of toKeep) {
            try {
              const owner = it.owner ? ` (${it.owner})` : "";
              const due = it.due ? ` — due ${it.due}` : "";
              await createNotification(db, {
                title: `${it.text}${owner}${due}`,
                type: "reminder",
                source: "meta-glasses",
                priority: "normal",
                action_url: `/dashboard/notifications`,
              });
              created++;
            } catch (err) {
              failures.push(err.message);
            }
          }
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                session_id, kept: toKeep.length, created,
                failures: failures.length ? failures : undefined,
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

  server.tool(
    "crow_glasses_capture_and_attach_photo",
    "During an active note session, capture a photo via the paired glasses and attach it inline to the backing note as a markdown image. Use when the user says 'take a photo of this' or 'add a picture' mid-session. Returns a sentinel envelope — the meta-glasses panel intercepts it, triggers the capture, awaits upload + DB insert, appends `![caption](photo://<photo_id>) *HH:MM*` to the note, and enqueues a caption backfill row if no caption was supplied.",
    {
      device_id: z.string().min(1).max(200),
      session_id: z.number().int().optional().describe("Explicit session id; omit to use the most-recent active session for the device."),
      caption: z.string().max(500).optional().describe("Optional pre-written caption. If omitted, a '[caption pending]' placeholder is used until the auto-caption pipeline replaces it."),
    },
    async ({ device_id, session_id, caption }) => {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            _capture_and_attach: {
              device_id,
              session_id: session_id ?? null,
              caption: caption ?? null,
            },
            prose: "Capturing and attaching photo to the active note session.",
          }, null, 2),
        }],
      };
    },
  );

  return server;
}
