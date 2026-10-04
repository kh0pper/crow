/**
 * Data hygiene — operator-run repairs for local data the product's own
 * delete paths left behind (2026-10-03 weekend-push follow-ups W3 / CONTACT-JUNK).
 *
 * 1. ORPHANED MESSAGES. `messages.contact_id` REFERENCES contacts ON DELETE
 *    CASCADE, but the cascade only fires on a connection with foreign_keys
 *    ON, so older deletes (and pre-FK rows: crow carried 17 rows with
 *    contact_id 0) left DM history pointing at no contact. The product's
 *    semantics for a deleted contact's history is exactly that cascade: the
 *    rows are deleted LOCALLY. Messages are insert-only on the instance-sync
 *    wire (_applyMessage resolves the contact by crow_id and skips when it is
 *    absent), so there is nothing to emit and a peer cannot resurrect them.
 *    message_retry_queue carries the same cascade and is swept with them.
 *
 * 2. JUNK CONTACTS. A filtered bulk delete by display-name pattern that runs
 *    every row through deleteContactLocal — the ONE user-delete path (#155
 *    semantics): unwire, DELETE, emitContactDelete (broadcast + authoritative
 *    tombstone), so paired instances converge instead of re-syncing the rows.
 *
 * Everything here is dry-run by default: the scan/preview functions never
 * write, and the destructive calls require an explicit confirm from the
 * caller (the Settings › Data hygiene section).
 */

import { deleteContactLocal } from "./contact-delete.js";

const ORPHAN_WHERE = "contact_id IS NULL OR contact_id NOT IN (SELECT id FROM contacts)";

async function countOf(db, sql) {
  try {
    const { rows } = await db.execute({ sql, args: [] });
    return Number(rows?.[0]?.n ?? 0);
  } catch {
    return 0; // table missing on an older DB
  }
}

/**
 * Read-only scan. Returns totals plus a per-contact_id breakdown (max 50).
 * @returns {Promise<{messages:number, retryQueue:number, byContact:Array<{contact_id:number|null,n:number,first:string|null,last:string|null}>}>}
 */
export async function scanOrphanedMessages(db) {
  const messages = await countOf(db, `SELECT COUNT(*) AS n FROM messages WHERE ${ORPHAN_WHERE}`);
  const retryQueue = await countOf(db, "SELECT COUNT(*) AS n FROM message_retry_queue WHERE contact_id IS NOT NULL AND contact_id NOT IN (SELECT id FROM contacts)");
  let byContact = [];
  if (messages > 0) {
    try {
      const { rows } = await db.execute({
        sql: `SELECT contact_id, COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last
              FROM messages WHERE ${ORPHAN_WHERE} GROUP BY contact_id ORDER BY n DESC LIMIT 50`,
        args: [],
      });
      byContact = rows.map((r) => ({ contact_id: r.contact_id ?? null, n: Number(r.n), first: r.first ?? null, last: r.last ?? null }));
    } catch { byContact = []; }
  }
  return { messages, retryQueue, byContact };
}

/**
 * Delete orphaned messages (and orphaned retry-queue rows). Dry-run unless
 * `confirm: true`. `expected` (the count the operator was shown) guards
 * against a surprise: if the live count differs, nothing is deleted and the
 * fresh scan is returned so the page can re-show it.
 * @returns {Promise<{dryRun:boolean, refused?:string, scan:object, deleted:{messages:number, retryQueue:number}}>}
 */
export async function purgeOrphanedMessages(db, { confirm = false, expected = null } = {}) {
  const scan = await scanOrphanedMessages(db);
  const deleted = { messages: 0, retryQueue: 0 };
  if (!confirm) return { dryRun: true, scan, deleted };
  if (expected != null && Number(expected) !== scan.messages) {
    return { dryRun: true, refused: "count_changed", scan, deleted };
  }
  const res = await db.batch([
    { sql: `DELETE FROM messages WHERE ${ORPHAN_WHERE}`, args: [] },
    { sql: "DELETE FROM message_retry_queue WHERE contact_id IS NOT NULL AND contact_id NOT IN (SELECT id FROM contacts)", args: [] },
  ], "write");
  deleted.messages = Number(res?.[0]?.rowsAffected ?? 0);
  deleted.retryQueue = Number(res?.[1]?.rowsAffected ?? 0);
  return { dryRun: false, scan, deleted };
}

/**
 * Turn an operator's name pattern into a LIKE pattern. Plain text matches as
 * a case-insensitive substring; `*` is a wildcard. LIKE metacharacters in the
 * input are escaped. Refuses (returns null) a pattern with fewer than 3
 * literal characters, so a stray "*" or "a" can never select every contact.
 */
export function namePatternToLike(pattern) {
  if (typeof pattern !== "string") return null;
  const p = pattern.trim();
  if (p.length > 100) return null;
  const literal = p.replace(/\*/g, "");
  if (literal.replace(/\s/g, "").length < 3) return null;
  const escaped = p.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, "%");
  return p.includes("*") ? escaped : `%${escaped}%`;
}

/**
 * Read-only preview of contacts whose display_name matches the pattern.
 * `local-bot` rows (recreated by this instance at boot, refused by the
 * delete path) are listed separately as `protected`.
 * @returns {Promise<{like:string|null, matches:Array, protected:Array, truncated:boolean}>}
 */
export async function previewContactsByName(db, pattern, { limit = 500 } = {}) {
  const like = namePatternToLike(pattern);
  if (!like) return { like: null, matches: [], protected: [], truncated: false };
  const { rows } = await db.execute({
    sql: `SELECT id, crow_id, display_name, origin, contact_type, is_blocked, lamport_ts, created_at
          FROM contacts WHERE display_name LIKE ? ESCAPE '\\' ORDER BY id LIMIT ?`,
    args: [like, limit + 1],
  });
  const truncated = rows.length > limit;
  const all = rows.slice(0, limit);
  return {
    like,
    matches: all.filter((r) => r.origin !== "local-bot"),
    protected: all.filter((r) => r.origin === "local-bot"),
    truncated,
  };
}

/**
 * Delete the previewed contacts through the product's user-delete path.
 * Every id is RE-CHECKED against the pattern at delete time (a contact
 * renamed since the preview is skipped, never deleted). Requires confirm.
 * @param {object} db
 * @param {object} managers { nostrManager?, syncManager?, peerManager? }
 * @param {{pattern:string, ids:number[], confirm:boolean}} opts
 * @returns {Promise<{ok:boolean, reason?:string, deleted:number, skipped:Array<{id:number, reason:string}>}>}
 */
export async function bulkDeleteContactsByName(db, managers, { pattern, ids, confirm = false } = {}) {
  const like = namePatternToLike(pattern);
  if (!like) return { ok: false, reason: "bad_pattern", deleted: 0, skipped: [] };
  if (!confirm) return { ok: false, reason: "not_confirmed", deleted: 0, skipped: [] };
  const want = [...new Set((ids || []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 500);
  let deleted = 0;
  const skipped = [];
  for (const id of want) {
    const { rows } = await db.execute({
      sql: "SELECT * FROM contacts WHERE id = ? AND display_name LIKE ? ESCAPE '\\'",
      args: [id, like],
    });
    const row = rows[0];
    if (!row) { skipped.push({ id, reason: "gone_or_no_longer_matches" }); continue; }
    try {
      const r = await deleteContactLocal(db, managers || {}, row);
      if (r.ok) deleted++;
      else skipped.push({ id, reason: r.reason });
    } catch (err) {
      skipped.push({ id, reason: `error: ${String(err?.message || err).slice(0, 120)}` });
    }
  }
  return { ok: true, deleted, skipped };
}
