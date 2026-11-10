/**
 * erase.js — the one door through which version history is destroyed.
 *
 * item_versions is append-only by trigger (covered.js). The single legal way to
 * remove rows is the erase control table: arm `item_versions_erase`, do the
 * deletes, disarm — all INSIDE ONE transaction, so no other connection ever sees
 * the switch on (in WAL an uncommitted change is invisible to them) and a
 * failure leaves the door shut rather than open.
 *
 * Three local callers, and no others:
 *   - the operator emptying the Trash / a Trash item ageing out (trash.js, sweep.js);
 *   - a permanent delete that must forget at once (the operator's ruling,
 *     2026-11-10): Maker Lab's learner delete and the project purge, so a
 *     right-to-be-forgotten promise is not held hostage to a 30-day Trash;
 *   - a test.
 *
 * Plus ONE remote caller: applyRemoteErasure() below is what instance-sync runs
 * when a paired instance's erase event arrives (`op: "erase"`). It is the same
 * armed door (arm → deletes → disarm, one transaction) as the local shapes, so
 * "a peer told us to forget this" cannot become a second, weaker way in.
 *
 * WHO MAY ERASE: `owner` or `system` only. Not `bot` — a bot can never rewrite
 * or erase history (the version history design §4) — and not `peer`: history is
 * local-only, so a paired machine has nothing to say about what this one keeps.
 * `unattributed` is the absence of an author, not a permission.
 *
 * PLAINLY (the same caveat as the guard in covered.js): this is the audited
 * door inside the app, not a security boundary. Any process with a write handle
 * on crow.db can arm the switch itself. Containment is what closes that gap; the
 * point of this module is that Crow's own code has exactly one way to do it, and
 * that way is scoped, deliberate and transactional.
 *
 * TWO SHAPES:
 *   eraseItems(db, [{itemType, itemId}], ctx[, {deletedBefore}])
 *                                               the caller names the items (a
 *                                               learner's memories, one Trash
 *                                               item, the integer rows a purge
 *                                               deleted). `deletedBefore` makes
 *                                               the delete conditional on the
 *                                               item still being in the Trash at
 *                                               that age, which is what keeps a
 *                                               restore that lands between the
 *                                               listing and the erase alive;
 *   eraseByProject(db, {projectUuid, projectId}, ctx)
 *                                               project-wide, CLOSED OVER THE
 *                                               ITEM — see the closure note in
 *                                               covered.js: every version of
 *                                               every item that has ANY version
 *                                               under the project, but ONLY for
 *                                               items whose latest version is a
 *                                               delete. A memory the purge merely
 *                                               UNFILED still exists, so its
 *                                               history is not a project delete's
 *                                               to take.
 *
 * Both match project_ref as TEXT with both keys bound: project_ref holds the
 * portable uuid when the row had one and the local project id otherwise, so a
 * project is found by either (see covered.js's projectRef and projectRefExpr).
 *
 * AN ERASE LEAVES A TOMBSTONE (the operator's ruling, 2026-11-10). Erasing the
 * version rows deletes the only record that the item ever existed, which let a
 * paired instance that still held its own copy re-create it here on the next
 * sync (a Trash restore on the peer IS an insert). So every erase also writes a
 * row into item_erasures — in the SAME armed transaction, so "the versions are
 * gone" and "the item may never come back" commit together — and:
 *
 *   - a tombstoned item is refused by a local restore (api.js's restoreVersion
 *     and trash.js's restoreFromTrash, code 'erased'), and
 *   - instance-sync refuses an insert/update for a tombstoned item, on either
 *     instance (see ERASURE_SYNC_TABLES / applyRemoteErasure below).
 *
 * Tombstones are never purged: forgetting one would reopen exactly the door it
 * exists to shut. See the tombstones section below for the key shapes.
 */
import { withoutWriteContext } from "./write-context.js";
import { readLocalInstanceIdOrNull } from "../crow-home.js";

/** The author kinds an erase may run as. Anything else is refused, loudly. */
export const ERASE_ACTOR_KINDS = Object.freeze(["owner", "system"]);

/** How many items one erase statement batch may name (a bound, not a policy). */
const MAX_ITEMS = 1000;

/** The table the tombstones live in. Never purged (see the module comment). */
export const ITEM_ERASURES_TABLE = "item_erasures";

