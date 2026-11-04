/**
 * Sync Conflict Expiry
 *
 * `sync_conflicts` rows are review-only: the winning side is ALREADY applied
 * when the row is written (instance-sync.js), so an unresolved row that nobody
 * looks at is just noise — one instance accumulated 363 of them, all months
 * old and all already decided by the winner.
 *
 * The operator's ruling: a conflict expires (resolved, winner kept) after N
 * days UNLESS its losing side is newer than the winner, or a person opened it.
 * The Nest health card counts only unexpired conflicts, and the review page
 * offers a "resolve all older than N days" action that ignores both of those
 * guards because a person asked for it explicitly.
 *
 * A second column, `resolved_via`, records WHO decided: 'expired' (this
 * sweep), 'operator' (keep-current / resolve-all) or 'bulk' (resolve-all-
 * older-than-N).
 *
 * "Losing side newer" is a json comparison of `updated_at` on the two stored
 * snapshots, not a Lamport comparison: by construction the winner already has
 * the HIGHER Lamport value (that is how it won), so Lamport order can never
 * say "the loser is newer". A row whose data carries no `updated_at` on either
 * side therefore does NOT count as newer — it can expire. Timestamps are
 * compared as text, which is correct for the ISO-8601 / SQLite `datetime()`
 * forms both sides are stored in.
 *
 * Every query here treats a missing column as "the 0023 migration has not run
 * yet" and degrades instead of throwing, the same way `syncConflictsSignal`
 * treats a missing table.
 */

import { readSetting } from "../gateway/dashboard/settings/registry.js";

/** Days a conflict lives before it expires on its own. */
export const EXPIRE_DAYS_DEFAULT = 7;

/** dashboard_settings key holding the operator's chosen window. */
export const EXPIRE_DAYS_KEY = "sync_conflicts_expire_days";

/** An integer in this range is a valid window; anything else means the default. */
export const EXPIRE_DAYS_MIN = 1;
export const EXPIRE_DAYS_MAX = 365;

// One line per process: a boot before the migration would otherwise log on
// every 6-hour sweep forever.
let _warnedMissingColumns = false;

/** The closed vocabulary of `resolved_via` values. */
export const RESOLVED_VIA = new Set(["expired", "operator", "bulk"]);

/** Test seam: forget the one-shot warning. */
export function _resetExpiryWarningForTest() {
  _warnedMissingColumns = false;
}

/**
 * Coerce a settings/input value to a usable window.
 * @param {unknown} raw
 * @returns {number} an integer 1..365, or EXPIRE_DAYS_DEFAULT
 */
export function normalizeDays(raw) {
  if (raw === null || raw === undefined) return EXPIRE_DAYS_DEFAULT;
  const s = String(raw).trim();
  if (!/^\d{1,3}$/.test(s)) return EXPIRE_DAYS_DEFAULT;
  const n = Number(s);
  if (!Number.isInteger(n) || n < EXPIRE_DAYS_MIN || n > EXPIRE_DAYS_MAX) return EXPIRE_DAYS_DEFAULT;
  return n;
}

/**
 * The configured window, through the same scoped-settings reader every other
 * dashboard_settings consumer uses (per-instance override first, then global).
 * A missing key, an unreadable store or a malformed value all mean the default.
 *
 * @param {object} db
 * @returns {Promise<number>}
 */
export async function readExpireDays(db) {
  try {
    return normalizeDays(await readSetting(db, EXPIRE_DAYS_KEY));
  } catch {
    return EXPIRE_DAYS_DEFAULT;
  }
}

