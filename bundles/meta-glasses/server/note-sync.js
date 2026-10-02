/**
 * Cross-instance sync for glasses notes (Phase 6).
 *
 * research_notes and glasses_note_sessions are in SYNCED_TABLES, but until
 * this module the bundle wrote them raw, so nothing replicated (stdio
 * sync-outbox follow-up, spec 2026-08-15 "Scope of the success criterion").
 * Every write now re-reads the row and hands it to the core's emitOrQueue:
 * inside the gateway (panel routes) the live manager passes it straight
 * through; in the stdio MCP process there is no manager, so the write is
 * durably queued in sync_outbox for the gateway's drain.
 *
 * Emit points are deliberate: create, every session state change, the
 * end-of-session summary, explicit edits, and deletes. Per-line dictation
 * appends are NOT emitted one by one (each emit carries the whole note, so
 * a long continuous session would put O(n^2) bytes on every peer's feed);
 * the note is emitted when its session ends, which carries the final text.
 *
 * Never throws: a sync failure must not fail the user's glasses turn.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function resolveGatewayRoot() {
  const candidates = [
    join(import.meta.dirname, "..", "..", ".."),
    join(homedir(), "crow"),
  ];
  for (const root of candidates) {
    if (existsSync(join(root, "servers", "shared", "sync-emit.js"))) return root;
  }
  return null;
}

let modsPromise = null;
function loadMods() {
  modsPromise ??= (async () => {
    const root = resolveGatewayRoot();
    if (!root) throw new Error("Cannot locate Crow root (servers/shared/sync-emit.js)");
    const [emitMod, mgrMod] = await Promise.all([
      import(pathToFileURL(join(root, "servers", "shared", "sync-emit.js")).href),
      import(pathToFileURL(join(root, "servers", "sharing", "managers.js")).href),
    ]);
    return { emitOrQueue: emitMod.emitOrQueue, getInstanceSyncManager: mgrMod.getInstanceSyncManager };
  })().catch((err) => { modsPromise = null; throw err; });
  return modsPromise;
}

const TABLES = new Set(["research_notes", "glasses_note_sessions"]);

let _modsForTest = null;
/** Test seam: inject { emitOrQueue, getInstanceSyncManager }. Pass null to restore. */
export function _setSyncModsForTest(mods) { _modsForTest = mods; }

/**
 * Emit the current state of rows by id.
 * @param {object} db
 * @param {"research_notes"|"glasses_note_sessions"} table
 * @param {Array<number|string|null|undefined>|number|string} ids
 * @param {"insert"|"update"|"delete"} [op]
 */
export async function syncRows(db, table, ids, op = "update") {
  if (!TABLES.has(table)) return;
  const list = (Array.isArray(ids) ? ids : [ids]).filter((v) => v != null && v !== "").map(Number);
  if (!list.length) return;
  try {
    const { emitOrQueue, getInstanceSyncManager } = _modsForTest || await loadMods();
    const mgr = (() => { try { return getInstanceSyncManager(); } catch { return null; } })();
    for (const id of list) {
      if (op === "delete") {
        await emitOrQueue(mgr, db, table, "delete", { id });
        continue;
      }
      const { rows } = await db.execute({ sql: `SELECT * FROM ${table} WHERE id = ?`, args: [id] });
      if (!rows[0]) continue;
      await emitOrQueue(mgr, db, table, op, { ...rows[0] });
    }
  } catch (err) {
    console.warn(`[meta-glasses] note sync skipped (${table}): ${err?.message ?? err}`);
  }
}

/** A session and its backing note, emitted together (session end / summary). */
export async function syncSessionAndNote(db, sessionId) {
  if (sessionId == null) return;
  let noteId = null;
  try {
    const { rows } = await db.execute({ sql: "SELECT note_id FROM glasses_note_sessions WHERE id = ?", args: [Number(sessionId)] });
    noteId = rows[0]?.note_id ?? null;
  } catch {}
  await syncRows(db, "research_notes", noteId);
  await syncRows(db, "glasses_note_sessions", sessionId);
}

/** For edits that may land mid-session (append/undo by session): an active
 *  session's note rides its session-end emit; a closed session's note is
 *  emitted now. */
export async function syncNoteUnlessLive(db, sessionId) {
  if (sessionId == null) return;
  try {
    const { rows } = await db.execute({ sql: "SELECT note_id, status FROM glasses_note_sessions WHERE id = ?", args: [Number(sessionId)] });
    if (!rows[0] || rows[0].status === "active") return;
    await syncRows(db, "research_notes", rows[0].note_id);
  } catch {}
}

/** Same rule keyed by note (caption backfill): emit unless an active
 *  session still owns the note. */
export async function syncNoteIfIdle(db, noteId) {
  if (noteId == null) return;
  try {
    const { rows } = await db.execute({
      sql: "SELECT 1 FROM glasses_note_sessions WHERE note_id = ? AND status = 'active' LIMIT 1",
      args: [Number(noteId)],
    });
    if (rows[0]) return;
    await syncRows(db, "research_notes", noteId);
  } catch {}
}
