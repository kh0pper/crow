/**
 * `emitOrQueue` — the single door every server-side write goes through to
 * reach cross-instance sync. Extracted so a process with no live
 * `InstanceSyncManager` (the stdio-mounted MCP server has none) can still
 * durably queue the write for the feeds-owning gateway's drain to deliver
 * later, instead of the write silently vanishing (today's defect). See
 * docs/superpowers/specs/2026-08-15-stdio-sync-outbox-design.md, "The
 * shared emitter module".
 *
 * Call sites that HAVE a live manager keep calling it — `emitOrQueue` is a
 * drop-in wrapper: pass-through when the manager is live, queue when it
 * isn't (missing OR feeds-disabled — a `--no-auth` companion's manager
 * still exists but must never be treated as live, spec round-2 finding).
 */

import { getOrCreateLocalInstanceId } from "../gateway/instance-registry.js";
import { readSetting } from "../gateway/dashboard/settings/registry.js";
import { SYNCED_TABLES, shouldSyncRow, shouldInitInstanceSync } from "../sharing/instance-sync.js";
import { ensureSyncTables, seedCounterSql, bumpCounterSql, stampSql } from "./sync-stamp.js";

/** Spec-verbatim: outbox depth should never reach this on a healthy instance. */
const OUTBOX_CAP = 10000;

/* ------------------------------------------------------------------ seams */

let _eligibilityImpl = null;
/**
 * Test-only: override the eligibility gate wholesale (bypasses both the
 * db-persisted `sync_deployment_enabled` setting and the process-env
 * fallback). The suite runs with `CROW_DISABLE_INSTANCE_SYNC=1` set — real
 * queue-path tests are otherwise unreachable and would be vacuous. Pass
 * `null` to restore the real gate.
 * @param {((db: object) => boolean|Promise<boolean>) | null} fn
 */
export function _setEligibilityForTest(fn) {
  _eligibilityImpl = fn;
}

/**
 * The eligibility gate: a db-persisted deployment setting, NOT process env
 * (round-2 finding — the process running this code and the process that
 * decided whether feeds are disabled routinely disagree; see the spec).
 * '0' → ineligible. Unset (never written by a boot path yet, or a fresh
 * install) → fall back to the same process/env predicate the manager itself
 * uses. Any other value (e.g. '1') → eligible.
 * @param {object} db
 * @returns {Promise<boolean>}
 */
async function isDeploymentEligible(db) {
  if (_eligibilityImpl) return !!(await _eligibilityImpl(db));
  const setting = await readSetting(db, "sync_deployment_enabled");
  if (setting === "0") return false;
  if (setting === null || setting === undefined) {
    return shouldInitInstanceSync({ argv: process.argv, env: process.env });
  }
  return true;
}

/* ------------------------------------------------------------- statement builders */

/**
 * Build the row-stamp UPDATE with the lamport value read via a subselect
 * against `sync_state.local_counter` — NOT a JS-known literal — so it can
 * ride in the same atomic `db.batch()` as the counter increment and read
 * the value that increment just committed (same transaction, same
 * connection: better-sqlite3's synchronous single-writer semantics make
 * this safe without a second round trip).
 *
 * Reuses `stampSql` (Task 1) for the table-specific shape (dashboard_settings
 * by key / crow_context by composite key / else by id) rather than
 * re-deriving those rules here. Every shape `stampSql` returns puts the
 * lamport value as `args[0]` — the FIRST `?` in the generated SQL — so
 * swapping that one placeholder for the subselect (and re-homing args[0] to
 * the subselect's own bound `instance_id`) is safe.
 *
 * @param {string} table
 * @param {object} row
 * @param {string} instanceId
 * @returns {{sql: string, args: any[]} | null}
 */
function subselectStampSql(table, row, instanceId) {
  const probe = stampSql(table, row, 0); // 0: shape-detection placeholder only, never bound
  if (!probe) return null;
  const qIdx = probe.sql.indexOf("?");
  const sql =
    probe.sql.slice(0, qIdx) +
    "(SELECT local_counter FROM sync_state WHERE instance_id = ?)" +
    probe.sql.slice(qIdx + 1);
  return { sql, args: [instanceId, ...probe.args.slice(1)] };
}

/** The outbox INSERT — lamport also via subselect, for the same reason. */
function outboxInsertSql(table, op, row, instanceId) {
  return {
    sql: `INSERT INTO sync_outbox (table_name, op, row_json, lamport_ts)
          VALUES (?, ?, ?, (SELECT local_counter FROM sync_state WHERE instance_id = ?))`,
    args: [table, op, JSON.stringify(row), instanceId],
  };
}

