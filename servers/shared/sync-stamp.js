/**
 * Shared stamping module — sync_state / sync_outbox DDL, Lamport minting,
 * and the per-table row-stamp statement. Extracted from
 * servers/sharing/instance-sync.js (_ensureCounter/_nextLamport/
 * _advanceCounter and the emitChange row-stamp block) so a second door
 * into the db (the stdio-mounted MCP process, which has no live
 * InstanceSyncManager) can mint the same monotonic Lamport series and
 * stamp rows the same way — see docs/superpowers/specs/2026-08-15-
 * stdio-sync-outbox-design.md, "The shared emitter module".
 *
 * `mintLamport`/`advanceCounter` are the ONLY writers of sync_state.local_counter
 * outside this module; instance-sync.js's _nextLamport/_advanceCounter delegate
 * here so both doors share one source of truth. `seedCounterSql`/`bumpCounterSql`
 * are exported as standalone {sql, args} builders — not because this module
 * needs them split out (mintLamport calls them directly), but because Task 2's
 * emitOrQueue must compose ONE atomic db.batch() covering [seed, counter bump,
 * row-stamp, outbox INSERT] and needs the exact same statements this module
 * uses, not a re-derived copy.
 */

/** sync_outbox DDL — spec-verbatim. NOT in init-db.js/SCHEMA_GENERATION: a
 *  bundle-init pattern so a standalone stdio process that never runs
 *  init-db.js can still create it. */
const SYNC_OUTBOX_DDL = `
  CREATE TABLE IF NOT EXISTS sync_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,   -- drain order = local write order
    table_name TEXT NOT NULL,
    op TEXT NOT NULL,                        -- 'insert'|'update'|'delete'
    row_json TEXT NOT NULL,                  -- the row snapshot as the emit site built it
    lamport_ts INTEGER NOT NULL,             -- minted at write time (see above)
    delivered_json TEXT NOT NULL DEFAULT '{}', -- {peerId: true} per real append (see drain)
    claimed_at TEXT,                         -- drain batch claim (see below)
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

/** sync_state DDL — verbatim copy of scripts/init-db.js's table (~:1667-1674).
 *  Duplicated here (not imported) for the same fresh-stdio-instance reason:
 *  today only init-db.js creates it, so a standalone stdio mint against a db
 *  that has never run init-db.js would silently fail without this. */
const SYNC_STATE_DDL = `
  CREATE TABLE IF NOT EXISTS sync_state (
    instance_id TEXT PRIMARY KEY,
    local_counter INTEGER DEFAULT 0,
    last_applied_seq_per_peer TEXT DEFAULT '{}',
    updated_at TEXT DEFAULT (datetime('now'))
  );
