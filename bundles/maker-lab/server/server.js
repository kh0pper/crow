/**
 * Crow Maker Lab MCP Server
 *
 * Factory: createMakerLabServer(db, options?)
 *
 * Security model (from plan):
 * - Tools NEVER take learner_id directly; they take session_token and resolve
 *   server-side. LLM hallucinations cannot cross profiles.
 * - Output filter (reading-level + blocklist + length) runs on every maker_hint
 *   return before the companion speaks it.
 * - Rate limit per session on maker_hint (default 6/min).
 * - Session state machine: active → ending (5s flush) → revoked.
 * - Persona is resolved server-side from learner age / guest age_band, never
 *   from LLM output or client header.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";
import {
  personaForAge,
  ageBandFromGuestBand,
  resolvePersonaForSession,
  getLearnerAge,
  filterHint,
} from "./filters.js";
import { handleHintRequest } from "./hint-pipeline.js";

// ─── Constants ────────────────────────────────────────────────────────────

const SESSION_DEFAULT_MIN = 60;
const SESSION_MAX_MIN = 240;
const GUEST_MAX_MIN = 30;
const CODE_TTL_MIN = 10;
const ENDING_FLUSH_SEC = 5;

function mintToken() {
  return randomBytes(24).toString("base64url");
}

function mintRedemptionCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O
  const N = "23456789"; // no 0, 1
  const pick = (s) => s[Math.floor(Math.random() * s.length)];
  return `${pick(A)}${pick(A)}${pick(A)}-${pick(N)}${pick(N)}${pick(N)}`;
}

function addMinutesISO(min) {
  return new Date(Date.now() + min * 60_000).toISOString();
}

// ─── Session resolution ───────────────────────────────────────────────────

function mcpError(msg) {
  return { content: [{ type: "text", text: msg }], isError: true };
}

function mcpOk(obj) {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text", text }] };
}

/**
 * Resolve a session token to its live state. Returns null if unknown/revoked/expired.
 * Also transitions expired 'active' sessions to 'revoked' lazily.
 */
async function resolveSession(db, token) {
  if (!token || typeof token !== "string") return null;
  const r = await db.execute({
    sql: `SELECT s.*, rp.name AS learner_name
          FROM maker_sessions s
          LEFT JOIN research_projects rp ON rp.id = s.learner_id
          WHERE s.token = ?`,
    args: [token],
  });
  if (!r.rows.length) return null;
  const row = r.rows[0];
  if (row.state === "revoked") return null;
  if (row.expires_at && row.expires_at < new Date().toISOString()) {
    await db.execute({
      sql: `UPDATE maker_sessions SET state='revoked', revoked_at=datetime('now') WHERE token=?`,
      args: [token],
    });
    return null;
  }
  return row;
}

async function touchActivity(db, token, reason) {
  await db.execute({
    sql: `UPDATE maker_sessions SET last_activity_at=datetime('now'), idle_locked_at=NULL WHERE token=?`,
    args: [token],
  });
}

// ─── Factory ──────────────────────────────────────────────────────────────