/**
 * The tombstone table: one row per (item_type, item_id) that must never exist
 * again on this instance. `item_id` is the item's ERASURE KEY, not necessarily
 * the id item_versions stores — see erasureKeys(). `erased_by` is
 * `<authorKind>[:<authorId>]` and `origin_instance` is the instance that
 * performed the erase this row was learned from (this one, or a peer's, which is
 * what makes "never re-create it" fleet-wide rather than local).
 *
 * Created by migration 0024 as well; both are `IF NOT EXISTS` so a store that
 * ran either the migration or the boot ensure has it, and a store that ran
 * neither is repaired by ensure.js / ensureErasuresTable().
 */
export const ITEM_ERASURES_DDL = `
  CREATE TABLE IF NOT EXISTS ${ITEM_ERASURES_TABLE} (
    item_type TEXT NOT NULL,
    item_id TEXT NOT NULL,
    erased_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    erased_by TEXT,
    origin_instance TEXT,
    PRIMARY KEY (item_type, item_id)
  );`;

/**
 * The synced tables whose erasures PROPAGATE, and the covered item_type each one
 * versions. blog_posts is absent on purpose: it is not in instance-sync's
 * SYNCED_TABLES, so a blog post never rides a peer's feed and there is nothing
 * there to refuse.
 *
 * WHY AN `erase` OP ON THE ITEM'S OWN TABLE (and not a dedicated synced
 * `item_erasure` entity): an entry already carries (table, op, row), is signed
 * whole and is bound to the feed it arrives on, so an op is the smallest fit —
 * a new synced table would need its own entry in SYNCED_TABLES, its own
 * shouldSyncRow/NATURAL_KEY_TABLES/DELETE_KEY_POLICY entries and its own
 * natural-key apply handler, i.e. four more places to keep in step for what is
 * one signed instruction. The cost is the op itself: instance-sync gains one
 * branch (`op === "erase"`) and the erase never stamps a local row (nothing is
 * left to stamp). An un-upgraded peer reads an op it does not know and applies
 * nothing — the entry is consumed, which is the harmless direction.
 */
export const ERASURE_SYNC_TABLES = Object.freeze({
  memories: "memory",
  crow_context: "context_section",
});

/** The covered item_type whose erasures ride `table`, or null. */
export function erasureItemType(table) {
  return typeof table === "string" && Object.hasOwn(ERASURE_SYNC_TABLES, table) ? ERASURE_SYNC_TABLES[table] : null;
}

/** The synced table an item_type's erasures ride, or null. */
export function erasureSyncTable(itemType) {
  const table = Object.keys(ERASURE_SYNC_TABLES).find((t) => ERASURE_SYNC_TABLES[t] === itemType);
  return table ?? null;
}

function eraseError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const str = (v) => {
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" ? null : s;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
};

/**
 * Refuse anyone but the owner's password session or Crow itself.
 *
 * @param {{authorKind?: string, authorId?: string}|null} ctx
 * @returns {{authorKind: string, authorId: string|null}} the actor, normalized
 */
export function assertEraseActor(ctx) {
  const kind = ctx && typeof ctx === "object" && !Array.isArray(ctx) ? str(ctx.authorKind) : null;
  if (!kind || !ERASE_ACTOR_KINDS.includes(kind)) {
    throw eraseError(
      "forbidden",
      "erasing history is the owner's or the system's to do (authorKind owner or system)",
    );
  }
  return { authorKind: kind, authorId: str(ctx.authorId) };
}

/**
 * The items to erase, deduped and validated. A malformed entry is an error, not
 * a silent skip: every caller of this module is doing something irreversible, so
 * "I could not understand what you asked me to forget" must never look like
 * success.
 */