/** SQLite literal for an injected clock, or null to use the database's own now. */
function sqlNow(now) {
  if (now === null || now === undefined) return null;
  const d = now instanceof Date ? now : new Date(typeof now === "number" ? now : String(now));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * "This row is older than N days" as ONE SQL fragment.
 * @param {number} days
 * @param {{now?: Date|number|string|null}} [opts]
 * @returns {{sql: string, args: any[]}}
 */
export function olderThanWhere(days, { now = null } = {}) {
  const d = normalizeDays(days);
  const offset = `-${d} days`;
  const base = sqlNow(now);
  // The IS NOT NULL guard keeps a malformed row (no created_at) from turning
  // the comparison into NULL: such a row is never "older than N days", so it
  // stays visible instead of silently vanishing from the health count.
  const sql = base
    ? "(created_at IS NOT NULL AND datetime(created_at) < datetime(?, ?))"
    : "(created_at IS NOT NULL AND datetime(created_at) < datetime('now', ?))";
  return { sql, args: base ? [base, offset] : [offset] };
}

// A loser is "newer" only when BOTH snapshots carry updated_at and the loser's
// is the later one. Missing on either side ⇒ not newer (see the header), and
// the explicit IS NOT NULL guards keep a NULL comparison from turning the whole
// predicate into NULL and silently excluding the row.
const NEWER_LOSER = `(
    json_extract(losing_data, '$.updated_at') IS NOT NULL
    AND json_extract(winning_data, '$.updated_at') IS NOT NULL
    AND json_extract(losing_data, '$.updated_at') > json_extract(winning_data, '$.updated_at')
  )`;

/**
 * The shared predicate for "this conflict may expire on its own": unresolved,
 * older than `days`, never opened, and its loser is not newer than the winner.
 * Used by BOTH the sweep and the health count so the card and the sweep can
 * never disagree about what is still owed a look.
 *
 * @param {number} days
 * @param {{now?: Date|number|string|null}} [opts]
 * @returns {{sql: string, args: any[]}}
 */
export function expirableWhere(days, { now = null } = {}) {
  const older = olderThanWhere(days, { now });
  return {
    sql: `(resolved = 0
      AND ${older.sql}
      AND opened_at IS NULL
      AND NOT ${NEWER_LOSER})`,
    args: older.args,
  };
}

/** @returns {Set<string>} the column names sync_conflicts actually has right now. */
export async function expiryColumns(db) {
  try {
    const { rows } = await db.execute({ sql: "PRAGMA table_info(sync_conflicts)", args: [] });
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set(); // no better-sqlite3-style PRAGMA on this client / no table
  }
}

function warnMissingColumnsOnce() {
  if (_warnedMissingColumns) return;
  _warnedMissingColumns = true;
  console.warn(
    "[sync] sync_conflicts has no expiry columns yet (migration 0023 not applied) — conflict expiry skipped",
  );
}

function affected(res) {
  return Number(res?.rowsAffected ?? 0);
}

/**
 * Expire every conflict that qualifies: mark it resolved (winner kept, no data
 * restored, neither snapshot rewritten) and record that the sweep decided it.
 *
 * Never throws on a store that predates migration 0023 — it logs once and
 * reports 0, so a boot-time sweep on an un-migrated instance is a no-op.
 *
 * @param {object} db
 * @param {{days?: number, now?: Date|number|string|null}} [opts]
 * @returns {Promise<number>} rows expired
 */
export async function expireOldConflicts(db, { days, now = null } = {}) {
  const cols = await expiryColumns(db);
  if (!cols.has("opened_at") || !cols.has("resolved_via")) {
    warnMissingColumnsOnce();
    return 0;
  }
  const { sql: where, args } = expirableWhere(days, { now });
  // resolved_at stays the database's own clock: the row was expired now, even
  // when a caller injects a clock to test the window.
  const res = await db.execute({
    sql: `UPDATE sync_conflicts
             SET resolved = 1, resolved_at = datetime('now'), resolved_via = 'expired'
           WHERE ${where}`,
    args,
  });
  return affected(res);
}

/**
 * "Resolve all older than N days" — the review page's explicit bulk action.
 * It resolves EVERY unresolved row past the cutoff, including opened rows and
 * rows whose loser looks newer, because a person asked for exactly that. The
 * winner is kept and nothing is restored.
 *
 * @param {object} db
 * @param {{days?: number, now?: Date|number|string|null, resolvedVia?: string}} [opts]
 * @returns {Promise<number>} rows resolved
 */
export async function resolveOlderConflicts(db, { days, now = null, resolvedVia = "bulk" } = {}) {
  const cols = await expiryColumns(db);
  if (!cols.has("resolved")) return 0; // no table at all: nothing to resolve
  const { sql: older, args } = olderThanWhere(days, { now });
  // Whitelisted, never interpolated raw: resolved_via is a closed vocabulary.
  const viaValue = RESOLVED_VIA.has(resolvedVia) ? resolvedVia : "bulk";
  const via = cols.has("resolved_via") ? `, resolved_via = '${viaValue}'` : "";
  const res = await db.execute({
    sql: `UPDATE sync_conflicts
             SET resolved = 1, resolved_at = datetime('now')${via}
           WHERE resolved = 0 AND ${older}`,
    args,
  });
  return affected(res);
}

/**
 * Record a person's decision on ONE row ('operator' for keep-current and
 * resolve-all). A no-op on a store that predates the column.
 *
 * @param {object} db
 * @param {number|string} conflictId
 * @param {"operator"|"bulk"|"expired"} via
 * @returns {Promise<boolean>} true when the column existed and was written
 */
export async function markResolvedVia(db, conflictId, via) {
  const cols = await expiryColumns(db);
  if (!cols.has("resolved_via")) return false;
  await db.execute({
    sql: "UPDATE sync_conflicts SET resolved_via = ? WHERE id = ?",
    args: [via, String(conflictId)],
  });
  return true;
}

/**
 * Record that a person opened this conflict on the review page. Only the first
 * look counts (opened_at IS NULL) and only on an unresolved row — reopening a
 * decided conflict is not evidence it needs another look.
 *
 * @param {object} db
 * @param {number|string} conflictId
 * @returns {Promise<boolean>} true when opened_at exists and the row matched
 */
export async function markOpened(db, conflictId) {
  const cols = await expiryColumns(db);
  if (!cols.has("opened_at")) return false;
  const res = await db.execute({
    sql: `UPDATE sync_conflicts
             SET opened_at = datetime('now')
           WHERE id = ? AND resolved = 0 AND opened_at IS NULL`,
    args: [String(conflictId)],
  });
  return affected(res) > 0;
}