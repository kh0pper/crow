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
 *
 * A TOMBSTONE IS VERSIONED (review round on the first cut of this design). "The
 * item may never come back" is true of the item that was erased, not of the
 * identity forever: a genuinely new item that later reuses a name or an id must
 * still be able to exist. So every tombstone records `erase_lamport` — the
 * lamport of the erase event it represents — and the refusals are bounded by it:
 *
 *   - sync refuses an inbound insert/update only when its lamport_ts is at or
 *     below `erase_lamport`;
 *   - a restore refuses only versions created at or before `erased_at`.
 *
 * THE BOUND IS ALWAYS SET (the review's first point). An erase that is NOT
 * announced — the operator's setting is off, the item never syncs, it is a Maker
 * Lab erasure, it is a permanent project delete — still binds its tombstone, to
 * THIS instance's lamport counter read at erase time (readLocalLamportOrNull:
 * the same `sync_state.local_counter` instance-sync mints from, read and never
 * minted). So a tombstone means "the item as of that counter may never come
 * back" rather than "this id/name is dead forever": a section a peer genuinely
 * writes later carries a higher lamport and is accepted. NULL is reserved for a
 * store whose counter cannot be read at all, and that unbounded tombstone refuses
 * everything, which is the safe direction.
 *
 * ONLY ITEMS THAT ACTUALLY SYNC PROPAGATE (same review). A starter or Maker Lab
 * memory, a Maker Lab learner's whole record, a project-scoped section while
 * project-section sync is off, a permanent project delete (spec §15: a purge
 * emits nothing): their erasures are tombstoned LOCALLY and never leave the
 * host — see eraseSyncEnabled(), isLocalOnlyEraseActor() and eraseEventsFor().
 */
import { withoutWriteContext } from "./write-context.js";
import { readLocalInstanceIdOrNull } from "../crow-home.js";
import { isSummaryMemorySource } from "../summary-source.js";

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
    erase_lamport INTEGER,
    PRIMARY KEY (item_type, item_id)
  );`;

/**
 * The Maker Lab learner-delete marker's DDL — THE one definition, imported by
 * migration 0024 and by bundles/maker-lab/server/pending-erasures.js (through
 * the app root), so the two can never drift into a shape a retry cannot read.
 * A local table (never synced): it names a learner whose cascade has committed
 * but whose history erase has not finished, with the memory ids read just before
 * the cascade so the erase can be re-run after the profile row is gone.
 */
export const PENDING_ERASURES_DDL = `
  CREATE TABLE IF NOT EXISTS pending_erasures (
    learner_id INTEGER PRIMARY KEY,
    project_uuid TEXT,
    memory_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`;

/**
 * A REMOTE erase that could not be finished in one transaction (see
 * applyRemoteErasure): the tombstone is already written, and this row is the
 * rest of the work — the local item ids, the statement that removes each live
 * row, and the cutoff — so the 5-minute history sweep can finish it. A local
 * work item, never synced, deleted when the erase completes.
 */
export const PENDING_REMOTE_ERASURES_TABLE = "pending_remote_erasures";
export const PENDING_REMOTE_ERASURES_DDL = `
  CREATE TABLE IF NOT EXISTS ${PENDING_REMOTE_ERASURES_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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

/**
 * The LOCAL setting that gates erase emission: `history.erase_sync`, default
 * OFF.
 *
 * WHY A SETTING AND NOT A PEER CAPABILITY. A peer that does not understand
 * `op: "erase"` consumes it as a no-op (memories) or as a lamport touch
 * (crow_context) and never catches up, so an erase must only be emitted to peers
 * that advertise `history-erase-v1`. There is no application-level capability
 * advertisement to hang that on: instance-sync's handshake flags (`cr`, `pb`,
 * `sm`) are TRANSPORT binding negotiated per connection, not a statement about
 * which sync payloads a peer applies, and emission goes into per-peer Hypercore
 * feeds that are appended to while the peer is offline and armed later — so an
 * ephemeral hello flag cannot gate an append. Adding a capability advertisement
 * is a new mechanism (hello flag on both transports, a persisted per-peer
 * capability, per-peer entry variants, and a per-peer pending list), which is
 * the operator's call, not this change's. Until then: off means no erase event
 * ever leaves the host (and an INBOUND erase is only recorded as a bounded
 * tombstone, never applied — see instance-sync's `_tombstoneOnlyErase`), and
 * turning it on is an explicit fleet-wide decision taken once every peer runs this
 * code. It is therefore opt-in on BOTH SIDES: the sender needs it on to emit, the
 * receiver needs it on to apply.
 */
export const ERASE_SYNC_SETTING = "history.erase_sync";

/** Read ERASE_SYNC_SETTING (global row). Default OFF, and a read error is OFF too. */
export async function eraseSyncEnabled(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = ?",
      args: [ERASE_SYNC_SETTING],
    });
    const value = rows[0]?.value;
    return value === "1" || value === "true" || value === "on";
  } catch {
    return false; // no settings table (a bare store, a test) = off
  }
}

/**
 * Actor ids whose erasures NEVER leave the host.
 *
 * `maker-lab`     Maker Lab's learner delete runs as `system:maker-lab`
 *                 (bundles/maker-lab/server/pending-erasures.js) and its
 *                 DATA-HANDLING promise is that learner data does not leave the
 *                 host — so its tombstones stay local whatever the memory's
 *                 source says.
 * `project-delete` a permanent project delete is a PURGE: spec §15 says a purge
 *                 emits nothing at all (its tombstone is the local record), so
 *                 its history erase must not become the one thing it announces.
 */
export const LOCAL_ONLY_ERASE_ACTORS = Object.freeze(["maker-lab", "project-delete"]);

