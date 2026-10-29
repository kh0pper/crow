/**
 * The hand-off log (voice_handoffs, migration 0018): one row per hand-off Crow proposes by voice, and
 * one per spoken "stop it" (kind 'stop'), from the proposal to its end.
 *
 * Every time is epoch ms from the store's injected `now()`, so a fake clock moves expires_at and the
 * sweep together. Every status change is one compare-and-set UPDATE (`transition`): of two racing
 * callers exactly one wins, and a `live` transition also refuses a row past its expires_at inside that
 * same UPDATE, so an expired proposal can never be confirmed. Status and kind have no CHECK in the
 * table; they are validated here.
 *
 * The table is local-only (instance-sync LOCAL_ONLY_TABLES). `asked` (the operator's verbatim speech)
 * is nulled by the sweep on declined and expired rows after HANDOFF_ASKED_RETAIN_MS; the task line stays.
 */
import { randomBytes } from "node:crypto";
import {
  HANDOFF_PROPOSAL_TTL_MS, HANDOFF_PHONE_TTL_MS, HANDOFF_TASK_MAX_CHARS, HANDOFF_ASKED_MAX_CHARS,
  HANDOFF_STARTING_STUCK_MS, HANDOFF_STOP_STUCK_MS, HANDOFF_ASKED_RETAIN_MS,
  HANDOFF_KINDS, HANDOFF_STATUSES, HANDOFF_OPEN, HANDOFF_LANGS,
} from "./handoff-constants.js";

// SQLite names the columns of a violated unique index, not the index itself.
const PHONE_OPEN_RE = /UNIQUE constraint failed: voice_handoffs\.device_id, voice_handoffs\.kind/;
const DECIDED = new Set(["starting", "declined"]);
const ENDED = new Set(["done", "failed", "stopped"]);
// The columns a transition may write beside its status, and the ones setFields may write on any row.
const TRANSITION_FIELDS = new Set(["card_id", "session_id", "thread_id", "target_id", "model_key", "outcome", "detail"]);
const SET_FIELDS = new Set(["card_id", "session_id", "thread_id", "detail"]);
const OPEN_IN = HANDOFF_OPEN.map(() => "?").join(",");

function assertStatus(s) {
  if (!HANDOFF_STATUSES.includes(s)) throw Object.assign(new Error(`voice_handoffs: unknown status ${JSON.stringify(s)}`), { code: "bad_status" });
}