export function createMakerLabServer(db, options = {}) {
  const server = new McpServer(
    { name: "crow-maker-lab", version: "0.1.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  // ─── Admin: learner CRUD ────────────────────────────────────────────────

  server.tool(
    "maker_create_learner",
    "Create a new learner profile. Admin-only. Captures consent (parent/guardian/teacher). Stored as a research_project with type='learner_profile'.",
    {
      name: z.string().min(1).max(100).describe("Learner's name (first name or nickname)"),
      age: z.number().int().min(3).max(100).describe("Age in years"),
      avatar: z.string().max(50).optional().describe("Live2D avatar model id (optional)"),
      consent: z.literal(true).describe("Must be true. The admin confirms consent (parent/guardian/teacher)."),
      notes: z.string().max(1000).optional(),
    },
    async ({ name, age, avatar, notes }) => {
      try {
        const meta = JSON.stringify({ age, avatar: avatar || null, notes: notes || null });
        const res = await db.execute({
          sql: `INSERT INTO research_projects (name, type, description, metadata, created_at, updated_at)
                VALUES (?, 'learner_profile', ?, ?, datetime('now'), datetime('now')) RETURNING id`,
          args: [name, notes || null, meta],
        });
        const learnerId = Number(res.rows[0].id);
        await db.execute({
          sql: `INSERT INTO maker_learner_settings (learner_id, consent_captured_at)
                VALUES (?, datetime('now'))`,
          args: [learnerId],
        });
        return mcpOk({ learner_id: learnerId, name, age, persona: personaForAge(age) });
      } catch (err) {
        return mcpError(`Failed to create learner: ${err.message}`);
      }
    }
  );

  server.tool(
    "maker_list_learners",
    "List all learner profiles. Admin-only.",
    {},
    async () => {
      const r = await db.execute({
        sql: `SELECT rp.id, rp.name, rp.metadata, rp.created_at,
                     mls.transcripts_enabled, mls.consent_captured_at
              FROM research_projects rp
              LEFT JOIN maker_learner_settings mls ON mls.learner_id = rp.id
              WHERE rp.type = 'learner_profile'
              ORDER BY rp.created_at DESC`,
        args: [],
      });
      const learners = r.rows.map((row) => {
        let meta = {};
        try { meta = JSON.parse(row.metadata || "{}"); } catch {}
        return {
          learner_id: Number(row.id),
          name: row.name,
          age: meta.age ?? null,
          persona: personaForAge(meta.age),
          transcripts_enabled: !!row.transcripts_enabled,
          consent_captured_at: row.consent_captured_at,
          created_at: row.created_at,
        };
      });
      return mcpOk({ learners });
    }
  );

  server.tool(
    "maker_get_learner",
    "Get one learner's full profile + settings. Admin-only.",
    { learner_id: z.number().int().positive() },
    async ({ learner_id }) => {
      const r = await db.execute({
        sql: `SELECT rp.id, rp.name, rp.metadata, rp.created_at, mls.*
              FROM research_projects rp
              LEFT JOIN maker_learner_settings mls ON mls.learner_id = rp.id
              WHERE rp.id = ? AND rp.type = 'learner_profile'`,
        args: [learner_id],
      });
      if (!r.rows.length) return mcpError(`Learner ${learner_id} not found`);
      const row = r.rows[0];
      let meta = {};
      try { meta = JSON.parse(row.metadata || "{}"); } catch {}
      return mcpOk({
        learner_id: Number(row.id),
        name: row.name,
        age: meta.age ?? null,
        avatar: meta.avatar ?? null,
        persona: personaForAge(meta.age),
        transcripts_enabled: !!row.transcripts_enabled,
        transcripts_retention_days: row.transcripts_retention_days ?? 30,
        idle_lock_default_min: row.idle_lock_default_min,
        auto_resume_min: row.auto_resume_min ?? 15,
        voice_input_enabled: !!row.voice_input_enabled,
        consent_captured_at: row.consent_captured_at,
        created_at: row.created_at,
      });
    }
  );

  server.tool(
    "maker_update_learner",
    "Update a learner's profile / settings. Admin-only.",
    {
      learner_id: z.number().int().positive(),
      name: z.string().min(1).max(100).optional(),
      age: z.number().int().min(3).max(100).optional(),
      avatar: z.string().max(50).optional(),
      transcripts_enabled: z.boolean().optional(),
      transcripts_retention_days: z.number().int().min(0).max(3650).optional(),
      idle_lock_default_min: z.number().int().min(0).max(240).optional(),
      auto_resume_min: z.number().int().min(0).max(240).optional(),
      voice_input_enabled: z.boolean().optional(),
    },
    async (args) => {
      const { learner_id } = args;
      const r = await db.execute({
        sql: `SELECT metadata FROM research_projects WHERE id=? AND type='learner_profile'`,
        args: [learner_id],
      });
      if (!r.rows.length) return mcpError(`Learner ${learner_id} not found`);
      let meta = {};
      try { meta = JSON.parse(r.rows[0].metadata || "{}"); } catch {}
      if (args.age != null) meta.age = args.age;
      if (args.avatar != null) meta.avatar = args.avatar;

      const sets = ["metadata=?, updated_at=datetime('now')"];
      const sqlArgs = [JSON.stringify(meta)];
      if (args.name != null) { sets.push("name=?"); sqlArgs.push(args.name); }
      sqlArgs.push(learner_id);
      await db.execute({
        sql: `UPDATE research_projects SET ${sets.join(", ")} WHERE id=?`,
        args: sqlArgs,
      });

      // Upsert settings row
      const settingsCols = ["transcripts_enabled", "transcripts_retention_days", "idle_lock_default_min", "auto_resume_min", "voice_input_enabled"];
      const updates = [];
      const updArgs = [];
      for (const c of settingsCols) {
        if (args[c] !== undefined) {
          updates.push(`${c}=?`);
          updArgs.push(typeof args[c] === "boolean" ? (args[c] ? 1 : 0) : args[c]);
        }
      }
      if (updates.length) {
        await db.execute({
          sql: `INSERT INTO maker_learner_settings (learner_id) VALUES (?)
                ON CONFLICT(learner_id) DO NOTHING`,
          args: [learner_id],
        });
        updArgs.push(learner_id);
        await db.execute({
          sql: `UPDATE maker_learner_settings SET ${updates.join(", ")}, updated_at=datetime('now') WHERE learner_id=?`,
          args: updArgs,
        });
      }
      return mcpOk({ updated: true, learner_id });
    }
  );

  server.tool(
    "maker_delete_learner",
    "Permanently delete a learner and cascade to sessions, transcripts, memories, and storage references. Tier-1 destructive action — admin confirms in panel before calling.",
    {
      learner_id: z.number().int().positive(),
      confirm: z.literal("DELETE").describe("Must equal the literal string 'DELETE' to proceed."),
      reason: z.string().max(500).optional(),
    },
    async ({ learner_id, reason }) => {
      const r = await db.execute({
        sql: `SELECT name FROM research_projects WHERE id=? AND type='learner_profile'`,
        args: [learner_id],
      });
      if (!r.rows.length) return mcpError(`Learner ${learner_id} not found`);
      const name = r.rows[0].name;
      // Cascade: sessions → transcripts (FK), codes (FK via session), bound_devices (FK),
      // settings (FK). Memories tagged source='maker-lab' with project_id = learner_id.
      await db.execute({ sql: `DELETE FROM maker_sessions WHERE learner_id=?`, args: [learner_id] });
      await db.execute({ sql: `DELETE FROM maker_transcripts WHERE learner_id=?`, args: [learner_id] });
      await db.execute({ sql: `DELETE FROM maker_bound_devices WHERE learner_id=?`, args: [learner_id] });
      await db.execute({ sql: `DELETE FROM maker_learner_settings WHERE learner_id=?`, args: [learner_id] });
      try {
        await db.execute({ sql: `DELETE FROM memories WHERE project_id=?`, args: [learner_id] });
      } catch {}
      await db.execute({ sql: `DELETE FROM research_projects WHERE id=? AND type='learner_profile'`, args: [learner_id] });
      return mcpOk({ deleted: true, learner_id, name, reason: reason || null });
    }
  );

  // ─── Admin: mode + sessions ─────────────────────────────────────────────

  server.tool(
    "maker_set_mode",
    "Switch deployment mode between solo, family, classroom. Admin-only. Downgrading family→solo refuses if more than one learner profile exists (use the Archive & Downgrade flow in the panel instead).",
    { mode: z.enum(["solo", "family", "classroom"]) },
    async ({ mode }) => {
      if (mode === "solo") {
        const r = await db.execute({
          sql: `SELECT COUNT(*) AS n FROM research_projects WHERE type='learner_profile'`,
          args: [],
        });
        if (Number(r.rows[0].n) > 1) {
          return mcpError("Cannot downgrade to solo mode: more than one learner profile exists. Use the 'Archive & Downgrade' flow in the panel.");
        }
      }
      await db.execute({
        sql: `INSERT INTO dashboard_settings (key, value) VALUES ('maker_lab.mode', ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        args: [mode],
      });
      return mcpOk({ mode });
    }
  );

  server.tool(
    "maker_start_session",
    "Mint a new kiosk session for a learner and return a redemption code (NOT the raw token). The QR/URL carries the code; the token is issued as an HttpOnly cookie on redemption. Admin-only.",
    {
      learner_id: z.number().int().positive(),
      duration_min: z.number().int().min(5).max(SESSION_MAX_MIN).default(SESSION_DEFAULT_MIN).optional(),
      idle_lock_min: z.number().int().min(0).max(240).optional(),
      batch_id: z.string().max(64).optional(),
    },
    async ({ learner_id, duration_min = SESSION_DEFAULT_MIN, idle_lock_min, batch_id }) => {
      const r = await db.execute({
        sql: `SELECT rp.id, rp.name, mls.transcripts_enabled, mls.idle_lock_default_min
              FROM research_projects rp
              LEFT JOIN maker_learner_settings mls ON mls.learner_id=rp.id
              WHERE rp.id=? AND rp.type='learner_profile'`,
        args: [learner_id],
      });
      if (!r.rows.length) return mcpError(`Learner ${learner_id} not found`);
      const learner = r.rows[0];
      const token = mintToken();
      const code = mintRedemptionCode();
      const expiresAt = addMinutesISO(duration_min);
      const codeExpiresAt = addMinutesISO(CODE_TTL_MIN);
      const idleMin = idle_lock_min ?? learner.idle_lock_default_min ?? null;

      await db.execute({
        sql: `INSERT INTO maker_sessions
              (token, learner_id, is_guest, expires_at, idle_lock_min, transcripts_enabled_snapshot, batch_id)
              VALUES (?, ?, 0, ?, ?, ?, ?)`,
        args: [token, learner_id, expiresAt, idleMin, learner.transcripts_enabled ? 1 : 0, batch_id || null],
      });
      await db.execute({
        sql: `INSERT INTO maker_redemption_codes (code, session_token, expires_at) VALUES (?, ?, ?)`,
        args: [code, token, codeExpiresAt],
      });
      return mcpOk({
        redemption_code: code,
        short_url: `/kiosk/r/${code}`,
        code_expires_at: codeExpiresAt,
        session_expires_at: expiresAt,
        learner_id,
        learner_name: learner.name,
        batch_id: batch_id || null,
      });
    }
  );

  server.tool(
    "maker_start_sessions_bulk",
    "Mint sessions for multiple learners sharing a batch_id. Returns an array of redemption codes for a printable QR sheet. Admin-only.",
    {
      learner_ids: z.array(z.number().int().positive()).min(1).max(50),
      duration_min: z.number().int().min(5).max(SESSION_MAX_MIN).optional(),
      idle_lock_min: z.number().int().min(0).max(240).optional(),
      batch_label: z.string().max(200).optional(),
    },
    async ({ learner_ids, duration_min = SESSION_DEFAULT_MIN, idle_lock_min, batch_label }) => {
      const batchId = randomUUID();
      await db.execute({
        sql: `INSERT INTO maker_batches (batch_id, label) VALUES (?, ?)`,
        args: [batchId, batch_label || null],
      });
      const sessions = [];
      for (const lid of learner_ids) {
        const r = await db.execute({
          sql: `SELECT rp.id, rp.name, mls.transcripts_enabled, mls.idle_lock_default_min
                FROM research_projects rp
                LEFT JOIN maker_learner_settings mls ON mls.learner_id=rp.id
                WHERE rp.id=? AND rp.type='learner_profile'`,
          args: [lid],
        });
        if (!r.rows.length) {
          sessions.push({ learner_id: lid, error: "not_found" });
          continue;
        }
        const learner = r.rows[0];
        const token = mintToken();
        const code = mintRedemptionCode();
        const expiresAt = addMinutesISO(duration_min);
        const codeExpiresAt = addMinutesISO(CODE_TTL_MIN);
        const idleMin = idle_lock_min ?? learner.idle_lock_default_min ?? null;
        await db.execute({
          sql: `INSERT INTO maker_sessions
                (token, learner_id, is_guest, expires_at, idle_lock_min, transcripts_enabled_snapshot, batch_id)
                VALUES (?, ?, 0, ?, ?, ?, ?)`,
          args: [token, lid, expiresAt, idleMin, learner.transcripts_enabled ? 1 : 0, batchId],
        });
        await db.execute({
          sql: `INSERT INTO maker_redemption_codes (code, session_token, expires_at) VALUES (?, ?, ?)`,
          args: [code, token, codeExpiresAt],
        });
        sessions.push({
          learner_id: lid, learner_name: learner.name,
          redemption_code: code, short_url: `/kiosk/r/${code}`,
          code_expires_at: codeExpiresAt, session_expires_at: expiresAt,
        });
      }
      return mcpOk({ batch_id: batchId, batch_label: batch_label || null, sessions });
    }
  );

  server.tool(
    "maker_start_guest_session",
    "Mint an ephemeral guest session (no learner profile, no memories, no transcripts, no artifact save). 30-min cap. Returns a direct short URL + preview cookie (no redemption code needed — no handoff).",
    {
      age_band: z.enum(["5-9", "10-13", "14+"]),
    },
    async ({ age_band }) => {
      const token = mintToken();
      const code = mintRedemptionCode();
      const expiresAt = addMinutesISO(GUEST_MAX_MIN);
      const codeExpiresAt = addMinutesISO(CODE_TTL_MIN);
      await db.execute({
        sql: `INSERT INTO maker_sessions
              (token, learner_id, is_guest, guest_age_band, expires_at, transcripts_enabled_snapshot)
              VALUES (?, NULL, 1, ?, ?, 0)`,
        args: [token, age_band, expiresAt],
      });
      await db.execute({
        sql: `INSERT INTO maker_redemption_codes (code, session_token, expires_at) VALUES (?, ?, ?)`,
        args: [code, token, codeExpiresAt],
      });
      return mcpOk({
        redemption_code: code,
        short_url: `/kiosk/r/${code}`,
        persona: ageBandFromGuestBand(age_band),
        session_expires_at: expiresAt,
        is_guest: true,
      });
    }
  );

  server.tool(
    "maker_end_session",
    "Gracefully end a session. Transitions active→ending with a 5s flush window, writes wrap-up memory for non-guest sessions, then revokes.",
    { session_token: z.string().min(1) },
    async ({ session_token }) => {
      const sess = await resolveSession(db, session_token);
      if (!sess) return mcpError("Session not found or already ended");
      if (sess.state === "ending") return mcpOk({ state: "ending", already: true });
      await db.execute({
        sql: `UPDATE maker_sessions SET state='ending', ending_started_at=datetime('now') WHERE token=?`,
        args: [session_token],
      });
      setTimeout(async () => {
        try {
          if (!sess.is_guest && sess.learner_id) {
            try {
              await db.execute({
                sql: `INSERT INTO memories (content, context, category, importance, tags, project_id, source, created_at)
                      VALUES (?, ?, 'learning', 4, 'maker-lab,session-end', ?, 'maker-lab', datetime('now'))`,
                args: [
                  `Session ran from ${sess.started_at}. Hints used: ${sess.hints_used}.`,
                  `Session ended — ${sess.learner_name || "learner"}`,
                  sess.learner_id,
                ],
              });
            } catch {}
          }
          await db.execute({
            sql: `UPDATE maker_sessions SET state='revoked', revoked_at=datetime('now') WHERE token=?`,
            args: [session_token],
          });
        } catch {}
      }, ENDING_FLUSH_SEC * 1000);
      return mcpOk({ state: "ending", flush_seconds: ENDING_FLUSH_SEC });
    }
  );

  server.tool(
    "maker_force_end_session",
    "Hard kill a session. Skips the 5s flush; any in-flight artifact save may be lost. Requires a reason (logged).",
    {
      session_token: z.string().min(1),
      reason: z.string().min(3).max(500),
    },
    async ({ session_token, reason }) => {
      const sess = await resolveSession(db, session_token);
      if (!sess) return mcpError("Session not found or already revoked");
      await db.execute({
        sql: `UPDATE maker_sessions SET state='revoked', revoked_at=datetime('now') WHERE token=?`,
        args: [session_token],
      });
      return mcpOk({ state: "revoked", reason });
    }
  );

  server.tool(
    "maker_revoke_batch",
    "Revoke every session in a batch (use when a printed QR sheet is lost). Admin-only. Requires a reason (logged).",
    {
      batch_id: z.string().min(1),
      reason: z.string().min(3).max(500),
    },
    async ({ batch_id, reason }) => {
      const r = await db.execute({
        sql: `UPDATE maker_sessions SET state='revoked', revoked_at=datetime('now')
              WHERE batch_id=? AND state != 'revoked' RETURNING token`,
        args: [batch_id],
      });
      await db.execute({
        sql: `UPDATE maker_batches SET revoked_at=datetime('now'), revoke_reason=? WHERE batch_id=?`,
        args: [reason, batch_id],
      });
      return mcpOk({ revoked: r.rows.length, batch_id, reason });
    }
  );

  server.tool(
    "maker_unlock_idle",
    "Clear an idle-locked session without ending it. Admin-only.",
    { session_token: z.string().min(1) },
    async ({ session_token }) => {
      const sess = await resolveSession(db, session_token);
      if (!sess) return mcpError("Session not found or already revoked");
      await db.execute({
        sql: `UPDATE maker_sessions SET idle_locked_at=NULL, last_activity_at=datetime('now') WHERE token=?`,
        args: [session_token],
      });
      return mcpOk({ unlocked: true });
    }
  );

  server.tool(
    "maker_redeem_code",
    "INTERNAL: redeem a one-shot code for a session token. The /kiosk/r/:code HTTP handler calls this server-side. Uses UPDATE...RETURNING so a race produces exactly one winner; expired codes fail atomically.",
    {
      code: z.string().min(3).max(32),
      kiosk_fingerprint: z.string().min(1).max(256),
    },
    async ({ code, kiosk_fingerprint }) => {
      const r = await db.execute({
        sql: `UPDATE maker_redemption_codes
              SET used_at=datetime('now'), claimed_by_fingerprint=?
              WHERE code=? AND used_at IS NULL AND expires_at > datetime('now')
              RETURNING session_token`,
        args: [kiosk_fingerprint, code],
      });
      if (!r.rows.length) return mcpError("Code invalid, expired, or already used");
      const token = r.rows[0].session_token;
      await db.execute({
        sql: `UPDATE maker_sessions SET kiosk_device_id=? WHERE token=?`,
        args: [kiosk_fingerprint, token],
      });
      return mcpOk({ session_token: token });
    }
  );

  // ─── Kid-session tools (all take session_token) ─────────────────────────

  server.tool(
    "maker_get_session_context",
    "Return non-PII context the companion's LLM can use to frame its hint: age band, persona, current lesson id, recent progress. No names, no memory content.",
    { session_token: z.string().min(1) },
    async ({ session_token }) => {
      const sess = await resolveSession(db, session_token);
      if (!sess) return mcpError("Session invalid or expired");
      const persona = await resolvePersonaForSession(db, sess);
      let recent = [];
      if (!sess.is_guest && sess.learner_id) {
        try {
          const r = await db.execute({
            sql: `SELECT context AS title, created_at FROM memories
                  WHERE project_id=? AND source='maker-lab'
                  ORDER BY created_at DESC LIMIT 5`,
            args: [sess.learner_id],
          });
          recent = r.rows.map((x) => ({ title: x.title, at: x.created_at }));
        } catch {}
      }
      await touchActivity(db, session_token);
      return mcpOk({
        persona,
        state: sess.state,
        is_guest: !!sess.is_guest,
        hints_used: sess.hints_used,
        recent_progress: recent,
      });
    }
  );

  server.tool(
    "maker_hint",
    "Request a scaffolded hint for the current activity. Output is filtered (reading-level / blocklist / length) and rate-limited. On filter failure, returns a canned lesson hint. In the 'ending' state, returns a wrap-up canned hint without calling the LLM.",
    {
      session_token: z.string().min(1),
      surface: z.string().max(50).describe("e.g. 'blockly'"),
      question: z.string().min(1).max(2000),
      level: z.number().int().min(1).max(3).default(1).optional(),
      lesson_id: z.string().max(100).optional(),
      canned_hints: z.array(z.string().max(500)).max(10).optional(),
    },
    async ({ session_token, surface, question, level = 1, lesson_id, canned_hints }) => {
      const sess = await resolveSession(db, session_token);
      if (!sess) return mcpError("Session invalid or expired");
      const result = await handleHintRequest(db, {
        sessionToken: session_token,
        session: sess,
        surface, question, level,
        lessonId: lesson_id || null,
        cannedHints: canned_hints || null,
      });
      return mcpOk(result);
    }
  );

  server.tool(
    "maker_log_progress",
    "Log a lesson-progress event for the session's learner. No-op for guest sessions. Writes a memory tagged source='maker-lab'.",
    {
      session_token: z.string().min(1),
      surface: z.string().max(50),
      activity: z.string().max(200),
      outcome: z.enum(["started", "completed", "abandoned", "struggled"]),
      note: z.string().max(2000).optional(),
    },
    async ({ session_token, surface, activity, outcome, note }) => {
      const sess = await resolveSession(db, session_token);
      if (!sess) return mcpError("Session invalid or expired");
      if (sess.state === "revoked") return mcpError("Session revoked");
      await touchActivity(db, session_token);
      if (sess.is_guest || !sess.learner_id) {
        return mcpOk({ logged: false, reason: "guest" });
      }
      try {
        await db.execute({
          sql: `INSERT INTO memories (content, context, category, importance, tags, project_id, source, created_at)
                VALUES (?, ?, 'learning', 5, ?, ?, 'maker-lab', datetime('now'))`,
          args: [
            note || `${outcome} on ${activity} in ${surface}`,
            `${surface}:${activity} — ${outcome}`,
            `maker-lab,${surface},${outcome}`,
            sess.learner_id,
          ],
        });
        return mcpOk({ logged: true, learner_id: sess.learner_id });
      } catch (err) {
        return mcpError(`Failed to log progress: ${err.message}`);
      }
    }
  );

  server.tool(
    "maker_next_suggestion",
    "Return a suggested next activity based on recent progress. No-op with a friendly canned reply for guest sessions.",
    { session_token: z.string().min(1) },
    async ({ session_token }) => {
      const sess = await resolveSession(db, session_token);
      if (!sess) return mcpError("Session invalid or expired");
      await touchActivity(db, session_token);
      if (sess.is_guest) {
        return mcpOk({ suggestion: "Try the next lesson from the menu!" });
      }
      // Phase 1: simple heuristic — if last outcome 'completed', suggest next; else repeat.
      try {
        const r = await db.execute({
          sql: `SELECT context AS title, tags FROM memories
                WHERE project_id=? AND source='maker-lab'
                ORDER BY created_at DESC LIMIT 1`,
          args: [sess.learner_id],
        });
        if (!r.rows.length) return mcpOk({ suggestion: "Start with the first Blockly lesson: moving the cat!" });
        const tags = String(r.rows[0].tags || "");
        if (tags.includes("completed")) {
          return mcpOk({ suggestion: "Great job finishing that! Ready for the next one?" });
        }
        return mcpOk({ suggestion: "Let's try that one again — we almost had it!" });
      } catch {
        return mcpOk({ suggestion: "Ready to build something cool?" });
      }
    }
  );

  server.tool(
    "maker_save_artifact",
    "Save a learner-produced artifact (e.g. Blockly workspace XML, drawing). Guest sessions return a friendly 'cannot save in guest mode' message. Real file storage lands in Phase 2.",
    {
      session_token: z.string().min(1),
      title: z.string().min(1).max(200),
      mime: z.string().max(100).default("application/octet-stream").optional(),
      blob_b64: z.string().max(1_500_000).describe("Base64-encoded artifact, max ~1MB"),
    },
    async ({ session_token, title, mime = "application/octet-stream", blob_b64 }) => {
      const sess = await resolveSession(db, session_token);
      if (!sess) return mcpError("Session invalid or expired");
      if (sess.is_guest) {
        return mcpOk({ saved: false, message: "Your work won't be saved in guest mode. Ask a grown-up to set up a profile to keep your creations!" });
      }
      // Phase 1: stub — record reference only, real storage upload lands in Phase 2.
      try {
        await db.execute({
          sql: `INSERT INTO memories (content, context, category, importance, tags, project_id, source, created_at)
                VALUES (?, ?, 'learning', 6, 'maker-lab,artifact', ?, 'maker-lab', datetime('now'))`,
          args: [
            `Saved ${mime}, ${blob_b64.length} bytes (base64) — Phase 2 will upload to crow-storage.`,
            `Artifact: ${title}`,
            sess.learner_id,
          ],
        });
        return mcpOk({ saved: true, title, note: "Phase 1 stub — real storage upload in Phase 2." });
      } catch (err) {
        return mcpError(`Failed to record artifact: ${err.message}`);
      }
    }
  );

  // ─── Admin: data handling (COPPA / GDPR-K) ──────────────────────────────

  server.tool(
    "maker_export_learner",
    "Export all data for a learner as a JSON bundle (for parental-request responses and right-to-be-forgotten preparation). Admin-only.",
    { learner_id: z.number().int().positive() },
    async ({ learner_id }) => {
      const [profile, settings, sessions, transcripts, memories] = await Promise.all([
        db.execute({ sql: `SELECT * FROM research_projects WHERE id=? AND type='learner_profile'`, args: [learner_id] }),
        db.execute({ sql: `SELECT * FROM maker_learner_settings WHERE learner_id=?`, args: [learner_id] }),
        db.execute({ sql: `SELECT token, started_at, expires_at, revoked_at, state, hints_used, batch_id FROM maker_sessions WHERE learner_id=?`, args: [learner_id] }),
        db.execute({ sql: `SELECT * FROM maker_transcripts WHERE learner_id=? ORDER BY created_at`, args: [learner_id] }),
        db.execute({ sql: `SELECT context AS title, content, tags, category, importance, created_at FROM memories WHERE project_id=? AND source='maker-lab' ORDER BY created_at`, args: [learner_id] }).catch(() => ({ rows: [] })),
      ]);
      if (!profile.rows.length) return mcpError(`Learner ${learner_id} not found`);
      return mcpOk({
        export_version: 1,
        exported_at: new Date().toISOString(),
        profile: profile.rows[0],
        settings: settings.rows[0] || null,
        sessions: sessions.rows,
        transcripts: transcripts.rows,
        memories: memories.rows,
      });
    }
  );

  // ─── Lesson authoring ───────────────────────────────────────────────────

  server.tool(
    "maker_validate_lesson",
    "Validate a lesson JSON against the schema. Returns specific errors so custom lesson authors (teachers/parents) can fix them without reading code.",
    { lesson: z.record(z.any()) },
    async ({ lesson }) => {
      const errs = [];
      const required = ["id", "title", "surface", "age_band", "steps", "canned_hints"];
      for (const k of required) {
        if (!(k in lesson)) errs.push(`missing: ${k}`);
      }
      if (lesson.age_band && !["5-9", "10-13", "14+"].includes(lesson.age_band)) {
        errs.push(`age_band must be one of 5-9 | 10-13 | 14+`);
      }
      if (lesson.canned_hints && !Array.isArray(lesson.canned_hints)) {
        errs.push("canned_hints must be an array of strings");
      }
      if (Array.isArray(lesson.canned_hints)) {
        for (let i = 0; i < lesson.canned_hints.length; i++) {
          if (typeof lesson.canned_hints[i] !== "string") {
            errs.push(`canned_hints[${i}] must be a string`);
          }
        }
      }
      if (lesson.reading_level != null && (typeof lesson.reading_level !== "number" || lesson.reading_level > 3)) {
        errs.push("reading_level must be a number ≤ 3 for the 5-9 band");
      }
      if (Array.isArray(lesson.steps)) {
        for (let i = 0; i < lesson.steps.length; i++) {
          const s = lesson.steps[i];
          if (!s || typeof s !== "object") { errs.push(`steps[${i}] must be an object`); continue; }
          if (!s.prompt) errs.push(`steps[${i}].prompt missing`);
        }
      }
      return mcpOk({ valid: errs.length === 0, errors: errs });
    }
  );

  return server;
}