/** Is this erase one that must never be announced? */
export function isLocalOnlyEraseActor(by) {
  return Boolean(by && by.authorId && LOCAL_ONLY_ERASE_ACTORS.includes(String(by.authorId)));
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
 * Does this (open) client have `table`? Used to tell "no history on this store"
 * from "history is half-installed" when an inbound erase has to be finished later.
 */
async function tableExists(db, table) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      args: [table],
    });
    return rows.length > 0;
  } catch {
    return false;
  }
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
 * The BOUNDED version delete for an item that is already in the Trash when a
 * peer's erase arrives: only the versions created at or before the erase's own
 * time (the apply's local clock). A version written afterwards is a newer local
 * fact — a newer local delete or a local re-create — and the caller does not run
 * this statement at all in that case (see runRemoteEraseTransaction, which
 * requires the item's newest version to be a `delete` at or before the erase).
 * The `created_at <= ?` predicate is the second half of that rule, so the
 * statement is safe on its own too.
 */
const DELETE_ITEM_VERSIONS_UP_TO_SQL = `
  DELETE FROM item_versions
   WHERE item_type = ? AND item_id = ? AND created_at <= ?`;

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

/**
 * The upsert branch every tombstone write shares (the review's fifth point).
 *
 * A tombstone is not "written once, once only": an id or a section name can be
 * reused and erased AGAIN, and the second erase is a later fact than the first.
 * So a conflicting write moves the bound FORWARD (MAX — a re-erase never lowers a
 * bound this store already refuses below) and keeps the newest `erased_at` (the
 * restore gate's window). `MAX` is SQLite's two-argument scalar form, hence the
 * COALESCE pairing: a NULL bound means "cannot be read/unbounded" and must not
 * swallow the other side (MAX(x, NULL) is NULL).
 */
const TOMBSTONE_UPSERT = `
  ON CONFLICT(item_type, item_id) DO UPDATE SET
    erase_lamport = MAX(COALESCE(item_erasures.erase_lamport, excluded.erase_lamport),
                        COALESCE(excluded.erase_lamport, item_erasures.erase_lamport)),
    erased_at = CASE WHEN excluded.erased_at > item_erasures.erased_at
                     THEN excluded.erased_at ELSE item_erasures.erased_at END`;

/** The unconditional tombstone write (moves an existing row forward, see TOMBSTONE_UPSERT). */
const TOMBSTONE_SQL = `
  INSERT INTO ${ITEM_ERASURES_TABLE} (item_type, item_id, erased_at, erased_by, origin_instance, erase_lamport)
  VALUES (?, ?, ?, ?, ?, ?)
  ${TOMBSTONE_UPSERT}`;

/** The guarded tombstone write: only for an item still in the Trash at the cutoff. */
const TOMBSTONE_TRASH_SQL = `
  INSERT INTO ${ITEM_ERASURES_TABLE} (item_type, item_id, erased_at, erased_by, origin_instance, erase_lamport)
  SELECT ?, ?, ?, ?, ?, ?
   WHERE ${TRASH_ITEM_STILL_DELETED}
  ${TOMBSTONE_UPSERT}`;

/* ------------------------------------------------------------- tombstones */

/**
 * A session summary's tombstone key is `summary:<source>` — namespaced so it can
 * never collide with a memory id (numeric text) and so the lookup side can tell
 * the two shapes apart.
 */
export const SUMMARY_TOMBSTONE_PREFIX = "summary:";

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
 *                    not widen). A session SUMMARY memory is the exception its
 *                    own apply path already makes: it is keyed on its source
 *                    (`session-summary:<origin>:<thread>`), never by an id a
 *                    peer shares, so a summary's tombstone carries ONLY that
 *                    portable key — an id-keyed one would tombstone whichever
 *                    unrelated local memory happens to hold the sender's id
 *                    (the review's eighth point);
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
  if (itemType === "memory" && snapshot && isSummaryMemorySource(snapshot.source)) {
    // A summary is named by its SOURCE and nothing else: the numeric id is the
    // writer's own rowid and means nothing on a peer (and nothing here either
    // once the row is a different life of that id).
    keys.push(`${SUMMARY_TOMBSTONE_PREFIX}${String(snapshot.source)}`);
    return keys;
  }
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
 *
 * The same goes for `erase_lamport`: it arrived with a later build of that same
 * unreleased migration, and a store that recorded 0024 from the earlier one never
 * runs it again — so a process that erases before the gateway's boot ensure has
 * visited this store (a bundle's own MCP server, a test) would hit a missing
 * column. Additive and idempotent.
 */
async function ensureErasuresTable(db) {
  if (ERASURES_READY.has(db)) return;
  try {
    await db.execute(ITEM_ERASURES_DDL);
    const { rows } = await db.execute(`PRAGMA table_info(${ITEM_ERASURES_TABLE})`);
    if (rows.length > 0 && !rows.some((column) => column.name === "erase_lamport")) {
      await db.execute(`ALTER TABLE ${ITEM_ERASURES_TABLE} ADD COLUMN erase_lamport INTEGER`);
    }
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

/** The tombstone rows for `keys`, as [{item_id, erased_at, erase_lamport}]. */
async function readTombstones(db, itemType, keys) {
  const wanted = (keys || []).filter((key) => key !== null && key !== undefined).map(String);
  if (wanted.length === 0) return [];
  try {
    const { rows } = await db.execute({
      sql: `SELECT item_id, erased_at, erase_lamport FROM ${ITEM_ERASURES_TABLE}
             WHERE item_type = ? AND item_id IN (${wanted.map(() => "?").join(", ")})`,
      args: [itemType, ...wanted],
    });
    return rows;
  } catch {
    return []; // no tombstone table yet = nothing was ever erased
  }
}

/** The synchronous twin of readTombstones, for inside a restore's transaction. */
function readTombstonesSync(run, itemType, keys) {
  const wanted = (keys || []).filter((key) => key !== null && key !== undefined).map(String);
  if (wanted.length === 0) return [];
  try {
    const { rows } = run({
      sql: `SELECT item_id, erased_at, erase_lamport FROM ${ITEM_ERASURES_TABLE}
             WHERE item_type = ? AND item_id IN (${wanted.map(() => "?").join(", ")})`,
      args: [itemType, ...wanted],
    });
    return rows;
  } catch {
    return [];
  }
}

/**
 * The tombstone that must REFUSE an inbound change, or null.
 *
 * Versioned on purpose (the review's point): "never re-create" is about the item
 * that was erased, not about its identity forever. Every tombstone records the
 * lamport it is bounded by, `erase_lamport` — the erase event's own lamport when it
 * travelled, this instance's counter at erase time when it did not:
 *
 *   erase_lamport NULL      the counter could not be read at all, so nothing can
 *                           be shown to post-date the erase: everything is refused.
 *   incomingTs <= it        the change is the erased item coming back: refused.
 *   incomingTs > it         a genuinely NEW item that reuses that id/name later:
 *                           accepted.
 *
 * @param {{execute: Function}} db
 * @param {string} itemType
 * @param {string[]} keys
 * @param {number|null} incomingTs the inbound entry's lamport_ts
 * @returns {Promise<object|null>} the tombstone row that refused it, or null
 */
export async function findEraseRefusal(db, itemType, keys, incomingTs) {
  const ts = Number(incomingTs);
  for (const tombstone of await readTombstones(db, itemType, keys)) {
    const bound = tombstone.erase_lamport;
    if (bound === null || bound === undefined) return tombstone;
    if (!Number.isFinite(ts)) return tombstone; // an entry with no lamport cannot post-date an erase
    if (ts <= Number(bound)) return tombstone;
  }
  return null;
}

/**
 * The tombstone that must refuse the RESTORE of one version, or null.
 *
 * A restore is not a lamport race: it is "put this stored value back". The
 * question is whether that value predates the erase — a version created at or
 * before `erased_at` is the erased item's, and restoring it would be exactly the
 * resurrection the tombstone forbids. A version written AFTER the erase belongs
 * to a new life of that id/name, and the tombstone has nothing to say about it.
 *
 * Synchronous, because api.js asks it inside the restore's one transaction.
 *
 * @param {(statement: {sql: string, args?: any[]}) => {rows: object[]}} run
 * @param {string} itemType
 * @param {string[]} keys
 * @param {string|null} createdAt the version's created_at
 * @returns {object|null}
 */
export function findEraseRefusalSync(run, itemType, keys, createdAt) {
  const at = typeof createdAt === "string" && createdAt !== "" ? createdAt : null;
  for (const tombstone of readTombstonesSync(run, itemType, keys)) {
    const erasedAt = tombstone.erased_at;
    if (typeof erasedAt !== "string" || erasedAt === "") return tombstone;
    if (at === null) return tombstone; // an undated version cannot be shown to post-date it
    if (at <= erasedAt) return tombstone; // ISO-8601 UTC strings compare lexicographically
  }
  return null;
}

/** The item's newest stored snapshot, or null (used to key a tombstone and to gate emission). */
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
 * crow_context by its composite), so a peer can find its own copy, PLUS the
 * fields shouldSyncRow() reads from that row (a memory's `source`, a section's
 * project filing). Null when the item cannot be named on the wire (a context
 * section whose scope is unknown).
 *
 * The extra fields are what makes "only items that sync propagate" true at the
 * source: an erase row for a starter or Maker Lab memory carries its source, so
 * the SAME gate that keeps the memory off the wire keeps its erasure off it too
 * (emitChange/emitOrQueue ask shouldSyncRow about exactly this row).
 *
 * NO SNAPSHOT, NO EVENT (the review's eighth point): an item whose newest
 * snapshot could not be read cannot be named on the wire with the fields the
 * gate needs, so the erase stays local. Failing closed here is the safe
 * direction — the tombstone is still written, only the announcement is dropped.
 */
function eraseWireRow(itemType, itemId, snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  if (itemType === "memory") {
    return { id: itemId, source: snapshot.source ?? null };
  }
  if (itemType === "context_section" && typeof snapshot.section_key === "string" && snapshot.section_key !== "") {
    const row = {
      section_key: snapshot.section_key,
      device_id: snapshot.device_id ?? null,
      project_uuid: snapshot.project_uuid ?? null,
    };
    // The LOCAL project id rides along so shouldSyncRow applies crow_context's
    // own rule (a project-scoped section syncs only behind
    // CROW_CONTEXT_PROJECT_SYNC); OUTBOUND_TRANSFORMS strips it on the wire.
    if (snapshot.project_id !== undefined) row.project_id = snapshot.project_id ?? null;
    return row;
  }
  return null;
}

/** Cached dynamic import: erase.js must not import instance-sync statically (it imports us). */
let _instanceSyncModule = null;
async function instanceSyncModule() {
  if (!_instanceSyncModule) _instanceSyncModule = await import("../../sharing/instance-sync.js");
  return _instanceSyncModule;
}

/**
 * The memory sources a PEER may never erase (the review's fourth point): a
 * starter/demo memory and a Maker Lab learner record are per-install, and an
 * id-keyed erase that happens to name one of their ids is a collision, not an
 * instruction. A session SUMMARY is the exception that proves the rule: its wire
 * identity is its source, so an erase that names that source IS about this
 * summary (and one that names a numeric id is not).
 *
 * Resolved from instance-sync (which owns the local-only list) through the cached
 * dynamic import — never a static one, see above. A store where the list cannot be
 * read protects nothing (the same read-only failure direction as the rest of this
 * module: the erase still runs, the protection is what is lost), which is also
 * what the caller did before this check existed.
 *
 * @returns {Promise<{isLocalOnly: (source: unknown) => boolean, isSummary: (source: unknown) => boolean}>}
 */
async function memorySourceTests() {
  try {
    const { isLocalOnlyMemorySource } = await instanceSyncModule();
    const { isSummaryMemorySource: isSummary } = await import("../summary-source.js");
    return {
      isLocalOnly: (source) => isLocalOnlyMemorySource(source),
      isSummary: (source) => isSummary(source),
    };
  } catch {
    return { isLocalOnly: () => false, isSummary: () => false };
  }
}

/**
 * The erase events a batch of erased items may emit: one per item that (a) has a
 * table whose erasures propagate, (b) can be named on the wire, and (c) ACTUALLY
 * SYNCS — shouldSyncRow, with the fields its own snapshot supplies. Everything
 * else is tombstoned locally and never leaves the host: memory ids are shared
 * across instances only for memories that sync at all (starter / maker-lab /
 * summary-only local ones are not), and a project-scoped section whose sync is
 * off must not announce its erase either.
 *
 * Pure-ish (one cached import, no writes). Exported for the tests.
 *
 * @param {Array<{itemType: string, itemId: string, snapshot: object|null}>} items
 * @returns {Promise<Array<{table: string, row: object, itemType: string, itemId: string}>>}
 */
export async function eraseEventsFor(items) {
  const events = [];
  let shouldSyncRow = null;
  for (const item of items) {
    const table = erasureSyncTable(item.itemType);
    if (!table) continue;
    const row = eraseWireRow(item.itemType, item.itemId, item.snapshot);
    if (!row) continue;
    if (!shouldSyncRow) {
      try {
        ({ shouldSyncRow } = await instanceSyncModule());
      } catch {
        return []; // cannot judge syncability = do not claim it syncs
      }
    }
    if (!shouldSyncRow(table, row)) continue;
    events.push({ table, row, itemType: item.itemType, itemId: item.itemId });
  }
  return events;
}

/**
 * WHERE A TOMBSTONE'S BOUND COMES FROM (two sources, one value).
 *
 * An ANNOUNCED erase's bound must be the lamport of the EVENT, and only the sync
 * layer knows what that is: `emitOrQueue`/`emitChange` mint it from the LOCAL
 * instance's counter. A bundle process, a test fleet and the gateway do not share
 * one counter, and minting here from a guessed instance id would bound the
 * tombstone to a value no peer ever sees (a higher peer write would then resurrect
 * the item). So the tombstone is written with the counter read below and RAISED to
 * the event's lamport afterwards (bindEventTombstones).
 *
 * An erase that is NOT announced (setting off, local-only item, Maker Lab, a
 * permanent project delete) keeps the counter it was written with. That is the
 * review's first point: an unannounced erase must still be bounded, or its
 * tombstone (NULL = refuses everything) would keep a peer's genuinely new item —
 * a section re-created under the same name — from ever arriving.
 */

/**
 * This instance's Lamport counter, as instance-sync keeps it — read, never minted.
 *
 * `sync_state.local_counter` is the one series `mintLamport` (servers/shared/
 * sync-stamp.js) increments, so it is the highest value this instance has written
 * or seen. A tombstone bound to it refuses exactly the writes that cannot post-date
 * the erase.
 *
 * NULL ONLY WHEN IT CANNOT BE READ: no `sync_state` table (a bare store), an
 * unreadable store, or no counter row at all. The tombstone is then unbounded,
 * which refuses everything — the safe direction.
 *
 * The one fallback: a store whose counter row is missing for the id the
 * instance-id file names (a test fleet whose manager ids are its own, a host whose
 * file and manager disagree) still has counters under other ids; the greatest one
 * is the furthest this host has got, so it is the tightest bound this code can
 * justify without minting.
 *
 * @param {{execute: Function}} db
 * @returns {Promise<number|null>}
 */
export async function readLocalLamportOrNull(db) {
  try {
    const instanceId = readLocalInstanceIdOrNull();
    if (instanceId) {
      const { rows } = await db.execute({
        sql: "SELECT local_counter FROM sync_state WHERE instance_id = ?",
        args: [instanceId],
      });
      const own = Number(rows[0]?.local_counter);
      if (rows[0] && Number.isFinite(own)) return own;
    }
    const { rows } = await db.execute("SELECT MAX(local_counter) AS top FROM sync_state");
    const top = rows[0]?.top;
    return top === null || top === undefined || !Number.isFinite(Number(top)) ? null : Number(top);
  } catch {
    return null; // no sync_state table (a test shim, a bare store) = no bound
  }
}

/**
 * The SQL bound an inbound erase's live-row delete compares against: the erase's
 * own lamport, or "greater than anything a row can carry" when the erase event
 * arrived without one (an entry with no lamport cannot post-date an erase, so no
 * row can post-date it either).
 */
export function eraseLamportBound(eraseLamport) {
  const value = Number(eraseLamport);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/**
 * The two statements an inbound erase needs for ONE live row, with THE LAMPORT
 * GATE IN THE SQL ITSELF (the review's second point).
 *
 * Reading the local row's lamport before the transaction and then deleting is a
 * TOCTOU race: a local edit that lands in between is deleted anyway. So the
 * predicate travels with the statement, and — because the pending-marker row
 * stores these statements verbatim — a SWEEP RETRY is gated by exactly the same
 * rule. That is what makes "a retried inbound erase never deletes a section
 * edited after the erase" true without a second read.
 *
 *   deleteRow — removes the row only while it does not post-date the erase;
 *   newerRow  — matches when such a row IS here, i.e. the local version wins:
 *               nothing is erased and nothing is tombstoned.
 *
 * @param {string} table the item's own table ("memories", "crow_context")
 * @param {string} where the row's key predicate (e.g. "id = ?")
 * @param {any[]} args its args
 * @param {number|null} eraseLamport the erase event's lamport
 * @returns {{deleteRow: {sql: string, args: any[]}, newerRow: {sql: string, args: any[]}}}
 */
export function eraseLiveRowStatements(table, where, args, eraseLamport) {
  const bound = eraseLamportBound(eraseLamport);
  return {
    deleteRow: {
      sql: `DELETE FROM ${table} WHERE ${where} AND COALESCE(lamport_ts, 0) < ?`,
      args: [...args, bound],
    },
    newerRow: {
      sql: `SELECT 1 FROM ${table} WHERE ${where} AND COALESCE(lamport_ts, 0) >= ? LIMIT 1`,
      args: [...args, bound],
    },
  };
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
 * @returns {Promise<{emitted: number, lamports: Map<string, number>}>} how many
 *   events actually left, and the lamport each one carries, keyed `${itemType}\0${itemId}`
 */
async function emitEraseEvents(db, events, { syncManager, erasedAt, erasedBy }) {
  const lamports = new Map();
  if (events.length === 0) return { emitted: 0, lamports };
  const manager = syncManager === undefined ? await defaultSyncManager() : syncManager;
  const { emitOrQueue } = await import("../sync-emit.js");
  let sent = 0;
  for (const event of events) {
    const row = { ...event.row, erased_at: erasedAt, erased_by: erasedBy };
    const result = await emitOrQueue(manager, db, event.table, "erase", row);
    const lamport = typeof result === "number"
      ? result
      : result && Number.isFinite(Number(result.lamport))
        ? Number(result.lamport)
        : null;
    if (lamport === null) continue;
    sent += 1;
    lamports.set(`${event.itemType}\u0000${event.itemId}`, lamport);
  }
  return { emitted: sent, lamports };
}

/**
 * Bind the tombstones this batch wrote to the lamport their erase event carries.
 *
 * Both halves have to describe ONE event for the versioned refusal to mean
 * anything: the tombstone's bound (below which an inbound write is the erased item
 * coming back) and the entry a peer receives. The bound only ever moves FORWARD
 * (MAX): a tombstone that already carries a bound from an earlier erase of a
 * reused id/name is a fact this store already refuses below, and re-binding it
 * downward would let the older write back in.
 */
async function bindEventTombstones(db, items, events, lamports) {
  const keysByItem = new Map(items.map((item) => [`${item.itemType}\u0000${item.itemId}`, item]));
  const statements = [];
  for (const event of events) {
    const lamport = lamports.get(`${event.itemType}\u0000${event.itemId}`);
    const item = keysByItem.get(`${event.itemType}\u0000${event.itemId}`);
    if (!Number.isFinite(lamport) || !item) continue;
    for (const key of item.keys ?? []) {
      statements.push({
        sql: `UPDATE ${ITEM_ERASURES_TABLE}
                 SET erase_lamport = MAX(COALESCE(erase_lamport, ?), ?)
               WHERE item_type = ? AND item_id = ?`,
        args: [Number(lamport), Number(lamport), item.itemType, key],
      });
    }
  }
  if (statements.length === 0) return;
  try {
    await withoutWriteContext(() => db.batch(statements));
  } catch (err) {
    // The tombstones keep the (counter) bound they were written with, which refuses
    // LESS than the event's lamport would: a peer's write between the two is
    // accepted. That is a warning, not a failure — the erase itself committed.
    console.warn("[history] could not bind the tombstones to their erase event's lamport:", err?.message ?? err);
  }
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
 * The tombstones carry `bound` — this instance's counter at erase time (see
 * readLocalLamportOrNull), or NULL when it cannot be read. An announced erase
 * raises it to the event's lamport afterwards (bindEventTombstones); one that is
 * never announced keeps it.
 *
 * @param {object} db
 * @param {{items: Array<{itemType: string, itemId: string, keys: string[], snapshot: object|null}>,
 *   cutoff: string|null, by: {authorKind: string, authorId: string|null}, bound: number|null}} batch
 * @returns {Promise<{tombstones: number, deleted: Array<{rowsAffected: number}>}>}
 */
async function runEraseBatch(db, { items, cutoff, by, bound = null }) {
  await ensureErasuresTable(db);
  const erasedAt = new Date().toISOString();
  const erasedBy = erasedByOf(by);
  const origin = readLocalInstanceIdOrNull();
  const statements = [];
  for (const item of items) {
    for (const key of item.keys) {
      if (cutoff === null) {
        statements.push({ sql: TOMBSTONE_SQL, args: [item.itemType, key, erasedAt, erasedBy, origin, bound] });
      } else {
        statements.push({
          sql: TOMBSTONE_TRASH_SQL,
          args: [item.itemType, key, erasedAt, erasedBy, origin, bound, item.itemType, item.itemId, cutoff],
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
 *   either. `syncManager` is the process's InstanceSyncManager when the caller has
 *   one; undefined means "resolve this process's singleton if there is one", null
 *   means "this process has no live manager" — the event then takes the durable
 *   queue door (servers/shared/sync-emit.js emitOrQueue) instead, which is what a
 *   bundle's own stdio server needs. NEITHER VALUE SILENCES AN ERASE: that is the
 *   actor (isLocalOnlyEraseActor) and the `history.erase_sync` setting.
 * @returns {Promise<{erased: Array<{itemType: string, itemId: string, versions: number}>,
 *   versions: number, tombstones: number, emitted: number, eraseLamport: number|null,
 *   by: {authorKind: string, authorId: string|null}}>}
 *   `versions` per item is what the erase actually removed (0 for an item that
 *   had none — an idempotent repeat of an erase, which is not an error).
 *   `tombstones` counts the tombstone writes this call issued (one or two per
 *   item), `emitted` the erase events that reached the sync layer, and
 *   `eraseLamport` the lamport the emitted events carry (the greatest, when this
 *   call announced several items) — null when nothing was emitted. A tombstone is
 *   bounded either way: to that lamport when it was announced, to this instance's
 *   counter at erase time when it was not.
 */
export async function eraseItems(db, items, ctx, { deletedBefore = null, syncManager = undefined } = {}) {
  const by = assertEraseActor(ctx);
  const wanted = normalizeItems(items);
  if (wanted.length === 0) return { erased: [], versions: 0, tombstones: 0, emitted: 0, eraseLamport: null, by };
  if (!(await historyInstalled(db))) return { erased: [], versions: 0, tombstones: 0, emitted: 0, eraseLamport: null, by };

  const cutoff = typeof deletedBefore === "string" && deletedBefore !== "" ? deletedBefore : null;
  // The bound every tombstone of this batch is written with: this instance's
  // lamport counter, read (never minted). An announced erase raises it to the
  // event's lamport afterwards; an unannounced one keeps it, so a peer's later
  // re-use of that id/name is not refused forever.
  const bound = await readLocalLamportOrNull(db);
  // Every item's newest snapshot, read BEFORE the versions are erased: a context
  // section's tombstone key comes from it (its scope on the wire) and a memory's
  // source decides whether the item syncs at all (so whether its erase may).
  const ready = [];
  for (const item of wanted) {
    const snapshot = await latestSnapshot(db, item.itemType, item.itemId);
    ready.push({ ...item, snapshot, keys: erasureKeys(item.itemType, { itemId: item.itemId, snapshot }) });
  }

  // ONLY ITEMS THAT SYNC PROPAGATE, and a Maker Lab erasure never does; the
  // operator's `history.erase_sync` setting gates the whole thing.
  const allEvents = isLocalOnlyEraseActor(by) ? [] : await eraseEventsFor(ready);
  const mayEmit = allEvents.length > 0 && (await eraseSyncEnabled(db));

  const batch = await runEraseBatch(db, { items: ready, cutoff, by, bound });
  const erased = wanted.map((item, i) => ({ ...item, versions: Number(batch.deleted[i]?.rowsAffected || 0) }));

  // Only the items whose versions were really taken are announced: an item a
  // restore saved is neither erased here nor tombstoned here, and telling a peer
  // to erase it would delete a copy this instance just kept.
  const taken = new Set(
    wanted
      .filter((_item, i) => cutoff === null || erased[i].versions > 0)
      .map((item) => `${item.itemType}\u0000${item.itemId}`),
  );
  const events = mayEmit
    ? allEvents.filter((event) => taken.has(`${event.itemType}\u0000${event.itemId}`))
    : [];
  const { emitted, lamports } = await emitEraseEvents(db, events, {
    syncManager,
    erasedAt: batch.erasedAt,
    erasedBy: batch.erasedBy,
  });
  // The tombstone's bound IS the event's lamport (the emitter minted it): a peer's
  // write above it is a new item, one at or below it is the erased item returning.
  await bindEventTombstones(db, ready, events, lamports);

  return {
    erased,
    versions: erased.reduce((sum, e) => sum + e.versions, 0),
    tombstones: batch.tombstones,
    emitted,
    eraseLamport: lamports.size > 0 ? Math.max(...lamports.values()) : null,
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
 *   versions: number, tombstones: number, emitted: number, eraseLamport: number|null,
 *   projectRefs: string[], by: object}>}
 */
export async function eraseByProject(db, project = {}, ctx, { syncManager = undefined } = {}) {
  const by = assertEraseActor(ctx);
  const refs = projectRefs(project);
  if (refs.length === 0) {
    throw eraseError("invalid_request", "eraseByProject needs a project uuid or a project id");
  }
  if (!(await historyInstalled(db))) {
    return { erased: [], versions: 0, tombstones: 0, emitted: 0, eraseLamport: null, projectRefs: refs, by };
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
  // ONE item's guarded delete. The closure predicates are re-asserted per item
  // (rather than once for the whole project) so the erase can tell, item by item,
  // whether it really took this one: a store that changed between the candidate
  // read and the transaction then leaves that item wholly alone instead of
  // reporting it erased and tombstoning it.
  const itemDeleteSql = `
    DELETE FROM item_versions
     WHERE item_type = ? AND item_id = ?
       AND EXISTS (
             SELECT 1 FROM item_versions p
              WHERE p.item_type = ?
                AND p.item_id = ?
                AND p.project_ref IN (${placeholders})
           )
       AND EXISTS (
             SELECT 1 FROM item_versions latest
              WHERE latest.item_type = ?
                AND latest.item_id = ?
                AND latest.op = 'delete'
                AND NOT EXISTS (
                  SELECT 1 FROM item_versions newer
                   WHERE newer.item_type = latest.item_type
                     AND newer.item_id = latest.item_id
                     AND newer.id > latest.id
                )
           )`;
  // AN ITEM'S TOMBSTONE, written only once its versions are really gone — i.e.
  // only for an item the delete above took. It runs AFTER that delete (same armed
  // transaction), so "no versions left" is exactly "this erase emptied it".
  const itemTombstoneSql = `
    INSERT INTO ${ITEM_ERASURES_TABLE} (item_type, item_id, erased_at, erased_by, origin_instance, erase_lamport)
    SELECT ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM item_versions WHERE item_type = ? AND item_id = ?)
    ${TOMBSTONE_UPSERT}`;

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
  // Same rule as eraseItems: only items that sync may be announced, and neither a
  // Maker Lab erase nor a permanent project delete ever announces anything (a
  // purge emits nothing — spec §15). The tombstone is written bounded by this
  // instance's counter, and raised to the emitted event's lamport if one leaves.
  const bound = await readLocalLamportOrNull(db);
  const allEvents = isLocalOnlyEraseActor(by) ? [] : await eraseEventsFor(ready);
  const events = allEvents.length > 0 && (await eraseSyncEnabled(db)) ? allEvents : [];

  const statements = [];
  const spans = new Map();
  for (const item of ready) {
    const span = { deleteIndex: statements.length, tombstoneCount: 0 };
    statements.push({
      sql: itemDeleteSql,
      args: [item.itemType, item.itemId, item.itemType, item.itemId, ...refs, item.itemType, item.itemId],
    });
    for (const key of item.keys) {
      span.tombstoneCount += 1;
      statements.push({
        sql: itemTombstoneSql,
        args: [item.itemType, key, erasedAt, erasedBy, origin, bound, item.itemType, item.itemId],
      });
    }
    spans.set(`${item.itemType}\u0000${item.itemId}`, span);
  }

  const results = await withoutWriteContext(() => runArmedStatements(db, statements));

  // Only what the guarded deletes really took is reported AND announced: an item
  // the store changed under us is left alone (its tombstones were not written
  // either, see itemTombstoneSql), exactly like eraseItems' `taken`.
  const taken = new Set();
  const erased = [];
  let tombstones = 0;
  for (const item of ready) {
    const id = `${item.itemType}\u0000${item.itemId}`;
    const span = spans.get(id);
    const versions = Number(results[span?.deleteIndex]?.rowsAffected || 0);
    if (versions <= 0) continue;
    taken.add(id);
    tombstones += span.tombstoneCount;
    erased.push({ itemType: item.itemType, itemId: item.itemId, versions });
  }

  const announced = events.filter((event) => taken.has(`${event.itemType}\u0000${event.itemId}`));
  const { emitted, lamports } = await emitEraseEvents(db, announced, { syncManager, erasedAt, erasedBy });
  await bindEventTombstones(
    db,
    ready.filter((item) => taken.has(`${item.itemType}\u0000${item.itemId}`)),
    announced,
    lamports,
  );

  return {
    erased,
    versions: erased.reduce((sum, e) => sum + e.versions, 0),
    tombstones,
    emitted,
    eraseLamport: lamports.size > 0 ? Math.max(...lamports.values()) : null,
    projectRefs: refs,
    by,
  };
}

/** The newest version of one item — read INSIDE a transaction by the gates below. */
const LATEST_VERSION_SQL = `
  SELECT op, created_at, snapshot_json FROM item_versions
   WHERE item_type = ? AND item_id = ?
   ORDER BY id DESC LIMIT 1`;

/** The tombstone statements for one inbound erase (all of `keys`, one bound). */
function tombstoneStatementsFor(itemType, keys, at, by, originInstance, lamport) {
  return keys.map((key) => ({
    sql: `INSERT INTO ${ITEM_ERASURES_TABLE} (item_type, item_id, erased_at, erased_by, origin_instance, erase_lamport)
          VALUES (?, ?, ?, ?, ?, ?)
          ${TOMBSTONE_UPSERT}`,
    args: [itemType, key, at, by, originInstance, lamport],
  }));
}

/**
 * The normalized shape of an inbound erase: what to forget, what to delete, who
 * asked and at which lamport/time. Shared by applyRemoteErasure and the
 * failed-apply fallback (queueFailedRemoteErasure) so the two cannot disagree.
 */
function normalizeRemoteErasure(item, meta = {}) {
  if (!item || !item.itemType) {
    throw eraseError("invalid_request", "an inbound erase needs an itemType");
  }
  const originInstance = meta.originInstance ?? null;
  const erasedBy = typeof meta.erasedBy === "string" && meta.erasedBy !== "" ? meta.erasedBy : null;
  const lamport = Number.isFinite(Number(meta.eraseLamport)) ? Number(meta.eraseLamport) : null;
  const itemType = String(item.itemType);
  const keys = Array.isArray(item.keys) && item.keys.length > 0
    ? item.keys.map(String)
    : erasureKeys(itemType, { itemId: item.itemId ?? null, snapshot: item.snapshot ?? null });
  const entries = Array.isArray(item.items) && item.items.length > 0
    ? item.items
    : [{ itemId: item.itemId ?? null, deleteRow: item.deleteRow ?? null }];
  return {
    itemType,
    keys,
    entries,
    originInstance,
    erasedBy,
    lamport,
    by: erasedBy ?? `peer:${originInstance ?? "unknown"}`,
    // The local clock, so the restore gate compares like with like. A retry from
    // the sweep passes the marker's stored value through `applyAt`.
    at: typeof meta.applyAt === "string" && meta.applyAt !== "" ? meta.applyAt : new Date().toISOString(),
  };
}
/**
 * Apply an ERASE that arrived from a peer (instance-sync's `op === "erase"`).
 *
 * The peer's instruction is "this item must not exist on either of us": the live
 * row goes if it is here, the item's versions go through the same armed door every
 * local erase uses, and this instance records its OWN tombstone — keyed the way it
 * will later be asked about (erasureKeys), with the erasing instance as the origin
 * and the erase event's lamport as `erase_lamport`. The tombstone is the part that
 * makes the erase stick: a later restore on the peer emits an insert this instance
 * refuses (when that insert does not post-date the erase).
 *
 * ONE SYNCHRONOUS TRANSACTION, AND EVERY GATE IS INSIDE IT (the review's second
 * point). The live-row deletes, the version erase and the tombstones run in one
 * `db.runTransaction` callback — no await between them — and each live-row DELETE
 * carries its own lamport predicate (see eraseLiveRowStatements), so no local edit
 * can slip in between a read and a delete, and a RETRY of the same work (from the
 * pending-marker queue) is gated by exactly the same SQL. Three outcomes:
 *
 *   a live row that post-dates the erase   the local version wins: nothing is
 *                                          erased, nothing is tombstoned;
 *   a local-only memory (starter, Maker    never a peer's to erase: its newest
 *   Lab) — and a summary the erase does     version's snapshot says so
 *   not name by its source,
 *   otherwise                              the live row goes (its delete trigger
 *                                          writes this instance's `delete`
 *                                          version), every version of the item
 *                                          goes, and the tombstone is written. An
 *                                          item with no live row of ours left is
 *                                          touched only when it is ALREADY in this
 *                                          instance's Trash, its newest version a
 *                                          `delete` recorded at or before the
 *                                          erase; a newest version written after
 *                                          the erase (a newer local delete, a local
 *                                          re-create) is a newer local fact, so the
 *                                          erase loses entirely: nothing erased,
 *                                          nothing tombstoned.
 *
 * A FAILED APPLY IS NOT SILENTLY CONSUMED. instance-sync's feed loop advances its
 * checkpoint past an entry whose apply threw (there is no retry/hold mechanism
 * for an apply — only skip-and-log), so a failed erase would be lost entirely.
 * The fallback writes the TOMBSTONE alone (its own tiny transaction, creating
 * item_erasures if it is missing) plus a row in pending_remote_erasures naming the
 * rest of the work, which the 5-minute history sweep (sweep.js) finishes — on a
 * store with no history at all the queued work is the live-row delete itself.
 *
 * Idempotent: a re-delivered erase finds no row, no versions and an existing
 * tombstone, and changes nothing. Works on a store that has never run migration
 * 0024: the tombstone is then the whole record (and the live row still goes).
 *
 * `erased_at` is the LOCAL time this erase was applied, not the peer's clock: the
 * restore gate compares it with local versions' `created_at`, and a skewed peer
 * clock would let a pre-erase version look newer than the erase.
 *
 * @param {object} db
 * @param {{itemType: string, keys?: string[], items?: Array<{itemId: string|null,
 *   deleteRow?: {sql: string, args?: any[]}|null, newerRow?: {sql: string, args?: any[]}|null}>,
 *   itemId?: string|null, snapshot?: object|null,
 *   deleteRow?: {sql: string, args?: any[]}|null}} item
 *   `items` are the LOCAL items whose versions go (the live rows' ids here, not the
 *   sender's), each with the GATED statements that reach its live row (build them
 *   with eraseLiveRowStatements: `deleteRow` removes it if it does not post-date the
 *   erase, `newerRow` matches when one does); `keys` are the tombstone keys (see
 *   erasureKeys). The single-item `itemId`/`deleteRow` shape is accepted for callers
 *   that only have one.
 * @param {{originInstance?: string|null, erasedAt?: string|null, erasedBy?: string|null,
 *   eraseLamport?: number|null, applyAt?: string|null}} [meta] `erasedAt` here is the
 *   peer's timestamp (logged, never used as the local clock); the marker stores the
 *   local one.
 * @returns {Promise<{tombstones: number, versions: number, pending: boolean, kept: boolean}>}
 *   `kept` means the item is alive here (a newer local version, or a local-only
 *   memory) and nothing was erased: no row, no version, no tombstone.
 */
export async function applyRemoteErasure(db, item, meta = {}) {
  const { itemType, keys, entries, originInstance, lamport, by, at } = normalizeRemoteErasure(item, meta);
  await ensureErasuresTable(db);

  // A store that has not run 0024 has no versions to erase — the tombstone (and
  // the live-row delete) is still the whole record, so the erase sticks there too.
  // `versionsExist` is asked separately: versions WITHOUT the erase switch is a
  // half-installed store, where the version erase has to wait for the boot ensure.
  let installed = false;
  try {
    installed = await historyInstalled(db);
  } catch {
    installed = false; // versions exist but the switch is missing: tombstone now, finish later
  }
  const versionsExist = installed || (await tableExists(db, "item_versions"));
  const tombstoneStatements = tombstoneStatementsFor(itemType, keys, at, by, originInstance, lamport);
  const sourceTests = await memorySourceTests();
  const versionWork = entries.some((entry) => entry?.itemId !== null && entry?.itemId !== undefined);

  try {
    const outcome = await runRemoteEraseTransaction(db, {
      itemType, entries, tombstoneStatements, installed, at, keys, sourceTests,
    });
    if (outcome.kept) {
      // The local item is alive and newer (or local-only): the peer's erase loses,
      // and nothing — not even a tombstone — is written for it.
      return { tombstones: 0, versions: 0, pending: false, kept: true };
    }
    if (!installed && versionsExist && versionWork) {
      // There ARE versions here, and no switch to erase them through (the history
      // tables are half-installed). The tombstone and the delete landed; the queue
      // row is what gets the version erase finished once the boot ensure has
      // repaired the switch.
      await queueRemoteErasure(db, { itemType, keys, entries, at, by, originInstance, lamport }).catch((err) => {
        console.warn("[history] could not record a pending inbound erase:", err?.message ?? err);
      });
      return { tombstones: keys.length, versions: outcome.versions, pending: true, kept: false };
    }
    return { tombstones: keys.length, versions: outcome.versions, pending: false, kept: false };
  } catch (err) {
    console.warn(
      `[history] the erase of ${itemType} from ${originInstance ?? "a peer"} could not be applied in one transaction ` +
        `(peer reported ${meta.erasedAt ?? "no time"}): ${err?.message ?? err} — tombstoning now, finishing by the sweep`,
    );
    // The tombstone first: it is the part that makes the erase stick, and it must
    // not be lost. Then the marker that names the rest of the work.
    const tombstones = await writeTombstonesAndQueue(db, {
      itemType, keys, entries, at, by, originInstance, lamport,
    });
    return { tombstones, versions: 0, pending: true, kept: false };
  }
}

/**
 * THE FALLBACK FOR AN APPLY THAT COULD NOT EVEN START (the review's eighth point).
 *
 * instance-sync's `_applyErase` can throw before it ever reaches
 * applyRemoteErasure — a failed key lookup, an unreadable store — and the feed loop
 * consumes the entry either way. So the tombstone is written bounded to the event's
 * lamport (the part that must never be lost) and a pending marker names whatever
 * work the caller could name, which the sweep retries.
 *
 * @param {object} db
 * @param {object} item see applyRemoteErasure
 * @param {object} [meta] see applyRemoteErasure
 * @returns {Promise<{tombstones: number, versions: number, pending: boolean}>}
 */
export async function queueFailedRemoteErasure(db, item, meta = {}) {
  const { itemType, keys, entries, originInstance, lamport, by, at } = normalizeRemoteErasure(item, meta);
  await ensureErasuresTable(db);
  const tombstones = await writeTombstonesAndQueue(db, {
    itemType, keys, entries, at, by, originInstance, lamport,
  });
  return { tombstones, versions: 0, pending: true };
}

/**
 * The tombstone alone, then a marker for the rest — the failed-apply fallback.
 * Both halves are best effort: the caller has already logged the failure, and a
 * tombstone that cannot be written must not throw out of an apply loop.
 */
async function writeTombstonesAndQueue(db, { itemType, keys, entries, at, by, originInstance, lamport }) {
  let tombstoned = false;
  try {
    await db.batch(tombstoneStatementsFor(itemType, keys, at, by, originInstance, lamport));
    tombstoned = true;
  } catch (err) {
    console.error(
      `[history] the tombstone for an inbound erase of ${itemType} could not be written either: `,
      err?.message ?? err,
    );
  }
  // The LIVE-ROW delete is retried too, whatever the store says about history: on a
  // store with no history at all that delete IS the whole erase, and its failure is
  // usually what brought us here.
  const hasWork = entries.some((entry) => entry?.deleteRow) || entries.some((entry) => entry?.itemId != null);
  if (hasWork) {
    try {
      await queueRemoteErasure(db, { itemType, keys, entries, at, by, originInstance, lamport });
    } catch (queueErr) {
      console.error("[history] could not record a pending inbound erase:", queueErr?.message ?? queueErr);
    }
  }
  return tombstoned ? keys.length : 0;
}

/**
 * The one transaction an inbound erase is: arm → gates → live-row deletes →
 * version erase → tombstones → disarm. `runTransaction` hands a SYNCHRONOUS
 * runner, so nothing can await inside it (see servers/db.js).
 *
 * A client without `runTransaction` cannot branch between statements, so it takes
 * the CONSERVATIVE shape: the gated live-row deletes, only the versions at or
 * before the erase, then the tombstones. (The production client is servers/db.js,
 * which always has runTransaction; this keeps a shim working rather than failing
 * the erase.)
 *
 * @returns {Promise<{kept: boolean, versions: number}>}
 */
async function runRemoteEraseTransaction(db, { itemType, entries, tombstoneStatements, installed, at, keys, sourceTests }) {
  if (typeof db.runTransaction !== "function") {
    const statements = [];
    for (const entry of entries) if (entry?.deleteRow) statements.push(entry.deleteRow);
    let versionDeletes = 0;
    if (installed) {
      for (const entry of entries) {
        if (entry?.itemId === null || entry?.itemId === undefined) continue;
        statements.push({ sql: DELETE_ITEM_VERSIONS_UP_TO_SQL, args: [itemType, String(entry.itemId), at] });
        versionDeletes += 1;
      }
    }
    statements.push(...tombstoneStatements);
    const results = await withoutWriteContext(() =>
      installed ? runArmedStatements(db, statements) : db.batch(statements),
    );
    const versions = results
      .slice(0, versionDeletes)
      .reduce((sum, result) => sum + Number(result?.rowsAffected || 0), 0);
    return { kept: false, versions };
  }

  return withoutWriteContext(() =>
    db.runTransaction((run) => {
      if (installed) run({ sql: "UPDATE item_versions_erase SET armed = 1", args: [] });
      try {
        // (1) A live row that POST-DATES the erase. Its predicate is in the SQL,
        // so this is the same judgement the DELETE below makes — no window between.
        for (const entry of entries) {
          if (entry?.newerRow && run(entry.newerRow).rows.length > 0) return { kept: true, versions: 0 };
        }
        // (2) A local-only memory is never a peer's to erase, and the fact lives in
        // its newest SNAPSHOT (a trashed row has no live row to read a source from).
        // Read inside the same transaction, before anything is deleted. A session
        // SUMMARY is only protected when the erase did NOT name its source: that
        // source is the summary's portable identity, so an erase that carries it is
        // about this very item (id-keyed erases and id collisions are not).
        if (installed && itemType === "memory") {
          for (const entry of entries) {
            if (entry?.itemId === null || entry?.itemId === undefined) continue;
            const latest = run({ sql: LATEST_VERSION_SQL, args: [itemType, String(entry.itemId)] }).rows[0];
            if (!latest) continue;
            let snapshot = null;
            try {
              snapshot = JSON.parse(latest.snapshot_json);
            } catch {
              snapshot = null;
            }
            if (!snapshot) continue;
            const source = snapshot.source;
            const isSummary = sourceTests.isSummary(source);
            const namedBySource =
              isSummary &&
              erasureKeys("memory", { itemId: entry.itemId, snapshot }).some((key) => keys.includes(key));
            if (sourceTests.isLocalOnly(source) || (isSummary && !namedBySource)) return { kept: true, versions: 0 };
          }
        }
        // (3) The items ALREADY in this instance's Trash are judged before anything is
        // written: only an item whose newest version is that `delete`, recorded at or
        // before the erase, is the erase's to take. A newer local fact (a local
        // re-create, a newer local delete) makes the erase lose with nothing erased
        // and nothing tombstoned. (Entries that carry a live-row delete are judged by
        // its own gate and probe below.)
        if (installed) {
          for (const entry of entries) {
            if (entry?.deleteRow || entry?.itemId === null || entry?.itemId === undefined) continue;
            const latest = run({ sql: LATEST_VERSION_SQL, args: [itemType, String(entry.itemId)] }).rows[0];
            if (!latest) continue; // nothing of this item is here: the tombstone is the record
            if (latest.op !== "delete" || typeof latest.created_at !== "string" || latest.created_at > at) {
              return { kept: true, versions: 0 };
            }
          }
        }
        // (4) The live rows: their delete triggers write the `delete` version that
        // puts the item in this instance's Trash, which is what the version erase
        // below is conditioned on.
        const deleted = new Map();
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          if (!entry?.deleteRow) continue;
          deleted.set(i, Number(run(entry.deleteRow)?.rowsAffected || 0) > 0);
        }
        // (5) Versions. ALL of them when OUR delete just took the live row (the item
        // is in the Trash and that delete version is its newest); otherwise the ones at
        // or before the erase, for an item the pre-pass above already cleared.
        let versions = 0;
        let kept = false;
        if (installed) {
          for (let i = 0; i < entries.length; i++) {
            const itemId = entries[i]?.itemId;
            if (itemId === null || itemId === undefined) continue;
            if (deleted.get(i)) {
              versions += Number(run({ sql: DELETE_ITEM_SQL, args: [itemType, String(itemId)] })?.rowsAffected || 0);
              continue;
            }
            const latest = run({ sql: LATEST_VERSION_SQL, args: [itemType, String(itemId)] }).rows[0];
            if (!latest) continue; // nothing of this item is here: the tombstone is the record
            if (latest.op !== "delete" || typeof latest.created_at !== "string" || latest.created_at > at) {
              kept = true;
              continue;
            }
            versions += Number(
              run({ sql: DELETE_ITEM_VERSIONS_UP_TO_SQL, args: [itemType, String(itemId), at] })?.rowsAffected || 0,
            );
          }
        }
        if (kept) return { kept: true, versions: 0 };
        // (6) The tombstones, last: whether the erase happened at all is decided above.
        for (const statement of tombstoneStatements) run(statement);
        return { kept: false, versions };
      } finally {
        // A COMMIT of a kept/erased outcome must never leave the switch armed; a
        // throw here rolls everything back, arm included.
        if (installed) run({ sql: "UPDATE item_versions_erase SET armed = 0", args: [] });
      }
    }),
  );
}

/**
 * The pending-marker write: the tombstone is in place and this names the rest of
 * the work for the sweep. A marker for an identical (item_type, payload) that is
 * still open is not written twice (a re-delivered erase cannot pile markers up).
 */
async function queueRemoteErasure(db, payload) {
  await db.execute(PENDING_REMOTE_ERASURES_DDL);
  const json = JSON.stringify(payload);
  const existing = await db.execute({
    sql: `SELECT id FROM ${PENDING_REMOTE_ERASURES_TABLE} WHERE item_type = ? AND payload_json = ? LIMIT 1`,
    args: [payload.itemType, json],
  });
  if (existing.rows.length > 0) return;
  await db.execute({
    sql: `INSERT INTO ${PENDING_REMOTE_ERASURES_TABLE} (item_type, payload_json) VALUES (?, ?)`,
    args: [payload.itemType, json],
  });
}

/**
 * Finish the inbound erases a failed apply left behind (the 5-minute history
 * sweep's job, see sweep.js). Each marker is retried through the SAME apply path;
 * one that succeeds is deleted, one that fails again is left in place and
 * reported.
 *
 * @param {object} db
 * @param {{limit?: number}} [opts]
 * @returns {Promise<{completed: number, failed: Array<{id: number, error: string}>}>}
 */
export async function finishPendingRemoteErasures(db, { limit = 100 } = {}) {
  const failed = [];
  let completed = 0;
  let rows = [];
  try {
    const result = await db.execute({
      sql: `SELECT id, item_type, payload_json FROM ${PENDING_REMOTE_ERASURES_TABLE}
             ORDER BY id ASC LIMIT ?`,
      args: [Math.max(1, Number(limit) || 100)],
    });
    rows = result.rows;
  } catch (err) {
    if (/no such table/i.test(String(err?.message || ""))) return { completed, failed };
    throw err;
  }
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json);
      // The marker stores the entries under `entries` (that is the apply's whole
      // `items` list: what to delete and which local ids to erase).
      const outcome = await applyRemoteErasure(
        db,
        { itemType: payload.itemType, keys: payload.keys ?? [], items: payload.entries ?? [] },
        {
          originInstance: payload.originInstance ?? null,
          erasedBy: payload.by ?? null,
          eraseLamport: payload.lamport ?? null,
          applyAt: payload.at ?? null,
        },
      );
      if (outcome.pending) throw new Error("the erase is still pending");
      await db.execute({ sql: `DELETE FROM ${PENDING_REMOTE_ERASURES_TABLE} WHERE id = ?`, args: [row.id] });
      completed += 1;
    } catch (err) {
      failed.push({ id: Number(row.id), error: String(err?.message ?? err) });
    }
  }
  return { completed, failed };
}