function normalizeItems(items) {
  if (!Array.isArray(items)) throw eraseError("invalid_request", "eraseItems needs an array of {itemType, itemId}");
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") throw eraseError("invalid_request", "each item needs {itemType, itemId}");
    const itemType = str(raw.itemType);
    const itemId = str(raw.itemId);
    if (itemType === null || itemId === null) {
      throw eraseError("invalid_request", "each item needs a non-empty itemType and itemId");
    }
    const key = `${itemType}\u0000${itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ itemType, itemId });
  }
  if (out.length > MAX_ITEMS) {
    throw eraseError("invalid_request", `an erase names at most ${MAX_ITEMS} items`);
  }
  return out;
}

/** The project keys to match, as TEXT (a bare integer never equals a stored text). */
function projectRefs({ projectUuid, projectId } = {}) {
  const refs = [];
  for (const value of [projectUuid, projectId]) {
    const ref = str(value);
    if (ref !== null && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

/**
 * Are the history tables installed? A store that has not run migration 0024 has
 * no history to erase — that is an empty set, not a failure. (It also keeps a
 * permanent project delete on an older store from reporting a bogus partial
 * "history-erase" step forever.)
 *
 * ONE table without the other is a broken store, not a pre-history one: there
 * ARE versions, and no switch through which to erase them. That fails closed
 * rather than returning an empty result.
 */
async function historyInstalled(db) {
  const { rows } = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('item_versions', 'item_versions_erase')",
    args: [],
  });
  const names = new Set(rows.map((row) => row.name));
  if (!names.has("item_versions")) return false;
  if (!names.has("item_versions_erase")) {
    throw eraseError("unavailable", "the history erase switch table is missing, so history cannot be erased safely");
  }
  return true;
}

/**
 * Run `statements` with the erase switch armed, as ONE transaction.
 *
 * The production client is better-sqlite3 behind servers/db.js, whose `batch()`
 * wraps every statement in one synchronous transaction (the first statement is
 * the arm UPDATE, so the write lock is taken before anything else can run). Using it here
 * (rather than awaits on individual `execute()` calls) is the point: nothing can
 * interleave between arm, the deletes/updates and disarm, and a failure rolls
 * the whole thing back — arm included — so the door is shut without a second,
 * out-of-transaction disarm.
 *
 * A shim with only `execute` (tests, a future client) gets a best-effort
 * fallback that opens its own transaction. Its catch only disarms when this
 * helper actually opened that transaction (M2); a BEGIN that failed armed
 * nothing.
 *
 * @param {object} db libsql-shaped client (servers/db.js)
 * @param {Array<{sql: string, args?: any[]}>} statements
 * @returns {Promise<Array<object>>} the results of `statements` (arm/disarm excluded)
 */
export async function runArmedStatements(db, statements) {
  if (!Array.isArray(statements)) throw eraseError("invalid_request", "runArmedStatements needs an array of statements");
  const armed = [
    { sql: "UPDATE item_versions_erase SET armed = 1", args: [] },
    ...statements,
    { sql: "UPDATE item_versions_erase SET armed = 0", args: [] },
  ];
  if (typeof db.batch === "function") {
    const results = await db.batch(armed);
    return results.slice(1, -1);
  }
  return runArmedFallback(db, statements);
}

/** Sequential fallback for a client without `batch()`; see runArmedStatements. */
async function runArmedFallback(db, statements) {
  let began = false;
  try {
    await db.execute("BEGIN IMMEDIATE");
    began = true;
    await db.execute({ sql: "UPDATE item_versions_erase SET armed = 1", args: [] });
    const out = [];
    for (const statement of statements) out.push(await db.execute(statement));
    await db.execute({ sql: "UPDATE item_versions_erase SET armed = 0", args: [] });
    await db.execute("COMMIT");
    return out;
  } catch (err) {
    if (began) {
      try {
        await db.execute("ROLLBACK");
      } catch {
        // The rollback itself failed: try to shut the door explicitly. This is
        // the one case where an out-of-transaction disarm is warranted — this
        // helper did begin the transaction, so an arm may be sitting in it.
        try {
          await db.execute({ sql: "UPDATE item_versions_erase SET armed = 0", args: [] });
        } catch {
          /* unreadable store: the boot ensure disarms a stuck switch */
        }
      }
    }
    throw err;
  }
}

/** The unconditional "every version of this item" delete. */
const DELETE_ITEM_SQL = "DELETE FROM item_versions WHERE item_type = ? AND item_id = ?";

/**
 * "This item is STILL in the Trash at the cutoff": its latest version is a
 * `delete` recorded at or before the cutoff. Bound args: (item_type, item_id,
 * cutoff). Deliberately free of any outer-table reference, so the same predicate
 * guards both the version delete (erase.js) and the tombstone insert (which has
 * no outer row at all) — the two can then never drift apart.
 *
 * A restore that lands after the listing writes a newer version, so the
 * predicate stops matching: the restored item's history survives AND it is not
 * tombstoned.
 */
const TRASH_ITEM_STILL_DELETED = `
       EXISTS (
         SELECT 1 FROM item_versions latest
          WHERE latest.item_type = ?
            AND latest.item_id = ?
            AND latest.op = 'delete'
            AND latest.created_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM item_versions newer
               WHERE newer.item_type = latest.item_type
                 AND newer.item_id = latest.item_id
                 AND newer.id > latest.id
            )
       )`;

/**
 * The guarded delete: every version of the item, but only while it is still in
 * the Trash at the cutoff (see TRASH_ITEM_STILL_DELETED).
 */
const DELETE_TRASH_ITEM_SQL = `
  DELETE FROM item_versions
   WHERE item_type = ? AND item_id = ?
     AND ${TRASH_ITEM_STILL_DELETED}`;

/** The unconditional tombstone write (idempotent: the FIRST erase is the fact). */
const TOMBSTONE_SQL = `
  INSERT INTO ${ITEM_ERASURES_TABLE} (item_type, item_id, erased_at, erased_by, origin_instance)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(item_type, item_id) DO NOTHING`;

/** The guarded tombstone write: only for an item still in the Trash at the cutoff. */
const TOMBSTONE_TRASH_SQL = `
  INSERT INTO ${ITEM_ERASURES_TABLE} (item_type, item_id, erased_at, erased_by, origin_instance)
  SELECT ?, ?, ?, ?, ?
   WHERE ${TRASH_ITEM_STILL_DELETED}
  ON CONFLICT(item_type, item_id) DO NOTHING`;

/* ------------------------------------------------------------- tombstones */

/** `<authorKind>[:<authorId>]` — what item_erasures.erased_by records. */
function erasedByOf(by) {
  return by.authorId ? `${by.authorKind}:${by.authorId}` : by.authorKind;
}

/**
 * The erasure keys an item's tombstone is recorded under.
 *
 * A tombstone is looked up by whatever identifies the item on the WIRE, because
 * the refusal that matters (instance-sync) judges an inbound row, and that row
 * is what a peer sends:
 *
 *   memory           the item id. memories have no portable key on this table's
 *                    sync path at all — its delete path is keyed by id too
 *                    (DELETE_KEY_POLICY.memories, a known legacy gap this does
 *                    not widen).
 *   context_section  the section's own scope — section_key + device_id + the
 *                    PORTABLE project uuid — because crow_context rows are keyed
 *                    by that composite on the wire and their rowids are per
 *                    instance. The local item id is recorded as well, so a
 *                    restore of a version of that very row is refused without
 *                    having to reconstruct a snapshot first.
 *
 * A context section whose snapshot is unknown (no version left to read one from)
 * falls back to its local item id, and the lookup side checks both shapes, so the
 * pair stays symmetric.
 *
 * @param {string} itemType a covered item_type
 * @param {{itemId?: string|number|null, snapshot?: object|null}} [item]
 * @returns {string[]} one or two keys, never empty for a valid item
 */
export function erasureKeys(itemType, { itemId = null, snapshot = null } = {}) {
  const keys = [];
  if (
    itemType === "context_section" &&
    snapshot &&
    typeof snapshot.section_key === "string" &&
    snapshot.section_key !== ""
  ) {
    keys.push(
      JSON.stringify({
        section_key: snapshot.section_key,
        device_id: snapshot.device_id ?? null,
        project_uuid: snapshot.project_uuid ?? null,
      }),
    );
  }
  if (itemId !== null && itemId !== undefined && String(itemId) !== "") keys.push(String(itemId));
  return keys;
}

/** Per-handle memo: this store's tombstone table has been checked/created. */
const ERASURES_READY = new WeakSet();

/**
 * Make sure item_erasures exists before an erase writes to it. A store that has
 * item_versions but not the tombstone table is a dev store from an earlier build
 * of migration 0024; an erase must not fail (and must not stop erasing) because
 * of that, so the table is created here too. `IF NOT EXISTS` makes the race with
 * any other creator harmless.
 */
async function ensureErasuresTable(db) {
  if (ERASURES_READY.has(db)) return;
  try {
    await db.execute(ITEM_ERASURES_DDL);
    ERASURES_READY.add(db);
  } catch (err) {
    // A read-only store still erases; it just cannot record the tombstone, and
    // the insert below reports why.
    console.warn("[history] could not ensure item_erasures:", err?.message ?? err);
  }
}

/** Is `key` tombstoned for `itemType` on this store? (async, for callers holding the client) */
export async function isErased(db, itemType, key) {
  if (key === null || key === undefined) return false;
  try {
    const { rows } = await db.execute({
      sql: `SELECT 1 FROM ${ITEM_ERASURES_TABLE} WHERE item_type = ? AND item_id = ? LIMIT 1`,
      args: [itemType, String(key)],
    });
    return rows.length > 0;
  } catch {
    return false; // no tombstone table yet = nothing was ever erased
  }
}

/**
 * The synchronous twin of isErased, for a caller already inside ONE transaction
 * (api.js's restore): `run` is the transaction's immediate statement runner.
 */
export function isErasedSync(run, itemType, key) {
  if (key === null || key === undefined) return false;
  try {
    const { rows } = run({
      sql: `SELECT 1 FROM ${ITEM_ERASURES_TABLE} WHERE item_type = ? AND item_id = ? LIMIT 1`,
      args: [itemType, String(key)],
    });
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Is any of `keys` tombstoned for `itemType`? The one question both the restore
 * refusal and instance-sync's re-create refusal ask, so they cannot answer
 * differently. This is the one for a caller holding the client.
 *
 * @param {{execute: Function}} db
 * @param {string} itemType
 * @param {string[]} keys
 * @returns {Promise<string|null>} the key that matched, or null
 */
export async function findErasedKey(db, itemType, keys) {
  for (const key of keys || []) {
    if (await isErased(db, itemType, key)) return String(key);
  }
  return null;
}

/**
 * The synchronous twin of findErasedKey, for a caller already inside ONE
 * transaction (api.js's restore): `run` is the transaction's immediate statement
 * runner. Deliberately not an async function — a Promise would be truthy, and a
 * restore that believed one would refuse every restore.
 *
 * @param {(statement: {sql: string, args?: any[]}) => {rows: object[]}} run
 * @param {string} itemType
 * @param {string[]} keys
 * @returns {string|null}
 */
export function findErasedKeySync(run, itemType, keys) {
  for (const key of keys || []) {
    if (isErasedSync(run, itemType, key)) return String(key);
  }
  return null;
}

/** The item's newest stored snapshot, or null (used to key a context section's tombstone). */
async function latestSnapshot(db, itemType, itemId) {
  try {
    const { rows } = await db.execute({
      sql: `SELECT snapshot_json FROM item_versions WHERE item_type = ? AND item_id = ? ORDER BY id DESC LIMIT 1`,
      args: [itemType, String(itemId)],
    });
    if (!rows[0]) return null;
    const parsed = JSON.parse(rows[0].snapshot_json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The wire row an erase event carries for one item: the same identity the item's
 * ordinary ops use on that table (memories by id — its delete path's key;
 * crow_context by its composite), so a peer can find its own copy. Null when the
 * item cannot be named on the wire (a context section whose scope is unknown).
 */
function eraseWireRow(itemType, itemId, snapshot) {
  if (itemType === "memory") return { id: itemId };
  if (itemType === "context_section" && snapshot && typeof snapshot.section_key === "string" && snapshot.section_key !== "") {
    return {
      section_key: snapshot.section_key,
      device_id: snapshot.device_id ?? null,
      project_uuid: snapshot.project_uuid ?? null,
    };
  }
  return null;
}

/**
 * Broadcast erase events, one per item, through the same door every ordinary
 * write uses (servers/shared/sync-emit.js `emitOrQueue`): a live manager emits
 * now, a process without one (the Maker Lab bundle's own stdio MCP server) queues
 * it durably for the gateway's drain.
 *
 * Best effort by contract: an erase that has committed must never be undone — or
 * hidden — by a sync problem, and emitOrQueue never throws.
 *
 * @returns {Promise<number>} how many events actually left (emitted or queued)
 */
async function emitEraseEvents(db, events, { syncManager, erasedAt, erasedBy }) {
  if (events.length === 0) return 0;
  const manager = syncManager === undefined ? await defaultSyncManager() : syncManager;
  const { emitOrQueue } = await import("../sync-emit.js");
  let sent = 0;
  for (const event of events) {
    const row = { ...event.row, erased_at: erasedAt, erased_by: erasedBy };
    const result = await emitOrQueue(manager, db, event.table, "erase", row);
    if (result !== null && result !== undefined) sent += 1;
  }
  return sent;
}

/**
 * The process's InstanceSyncManager, when this process has one (the gateway and
 * the stdio sharing server register it as a singleton). A peek: never constructs
 * managers, so an erase in a test or a bundle process cannot boot the fleet.
 */
async function defaultSyncManager() {
  try {
    const { getInstanceSyncManager } = await import("../../sharing/managers.js");
    return getInstanceSyncManager() || null;
  } catch {
    return null;
  }
}

/**
 * The tombstones + version deletes for a batch of items, as ONE armed
 * transaction (see runArmedStatements): the tombstone rows go FIRST, so the
 * guarded variant still sees the Trash state the delete is about to act on.
 *
 * @param {object} db
 * @param {{items: Array<{itemType: string, itemId: string, keys: string[], snapshot: object|null}>,
 *   cutoff: string|null, by: {authorKind: string, authorId: string|null}}} batch
 * @returns {Promise<{tombstones: number, deleted: Array<{rowsAffected: number}>}>}
 */
async function runEraseBatch(db, { items, cutoff, by }) {
  await ensureErasuresTable(db);
  const erasedAt = new Date().toISOString();
  const erasedBy = erasedByOf(by);
  const origin = readLocalInstanceIdOrNull();
  const statements = [];
  for (const item of items) {
    for (const key of item.keys) {
      if (cutoff === null) {
        statements.push({ sql: TOMBSTONE_SQL, args: [item.itemType, key, erasedAt, erasedBy, origin] });
      } else {
        statements.push({
          sql: TOMBSTONE_TRASH_SQL,
          args: [item.itemType, key, erasedAt, erasedBy, origin, item.itemType, item.itemId, cutoff],
        });
      }
    }
  }
  const tombstones = statements.length;
  for (const item of items) {
    statements.push(
      cutoff === null
        ? { sql: DELETE_ITEM_SQL, args: [item.itemType, item.itemId] }
        : { sql: DELETE_TRASH_ITEM_SQL, args: [item.itemType, item.itemId, item.itemType, item.itemId, cutoff] },
    );
  }
  const results = await withoutWriteContext(() => runArmedStatements(db, statements));
  return { tombstones, deleted: results.slice(tombstones), erasedAt, erasedBy };
}

/**
 * Erase every version of the named items.
 *
 * @param {object} db libsql-shaped client (servers/db.js)
 * @param {Array<{itemType: string, itemId: string|number}>} items
 * @param {{authorKind: string, authorId?: string}} ctx a real owner or system actor
 * @param {{deletedBefore?: string|null, syncManager?: object|null|undefined}} [opts] when
 *   set, erase an item only if its latest version is still a `delete` at or before this
 *   ISO timestamp (the Trash clock). The whole item's versions go when it matches — and
 *   only then is its tombstone written, so a restore that won the race is not tombstoned
 *   either. `syncManager` is the process's InstanceSyncManager when the caller has one;
 *   undefined means "resolve this process's singleton if there is one", null means "do
 *   not emit" (a test, a host with sync off).
 * @returns {Promise<{erased: Array<{itemType: string, itemId: string, versions: number}>,
 *   versions: number, tombstones: number, emitted: number,
 *   by: {authorKind: string, authorId: string|null}}>}
 *   `versions` per item is what the erase actually removed (0 for an item that
 *   had none — an idempotent repeat of an erase, which is not an error).
 *   `tombstones` counts the tombstone writes this call issued (one or two per
 *   item) and `emitted` the erase events that reached the sync layer.
 */
export async function eraseItems(db, items, ctx, { deletedBefore = null, syncManager = undefined } = {}) {
  const by = assertEraseActor(ctx);
  const wanted = normalizeItems(items);
  if (wanted.length === 0) return { erased: [], versions: 0, tombstones: 0, emitted: 0, by };
  if (!(await historyInstalled(db))) return { erased: [], versions: 0, tombstones: 0, emitted: 0, by };

  const cutoff = typeof deletedBefore === "string" && deletedBefore !== "" ? deletedBefore : null;
  // A context section's tombstone key comes from its newest version's snapshot
  // (its scope on the wire), so it is read BEFORE the versions are erased.
  const ready = [];
  for (const item of wanted) {
    const snapshot = item.itemType === "context_section" ? await latestSnapshot(db, item.itemType, item.itemId) : null;
    ready.push({ ...item, snapshot, keys: erasureKeys(item.itemType, { itemId: item.itemId, snapshot }) });
  }

  const batch = await runEraseBatch(db, { items: ready, cutoff, by });
  const erased = wanted.map((item, i) => ({ ...item, versions: Number(batch.deleted[i]?.rowsAffected || 0) }));

  // Only the items whose versions were really taken are announced: an item a
  // restore saved is neither erased here nor tombstoned here, and telling a peer
  // to erase it would delete a copy this instance just kept.
  const events = [];
  for (let i = 0; i < ready.length; i++) {
    if (cutoff !== null && erased[i].versions === 0) continue;
    const row = eraseWireRow(ready[i].itemType, ready[i].itemId, ready[i].snapshot);
    const table = erasureSyncTable(ready[i].itemType);
    if (row && table) events.push({ table, row });
  }
  const emitted = await emitEraseEvents(db, events, {
    syncManager,
    erasedAt: batch.erasedAt,
    erasedBy: batch.erasedBy,
  });

  return {
    erased,
    versions: erased.reduce((sum, e) => sum + e.versions, 0),
    tombstones: batch.tombstones,
    emitted,
    by,
  };
}

/**
 * Erase the history of everything a permanently deleted project removed.
 *
 * The closure is over the ITEM, not the row (covered.js): the candidate set is
 * every item with at least one version whose project_ref is this project's uuid
 * OR its local id, and the version set erased is ALL of that item's versions.
 * A memory that moved between projects therefore loses its half under this
 * project as well — it cannot be left behind as a fragment.
 *
 * ONLY items whose LATEST version is a delete. That is the whole safety rule of
 * a project erase: memories the purge UNFILED still exist (the user keeps them),
 * so their history is never a project delete's to take, while the context
 * sections the purge DELETED are gone and their versions go with them.
 *
 * One conditional DELETE does the work, and the tombstones for exactly the items
 * it removes are written in the SAME armed transaction (each guarded by the same
 * item-level predicate the delete uses, so a store that changed in between cannot
 * tombstone something the delete spares). The candidate read that builds them
 * and reports them is the read immediately before it; the delete never trusts it.
 *
 * @param {object} db
 * @param {{projectUuid?: string|null, projectId?: string|number|null}} project
 * @param {{authorKind: string, authorId?: string}} ctx
 * @param {{syncManager?: object|null|undefined}} [opts] see eraseItems
 * @returns {Promise<{erased: Array<{itemType: string, itemId: string, versions: number}>,
 *   versions: number, tombstones: number, emitted: number, projectRefs: string[], by: object}>}
 */
export async function eraseByProject(db, project = {}, ctx, { syncManager = undefined } = {}) {
  const by = assertEraseActor(ctx);
  const refs = projectRefs(project);
  if (refs.length === 0) {
    throw eraseError("invalid_request", "eraseByProject needs a project uuid or a project id");
  }
  if (!(await historyInstalled(db))) {
    return { erased: [], versions: 0, tombstones: 0, emitted: 0, projectRefs: refs, by };
  }
  await ensureErasuresTable(db);

  const placeholders = refs.map(() => "?").join(", ");
  // The latest version is the one with no newer row; `latest.op = 'delete'` is
  // the whole safety rule (an unfiled memory's latest version is an update).
  const candidateSql = `
    SELECT v.item_type, v.item_id, COUNT(*) AS versions,
           (SELECT s.snapshot_json FROM item_versions s
             WHERE s.item_type = v.item_type AND s.item_id = v.item_id
             ORDER BY s.id DESC LIMIT 1) AS latest_snapshot
      FROM item_versions v
     WHERE EXISTS (
             SELECT 1 FROM item_versions p
              WHERE p.item_type = v.item_type
                AND p.item_id = v.item_id
                AND p.project_ref IN (${placeholders})
           )
       AND EXISTS (
             SELECT 1 FROM item_versions latest
              WHERE latest.item_type = v.item_type
                AND latest.item_id = v.item_id
                AND latest.op = 'delete'
                AND NOT EXISTS (
                  SELECT 1 FROM item_versions newer
                   WHERE newer.item_type = latest.item_type
                     AND newer.item_id = latest.item_id
                     AND newer.id > latest.id
                )
           )
     GROUP BY v.item_type, v.item_id
     ORDER BY v.item_type, v.item_id`;
  const deleteSql = `
    DELETE FROM item_versions
     WHERE EXISTS (
             SELECT 1 FROM item_versions p
              WHERE p.item_type = item_versions.item_type
                AND p.item_id = item_versions.item_id
                AND p.project_ref IN (${placeholders})
           )
       AND EXISTS (
             SELECT 1 FROM item_versions latest
              WHERE latest.item_type = item_versions.item_type
                AND latest.item_id = item_versions.item_id
                AND latest.op = 'delete'
                AND NOT EXISTS (
                  SELECT 1 FROM item_versions newer
                   WHERE newer.item_type = latest.item_type
                     AND newer.item_id = latest.item_id
                     AND newer.id > latest.id
                )
           )`;

  // The candidates, read once to build their tombstones (a context section's key
  // is its scope, taken from its own snapshot) and to report them.
  const candidates = await db.execute({ sql: candidateSql, args: refs });
  const ready = (candidates.rows ?? []).map((row) => {
    const itemType = String(row.item_type);
    const itemId = String(row.item_id);
    let snapshot = null;
    try {
      snapshot = row.latest_snapshot ? JSON.parse(row.latest_snapshot) : null;
    } catch {
      snapshot = null;
    }
    return {
      itemType,
      itemId,
      snapshot,
      versions: Number(row.versions || 0),
      keys: erasureKeys(itemType, { itemId, snapshot }),
    };
  });

  const erasedAt = new Date().toISOString();
  const erasedBy = erasedByOf(by);
  const origin = readLocalInstanceIdOrNull();
  // The predicate the tombstone INSERT re-asserts for one item. Its args are
  // (itemType, itemId, ...refs, itemType, itemId) — see the SELECT's column list.
  const tombstoneGuard = `
     EXISTS (SELECT 1 FROM item_versions p
              WHERE p.item_type = ? AND p.item_id = ? AND p.project_ref IN (${placeholders}))
       AND EXISTS (SELECT 1 FROM item_versions latest
                    WHERE latest.item_type = ? AND latest.item_id = ?
                      AND latest.op = 'delete'
                      AND NOT EXISTS (SELECT 1 FROM item_versions newer
                                       WHERE newer.item_type = latest.item_type
                                         AND newer.item_id = latest.item_id
                                         AND newer.id > latest.id))`;
  const tombstoneStatements = [];
  for (const item of ready) {
    for (const key of item.keys) {
      tombstoneStatements.push({
        sql: `INSERT INTO ${ITEM_ERASURES_TABLE} (item_type, item_id, erased_at, erased_by, origin_instance)
              SELECT ?, ?, ?, ?, ?
               WHERE ${tombstoneGuard}
              ON CONFLICT(item_type, item_id) DO NOTHING`,
        args: [item.itemType, key, erasedAt, erasedBy, origin, item.itemType, item.itemId, ...refs, item.itemType, item.itemId],
      });
    }
  }

  await withoutWriteContext(() =>
    runArmedStatements(db, [...tombstoneStatements, { sql: deleteSql, args: refs }]),
  );

  const erased = ready.map(({ itemType, itemId, versions }) => ({ itemType, itemId, versions }));

  const events = [];
  for (const item of ready) {
    const row = eraseWireRow(item.itemType, item.itemId, item.snapshot);
    const table = erasureSyncTable(item.itemType);
    if (row && table) events.push({ table, row });
  }
  const emitted = await emitEraseEvents(db, events, { syncManager, erasedAt, erasedBy });

  return {
    erased,
    versions: erased.reduce((sum, e) => sum + e.versions, 0),
    tombstones: tombstoneStatements.length,
    emitted,
    projectRefs: refs,
    by,
  };
}

/**
 * Apply an ERASE that arrived from a peer (instance-sync's `op === "erase"`).
 *
 * The peer's instruction is "this item must not exist on either of us": so the
 * live row goes if it is here, its versions are erased through the same armed
 * door (armed transaction, one commit), and this instance records its OWN
 * tombstone — keyed the way it will later be asked about (erasureKeys), with the
 * erasing instance as the origin. The tombstone is the part that makes the erase
 * stick: a later restore on the peer emits an insert this instance now refuses.
 *
 * Idempotent: a re-delivered erase finds no row, no versions and an existing
 * tombstone, and changes nothing.
 *
 * @param {object} db
 * @param {{itemType: string, itemId: string, keys: string[], snapshot?: object|null}} item
 *   `itemId` is the LOCAL item id whose versions go (the live row's id here, not
 *   the sender's); `keys` are the tombstone keys (see erasureKeys)
 * @param {{originInstance?: string|null, erasedAt?: string|null, erasedBy?: string|null}} [meta]
 * @returns {Promise<{tombstones: number, versions: number}>}
 */
export async function applyRemoteErasure(db, item, { originInstance = null, erasedAt = null, erasedBy = null } = {}) {
  if (!item || !item.itemType) {
    throw eraseError("invalid_request", "applyRemoteErasure needs an itemType");
  }
  if (!(await historyInstalled(db))) return { tombstones: 0, versions: 0 };
  await ensureErasuresTable(db);

  const at = typeof erasedAt === "string" && erasedAt !== "" ? erasedAt : new Date().toISOString();
  const by = typeof erasedBy === "string" && erasedBy !== "" ? erasedBy : `peer:${originInstance ?? "unknown"}`;
  const keys = Array.isArray(item.keys) && item.keys.length > 0
    ? item.keys
    : erasureKeys(item.itemType, { itemId: item.itemId, snapshot: item.snapshot ?? null });
  // A peer's erase can arrive for an item this instance has no row (and no
  // history) for — the tombstone is then the whole record, and it is what refuses
  // the re-create that may still come.
  const localId = item.itemId === null || item.itemId === undefined ? null : String(item.itemId);

  const statements = [
    ...keys.map((key) => ({
      sql: `INSERT INTO ${ITEM_ERASURES_TABLE} (item_type, item_id, erased_at, erased_by, origin_instance)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(item_type, item_id) DO NOTHING`,
      args: [item.itemType, key, at, by, originInstance],
    })),
  ];
  if (localId !== null) statements.push({ sql: DELETE_ITEM_SQL, args: [item.itemType, localId] });
  const results = await withoutWriteContext(() => runArmedStatements(db, statements));
  return {
    tombstones: keys.length,
    versions: localId === null ? 0 : Number(results[keys.length]?.rowsAffected || 0),
  };
}