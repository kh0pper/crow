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
/**
 * The Ramble tables whose apply is last-writer-wins on the envelope Lamport.
 * Each row records WHICH instance wrote its current Lamport in
 * `lamport_origin`, so an equal-Lamport tie can be broken the same way on
 * every Crow (greater origin id wins; NULL loses; two NULLs keep the old
 * apply-on-tie behaviour). `ramble_cells` / `ramble_wallet` are not here:
 * they merge by MIN/MAX, which is order-independent already.
 */
export const RAMBLE_LWW_TABLES = Object.freeze([
  "ramble_marks", "ramble_settings", "ramble_blocks", "ramble_eggs", "ramble_pet", "ramble_trades",
]);

const _originColumnReady = new WeakMap(); // db -> Set<table>

/**
 * Guarded, additive `lamport_origin TEXT` on one LWW Ramble table (fix round
 * 2, I-2). Core owns it as well as the bundle's init-tables, because core's
 * stamp and apply paths depend on the column and an installed bundle copy may
 * predate it. No SCHEMA_GENERATION bump: existing rows keep NULL, which the
 * tie rule treats as "loses to any stamped write". Memoised per db handle;
 * returns false (and remembers nothing) while the table does not exist yet.
 */
export async function ensureLamportOriginColumn(db, table) {
  if (!RAMBLE_LWW_TABLES.includes(table)) return false;
  let ready = _originColumnReady.get(db);
  if (!ready) { ready = new Set(); _originColumnReady.set(db, ready); }
  if (ready.has(table)) return true;
  try {
    const { rows } = await db.execute(`PRAGMA table_info(${table})`);
    if (rows.length === 0) return false;
    if (!rows.some((r) => r.name === "lamport_origin")) {
      try {
        await db.execute(`ALTER TABLE ${table} ADD COLUMN lamport_origin TEXT`);
      } catch (err) {
        if (!/duplicate column/i.test(String(err?.message))) throw err;
      }
    }
    ready.add(table);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does an incoming op LOSE to the local row? Strictly older loses, strictly
 * newer wins. On an equal Lamport: the greater origin id wins, a NULL origin
 * loses to a non-null one, two NULLs (or the same origin — a re-delivery)
 * keep the old behaviour and apply. Every Crow evaluates the same pair, so a
 * tie converges instead of each side taking the other's write.
 */
export function incomingLosesLww(lamportTs, localTs, incomingOrigin, localOrigin) {
  if (lamportTs < localTs) return true;
  if (lamportTs > localTs) return false;
  const inc = incomingOrigin ?? null;
  const loc = localOrigin ?? null;
  if (inc === null && loc === null) return false;
  if (inc === null) return true;
  if (loc === null) return false;
  return String(inc) < String(loc);
}

export function stampSql(table, row, lamportTs, origin) {
  // For an LWW Ramble table, also record WHO wrote this Lamport — but only
  // when the caller says (emitChange / the queue door pass the local instance
  // id; the outbox cap's NULL re-stamp passes none and leaves it alone). The
  // origin is always the SECOND placeholder, after the lamport, so
  // sync-emit's subselect swap of args[0] still lines up.
  const withOrigin = origin !== undefined && RAMBLE_LWW_TABLES.includes(table);
  const o = withOrigin ? ", lamport_origin = ?" : "";
  const oa = withOrigin ? [origin ?? null] : [];
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
  // Ramble's two id-less natural-key tables (R9). Without these branches they
  // fall through to the generic by-`id` shape, find no `id` column, return null
  // and are never stamped — the outbox row would carry the lamport while the
  // source row kept 0, making the apply side's last-writer-wins one-sided
  // (an incoming remote op would beat a strictly newer local edit forever).
  if (table === "ramble_settings" && row.key !== undefined) {
    return {
      sql: `UPDATE ramble_settings SET lamport_ts = ?${o} WHERE key = ?`,
      args: [lamportTs, ...oa, row.key],
    };
  }
  if (table === "ramble_blocks" && row.persona !== undefined) {
    return {
      sql: `UPDATE ramble_blocks SET lamport_ts = ?${o} WHERE persona = ?`,
      args: [lamportTs, ...oa, row.persona],
    };
  }
  // Same story for the flock tables (Task 6): `ramble_eggs` is keyed on
  // `egg_id` and `ramble_pet` on `owner` (always 'self'); NEITHER has an `id`
  // column, so without these branches the generic shape below returns null and
  // the source row is never stamped while its outbox entry carries the lamport.
  if (table === "ramble_eggs" && row.egg_id !== undefined) {
    return {
      sql: `UPDATE ramble_eggs SET lamport_ts = ?${o} WHERE egg_id = ?`,
      args: [lamportTs, ...oa, row.egg_id],
    };
  }
  if (table === "ramble_pet" && row.owner !== undefined) {
    return {
      sql: `UPDATE ramble_pet SET lamport_ts = ?${o} WHERE owner = ?`,
      args: [lamportTs, ...oa, row.owner],
    };
  }
  // Phase 3: swaps are keyed on trade_id (no `id` column) — same story.
  if (table === "ramble_trades" && row.trade_id !== undefined) {
    return {
      sql: `UPDATE ramble_trades SET lamport_ts = ?${o} WHERE trade_id = ?`,
      args: [lamportTs, ...oa, row.trade_id],
    };
  }
  // Phase 1 of the reward economy: both new tables are id-less natural-key
  // tables (`cell`, and the pair `kind`+`key`), so without these branches the
  // local row would never be stamped while applyRambleCell/applyRambleWallet
  // write a real lamport to remote ones.
  if (table === "ramble_cells" && row.cell !== undefined) {
    return { sql: `UPDATE ramble_cells SET lamport_ts = ? WHERE cell = ?`, args: [lamportTs, row.cell] };
  }
  if (table === "ramble_wallet" && row.kind !== undefined && row.key !== undefined) {
    return { sql: `UPDATE ramble_wallet SET lamport_ts = ? WHERE kind = ? AND key = ?`, args: [lamportTs, row.kind, row.key] };
  }
  if (row.id !== undefined) {
    return {
      sql: `UPDATE ${table} SET lamport_ts = ?${o} WHERE id = ?`,
      args: [lamportTs, ...oa, row.id],
    };
  }
  return null;
}