/**
 * Cap enforcement: run BEFORE the new row's insert. At >= OUTBOX_CAP rows,
 * delete the single oldest queued row and NULL its source row's lamport_ts
 * (via `stampSql`'s own null-safety — passing `null` as lamportTs sets the
 * column to NULL directly for the by-key/by-id shapes, and the crow_context
 * shape's `MAX(COALESCE(lamport_ts, 0), ?)` is documented to collapse to
 * NULL when the incoming value is NULL). A stamped-but-cap-dropped row would
 * otherwise be invisible to the documented NULL-lamport repair rail while
 * still armed to locally reject a peer's later, lower-lamport edit it never
 * saw — worse than never having stamped it.
 * @param {object} db
 */
async function enforceOutboxCap(db) {
  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM sync_outbox");
  const count = Number(rows[0]?.n ?? 0);
  if (count < OUTBOX_CAP) return;

  const { rows: oldestRows } = await db.execute(
    "SELECT id, table_name, row_json FROM sync_outbox ORDER BY id ASC LIMIT 1",
  );
  const victim = oldestRows[0];
  if (!victim) return;

  await db.execute({ sql: "DELETE FROM sync_outbox WHERE id = ?", args: [victim.id] });

  let sourceRow = null;
  try {
    sourceRow = JSON.parse(victim.row_json);
  } catch {
    sourceRow = null;
  }
  if (sourceRow) {
    const nullStmt = stampSql(victim.table_name, sourceRow, null);
    if (nullStmt) await db.execute(nullStmt);
  }

  console.warn(
    `[sync-emit] sync_outbox cap (${OUTBOX_CAP}) reached — dropped oldest queued row ` +
      `id=${victim.id} table=${victim.table_name}`,
  );
}

/* --------------------------------------------------------------------- main */

/**
 * Emit a sync change through a live manager, or durably queue it when there
 * isn't one. Never throws — internal try/catch, `console.warn`, return
 * `null` on failure (today's emit-site contract).
 *
 * @param {object|null} syncManager - an InstanceSyncManager, or null/undefined
 * @param {object} db - db client (used only on the queue path)
 * @param {string} table
 * @param {"insert"|"update"|"delete"} op
 * @param {object} row
 * @param {object} [opts]
 * @returns {Promise<number|null|{queued: true, lamport: number}>}
 */
export async function emitOrQueue(syncManager, db, table, op, row, opts = {}) {
  try {
    // A feeds-disabled manager (the --no-auth companion) COUNTS AS NO
    // MANAGER: its own emitChange short-circuits to null (feedsDisabled
    // check), and pass-through there would silently drop where the spec
    // requires QUEUE instead.
    if (syncManager && syncManager.feedsDisabled === false) {
      return await syncManager.emitChange(table, op, row, opts);
    }

    // The queue door. Syncability parity FIRST: a row the live path would
    // filter must never be queued (the drain's own emit would return the
    // same not-syncable null for it, leaving no delivery marks — the row
    // wedges claimed/reclaimed forever and eventually cap-evicts real rows).
    if (!SYNCED_TABLES.includes(table)) return null;
    if (!shouldSyncRow(table, row)) return null;

    const eligible = await isDeploymentEligible(db);
    if (!eligible) return null;

    await ensureSyncTables(db);
    const instanceId = getOrCreateLocalInstanceId();

    await enforceOutboxCap(db);

    // ONE atomic batch: seed, counter bump, row-stamp (skipped on delete or
    // when the row's shape doesn't match), outbox INSERT. A stamp failure
    // here is fatal to the whole batch by design — do NOT wrap these
    // statements individually, that reopens the crash window the spec calls
    // out (stamped-but-never-queued).
    const statements = [seedCounterSql(instanceId)];
    const bumpIdx = statements.push(bumpCounterSql(instanceId)) - 1;
    if (op !== "delete") {
      const stampStmt = subselectStampSql(table, row, instanceId);
      if (stampStmt) statements.push(stampStmt);
    }
    statements.push(outboxInsertSql(table, op, row, instanceId));

    const results = await db.batch(statements);
    const lamport = Number(results[bumpIdx]?.rows?.[0]?.local_counter);
    if (!Number.isFinite(lamport)) {
      throw new Error("emitOrQueue: batch did not return the incremented counter");
    }
    return { queued: true, lamport };
  } catch (err) {
    console.warn("[sync-emit] emitOrQueue failed:", err?.message ?? err);
    return null;
  }
}