`;

/**
 * Idempotent: CREATE TABLE IF NOT EXISTS for both sync_state and sync_outbox.
 * Not marked `async` — forwards the db client's own promise so callers can
 * still `await ensureSyncTables(db)`.
 * @param {ReturnType<import("../db.js").createDbClient>} db
 */
export function ensureSyncTables(db) {
  return db.executeMultiple(SYNC_STATE_DDL + SYNC_OUTBOX_DDL);
}

/**
 * Build the INSERT OR IGNORE seed statement for a sync_state row. Safe to
 * run unconditionally and repeatedly — concurrent first-callers race this
 * atomically (whichever INSERT wins, the others silently no-op).
 * @param {string} instanceId
 * @returns {{sql: string, args: any[]}}
 */
export function seedCounterSql(instanceId) {
  return {
    sql: "INSERT OR IGNORE INTO sync_state (instance_id, local_counter) VALUES (?, 0)",
    args: [instanceId],
  };
}

/**
 * Build the atomic increment-and-return statement. A single
 * `UPDATE ... RETURNING` — better-sqlite3 executes each statement
 * synchronously, so no two concurrent callers can observe/increment the
 * same value (each caller's UPDATE fully completes before the next one
 * starts, even when interleaved across JS microtask boundaries).
 * @param {string} instanceId
 * @returns {{sql: string, args: any[]}}
 */
export function bumpCounterSql(instanceId) {
  return {
    sql: `UPDATE sync_state SET local_counter = local_counter + 1, updated_at = datetime('now')
          WHERE instance_id = ? RETURNING local_counter`,
    args: [instanceId],
  };
}

/**
 * Build the MAX-floor statement used to advance (never regress) the counter
 * past an incoming Lamport value. MAX(...) — not a plain SET — is the whole
 * point: a floor below the current counter must be a no-op.
 * @param {string} instanceId
 * @param {number} floorValue
 * @returns {{sql: string, args: any[]}}
 */
export function floorCounterSql(instanceId, floorValue) {
  return {
    sql: `UPDATE sync_state SET local_counter = MAX(local_counter, CAST(? AS INTEGER) + 1), updated_at = datetime('now')
          WHERE instance_id = ?`,
    args: [Number(floorValue) || 0, instanceId],
  };
}

/**
 * Atomically mint the next Lamport value for instanceId. Seeds the
 * sync_state row first (INSERT OR IGNORE — cheap, idempotent, safe to run
 * on every call) so a fresh install's first mint UPDATEs a real row instead
 * of matching zero rows and NULLing the caller's queue INSERT.
 *
 * sync_state is KEYED by instance_id (scripts/init-db.js ~:1667) — this
 * takes instanceId explicitly rather than assuming a single local row,
 * because tests (and the real fleet) run multiple instance managers against
 * one db file, each with its own row.
 *
 * @param {ReturnType<import("../db.js").createDbClient>} db
 * @param {string} instanceId
 * @returns {Promise<number>} the newly-minted counter value
 */
export async function mintLamport(db, instanceId) {
  await db.execute(seedCounterSql(instanceId));
  const { rows } = await db.execute(bumpCounterSql(instanceId));
  if (!rows[0]) {
    throw new Error(
      `[sync-stamp] sync_state row missing for instance ${instanceId} after seed — DB unavailable?`,
    );
  }
  return Number(rows[0].local_counter);
}

/**
 * Advance the local counter so it is greater than an incoming Lamport
 * value, without regressing it if it's already ahead (MAX-floor).
 * @param {ReturnType<import("../db.js").createDbClient>} db
 * @param {string} instanceId
 * @param {number} floorValue - Lamport timestamp to floor at (e.g. from a remote entry)
 */
export async function advanceCounter(db, instanceId, floorValue) {
  await db.execute(seedCounterSql(instanceId));
  await db.execute(floorCounterSql(instanceId, floorValue));
}

/**
 * Build the per-table row-stamp statement for a fresh Lamport value.
 * Table-specific rules (identical to the historical emitChange block):
 *   - dashboard_settings: stamped by `key`
 *   - crow_context: stamped by composite (section_key, device_id, project_id),
 *     using MAX(COALESCE(lamport_ts, 0), ?) to guard against out-of-order
 *     concurrent stamps (plain MAX(NULL, x) is NULL in SQLite)
 *   - everything else: stamped by `id`, if present
 * Returns null when the row doesn't match any known shape — in particular
 * deletes, whose row payloads (e.g. `{ crow_id }`, `{ group_uid }`) never
 * carry `key`/`section_key`/`id`. Callers must still gate on op !== "delete"
 * themselves (this function has no op parameter — it only reflects row shape).
 *
 * @param {string} table
 * @param {object} row
 * @param {number} lamportTs
 * @returns {{sql: string, args: any[]} | null}
 */
export function stampSql(table, row, lamportTs) {
  if (table === "dashboard_settings" && row.key !== undefined) {
    return {
      sql: `UPDATE dashboard_settings SET lamport_ts = ? WHERE key = ?`,
      args: [lamportTs, row.key],
    };
  }
  if (table === "crow_context" && row.section_key !== undefined) {
    return {
      sql: `UPDATE crow_context SET lamport_ts = MAX(COALESCE(lamport_ts, 0), ?)
            WHERE section_key = ? AND device_id IS ? AND project_id IS ?`,
      args: [lamportTs, row.section_key, row.device_id ?? null, row.project_id ?? null],
    };
  }
  if (row.id !== undefined) {
    return {
      sql: `UPDATE ${table} SET lamport_ts = ? WHERE id = ?`,
      args: [lamportTs, row.id],
    };
  }
  return null;
}