function cap(value, max) {
  if (value == null) return null;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

function columns(fields, allowed, what) {
  const keys = Object.keys(fields || {});
  for (const k of keys) {
    if (!allowed.has(k)) throw new Error(`voice_handoffs: ${what} cannot write ${JSON.stringify(k)}`);
  }
  return keys;
}

/** The newest card a hand-off created, from its card_given audit row (payload.handoff_id), or null. */
export async function findHandoffCard(db, handoffId) {
  const { rows } = await db.execute({
    sql: `SELECT target FROM project_audit_log
           WHERE action = 'card_given'
             AND (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.handoff_id') END) = ?
           ORDER BY id DESC LIMIT 1`,
    args: [String(handoffId)],
  });
  const m = /^card:(\d+)$/.exec(String(rows[0]?.target ?? ""));
  return m ? Number(m[1]) : null;
}

export function createHandoffStore({ now = Date.now } = {}) {
  async function transition(db, id, fromStatuses, toStatus, fields = {}, { live = false } = {}) {
    assertStatus(toStatus);
    const from = Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses];
    if (!from.length) throw new Error("voice_handoffs: a transition needs at least one from-status");
    from.forEach(assertStatus);
    const keys = columns(fields, TRANSITION_FIELDS, "a transition");
    const t = now();
    const sets = ["status = ?", "updated_at = ?"];
    const args = [toStatus, t];
    if (DECIDED.has(toStatus)) { sets.push("decided_at = ?"); args.push(t); }
    if (ENDED.has(toStatus)) { sets.push("ended_at = ?"); args.push(t); }
    for (const k of keys) { sets.push(`${k} = ?`); args.push(fields[k] ?? null); }
    let sql = `UPDATE voice_handoffs SET ${sets.join(", ")} WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`;
    args.push(String(id), ...from);
    if (live) { sql += " AND expires_at > ?"; args.push(t); }
    const r = await db.execute({ sql, args });
    return r.rowsAffected === 1;
  }

  async function get(db, id) {
    const { rows } = await db.execute({ sql: "SELECT * FROM voice_handoffs WHERE id = ?", args: [String(id)] });
    return rows[0] || null;
  }

  return {
    async insert(db, { kind = "handoff", surface, device_id, device_name = null, bot_id, task, asked = null,
      status, model_key = null, start_now = 1, lang = "en", target_id = null } = {}) {
      if (!HANDOFF_KINDS.includes(kind)) throw new Error(`voice_handoffs: unknown kind ${JSON.stringify(kind)}`);
      assertStatus(status);
      const language = lang == null ? "en" : lang;
      if (!HANDOFF_LANGS.includes(language)) throw new Error(`voice_handoffs: unknown lang ${JSON.stringify(lang)}`);
      for (const [k, v] of Object.entries({ surface, device_id, bot_id, task })) {
        if (v == null || String(v).trim() === "") throw new Error(`voice_handoffs: ${k} is required`);
      }
      const t = now();
      const id = "vh-" + randomBytes(8).toString("hex");
      const expiresAt = status === "proposed" ? t + HANDOFF_PROPOSAL_TTL_MS
        : status === "awaiting_phone" ? t + HANDOFF_PHONE_TTL_MS : null;
      try {
        await db.execute({
          sql: `INSERT INTO voice_handoffs
                  (id, kind, surface, device_id, device_name, bot_id, task, asked, status, target_id, model_key,
                   start_now, lang, created_at, expires_at, decided_at, ended_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [id, kind, String(surface), String(device_id), device_name == null ? null : String(device_name),
            String(bot_id), cap(task, HANDOFF_TASK_MAX_CHARS), cap(asked, HANDOFF_ASKED_MAX_CHARS), status,
            target_id == null ? null : String(target_id), model_key == null ? null : String(model_key),
            start_now === 0 || start_now === false ? 0 : 1, language, t, expiresAt,
            DECIDED.has(status) ? t : null, ENDED.has(status) ? t : null, t],
        });
      } catch (err) {
        if (PHONE_OPEN_RE.test(String(err && err.message))) {
          throw Object.assign(new Error("a phone confirmation is already open for this device"), { code: "phone_open", cause: err });
        }
        throw err;
      }
      return id;
    },

    transition,

    /** Writes session/thread/card/detail on a row whatever its status (a stopped row's spawn landing). */
    async setFields(db, id, fields = {}) {
      const keys = columns(fields, SET_FIELDS, "setFields");
      if (!keys.length) return false;
      const r = await db.execute({
        sql: `UPDATE voice_handoffs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
        args: [...keys.map((k) => fields[k] ?? null), now(), String(id)],
      });
      return r.rowsAffected === 1;
    },

    get,

    async byCard(db, cardId) {
      const { rows } = await db.execute({
        sql: "SELECT * FROM voice_handoffs WHERE card_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        args: [Number(cardId)],
      });
      return rows[0] || null;
    },

    async openForDevice(db, deviceId) {
      const { rows } = await db.execute({
        sql: `SELECT * FROM voice_handoffs WHERE device_id = ? AND status IN (${OPEN_IN}) ORDER BY created_at DESC, rowid DESC`,
        args: [String(deviceId), ...HANDOFF_OPEN],
      });
      return rows;
    },

    async openPersonal(db) {
      const { rows } = await db.execute({
        sql: `SELECT * FROM voice_handoffs WHERE surface != 'kiosk' AND status IN (${OPEN_IN}) ORDER BY created_at DESC, rowid DESC`,
        args: [...HANDOFF_OPEN],
      });
      return rows;
    },

    async recent(db, limit = 20) {
      const n = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 20));
      const { rows } = await db.execute({
        sql: "SELECT * FROM voice_handoffs ORDER BY created_at DESC, rowid DESC LIMIT ?",
        args: [n],
      });
      return rows;
    },

    /** The device's live awaiting_phone row of this kind, or null. A row past its expires_at is moved to
     * expired first, so it never blocks a new one. */
    async openPhone(db, deviceId, kind) {
      const t = now();
      await db.execute({
        sql: `UPDATE voice_handoffs SET status = 'expired', updated_at = ?
               WHERE device_id = ? AND kind = ? AND status = 'awaiting_phone' AND expires_at <= ?`,
        args: [t, String(deviceId), String(kind), t],
      });
      const { rows } = await db.execute({
        sql: "SELECT * FROM voice_handoffs WHERE device_id = ? AND kind = ? AND status = 'awaiting_phone' LIMIT 1",
        args: [String(deviceId), String(kind)],
      });
      return rows[0] || null;
    },

    /**
     * One pass over the log:
     *  - proposed/awaiting_phone rows past expires_at → expired;
     *  - hand-off rows still `starting` HANDOFF_STARTING_STUCK_MS after their yes (decided_at) and not in
     *    `inFlight`: their card (the row's card_id, else `findCard`) → queued "recovered", none → failed
     *    "interrupted";
     *  - stopped rows whose engine.stop failed (detail "stop_pending") → `retryStop(session_id)` again,
     *    clearing the detail once it succeeds (a session already gone counts as stopped);
     *  - stop rows left `starting` over HANDOFF_STOP_STUCK_MS → failed "interrupted";
     *  - declined/expired rows older than HANDOFF_ASKED_RETAIN_MS lose `asked`; the task stays.
     * Every status change is a CAS, so a confirm that lands meanwhile wins.
     */
    async sweep(db, { inFlight = new Set(), findCard = async () => null, retryStop = async () => {} } = {}) {
      const out = { expired: 0, failed: 0, requeued: 0, scrubbed: 0, retried: 0 };
      const t = now();

      out.expired = (await db.execute({
        sql: `UPDATE voice_handoffs SET status = 'expired', updated_at = ?
               WHERE status IN ('proposed', 'awaiting_phone') AND expires_at <= ?`,
        args: [t, t],
      })).rowsAffected;

      const stuck = (await db.execute({
        sql: `SELECT id, kind, card_id FROM voice_handoffs
               WHERE status = 'starting'
                 AND ((kind = 'handoff' AND COALESCE(decided_at, created_at) <= ?)
                   OR (kind = 'stop' AND COALESCE(decided_at, created_at) <= ?))`,
        args: [t - HANDOFF_STARTING_STUCK_MS, t - HANDOFF_STOP_STUCK_MS],
      })).rows;
      for (const row of stuck) {
        if (inFlight.has(row.id)) continue;
        if (row.kind === "handoff") {
          let cardId = row.card_id ?? null;
          if (cardId == null) {
            try { cardId = await findCard(db, row.id); }
            catch (err) { console.error("[handoff-store] sweep findCard failed:", (err && err.message) || err); continue; }
          }
          if (cardId != null) {
            if (await transition(db, row.id, ["starting"], "queued", { card_id: Number(cardId), detail: "recovered" })) out.requeued++;
            continue;
          }
        }
        if (await transition(db, row.id, ["starting"], "failed", { detail: "interrupted" })) out.failed++;
      }

      const pending = (await db.execute({
        sql: `SELECT id, session_id FROM voice_handoffs
               WHERE status = 'stopped' AND detail = 'stop_pending' AND session_id IS NOT NULL`,
        args: [],
      })).rows;
      for (const row of pending) {
        try {
          await retryStop(row.session_id);
        } catch (err) {
          if (!(err && err.code === "no_such_session")) {
            console.error("[handoff-store] sweep stop retry failed:", (err && err.message) || err);
            continue;
          }
        }
        const r = await db.execute({
          sql: "UPDATE voice_handoffs SET detail = NULL, updated_at = ? WHERE id = ? AND status = 'stopped' AND detail = 'stop_pending'",
          args: [now(), row.id],
        });
        out.retried += r.rowsAffected;
      }

      out.scrubbed = (await db.execute({
        sql: `UPDATE voice_handoffs SET asked = NULL, updated_at = ?
               WHERE status IN ('declined', 'expired') AND asked IS NOT NULL AND created_at <= ?`,
        args: [t, t - HANDOFF_ASKED_RETAIN_MS],
      })).rowsAffected;

      return out;
    },
  };
}
