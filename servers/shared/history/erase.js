/**
 * erase.js — the one door through which version history is destroyed.
 *
 * item_versions is append-only by trigger (covered.js). The single legal way to
 * remove rows is the erase control table: arm `item_versions_erase`, do the
 * deletes, disarm — all INSIDE ONE transaction, so no other connection ever sees
 * the switch on (in WAL an uncommitted change is invisible to them) and a
 * failure leaves the door shut rather than open.
 *
 * Three callers, and no others:
 *   - the operator emptying the Trash / a Trash item ageing out (trash.js, sweep.js);
 *   - a permanent delete that must forget at once (the operator's ruling,
 *     2026-11-10): Maker Lab's learner delete and the project purge, so a
 *     right-to-be-forgotten promise is not held hostage to a 30-day Trash;
 *   - a test.
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
 */
import { withoutWriteContext } from "./write-context.js";

/** The author kinds an erase may run as. Anything else is refused, loudly. */
export const ERASE_ACTOR_KINDS = Object.freeze(["owner", "system"]);

/** How many items one erase statement batch may name (a bound, not a policy). */
const MAX_ITEMS = 1000;

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
 * The guarded delete: every version of the item, but only while its LATEST
 * version is still a `delete` recorded at or before the cutoff. A restore that
 * lands after the listing writes a newer version, so this matches nothing and
 * the restored item's history survives.
 */
const DELETE_TRASH_ITEM_SQL = `
  DELETE FROM item_versions
   WHERE item_type = ? AND item_id = ?
     AND EXISTS (
       SELECT 1 FROM item_versions latest
        WHERE latest.item_type = item_versions.item_type
          AND latest.item_id = item_versions.item_id
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
 * Erase every version of the named items.
 *
 * @param {object} db libsql-shaped client (servers/db.js)
 * @param {Array<{itemType: string, itemId: string|number}>} items
 * @param {{authorKind: string, authorId?: string}} ctx a real owner or system actor
 * @param {{deletedBefore?: string|null}} [opts] when set, erase an item only if
 *   its latest version is still a `delete` at or before this ISO timestamp (the
 *   Trash clock). The whole item's versions go when it matches.
 * @returns {Promise<{erased: Array<{itemType: string, itemId: string, versions: number}>,
 *   versions: number, by: {authorKind: string, authorId: string|null}}>}
 *   `versions` per item is what the erase actually removed (0 for an item that
 *   had none — an idempotent repeat of an erase, which is not an error).
 */
export async function eraseItems(db, items, ctx, { deletedBefore = null } = {}) {
  const by = assertEraseActor(ctx);
  const wanted = normalizeItems(items);
  if (wanted.length === 0) return { erased: [], versions: 0, by };
  if (!(await historyInstalled(db))) return { erased: [], versions: 0, by };

  const cutoff = typeof deletedBefore === "string" && deletedBefore !== "" ? deletedBefore : null;
  const statements = wanted.map((item) =>
    cutoff === null
      ? { sql: DELETE_ITEM_SQL, args: [item.itemType, item.itemId] }
      : { sql: DELETE_TRASH_ITEM_SQL, args: [item.itemType, item.itemId, cutoff] },
  );

  const results = await withoutWriteContext(() => runArmedStatements(db, statements));
  const erased = wanted.map((item, i) => ({ ...item, versions: Number(results[i]?.rowsAffected || 0) }));

  return { erased, versions: erased.reduce((sum, e) => sum + e.versions, 0), by };
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
 * One conditional DELETE does the work (with a same-transaction SELECT for the
 * per-item report), so nothing can be restored between the candidate lookup and
 * the erase.
 *
 * @param {object} db
 * @param {{projectUuid?: string|null, projectId?: string|number|null}} project
 * @param {{authorKind: string, authorId?: string}} ctx
 * @returns {Promise<{erased: Array<{itemType: string, itemId: string, versions: number}>,
 *   versions: number, projectRefs: string[], by: object}>}
 */
export async function eraseByProject(db, project = {}, ctx) {
  const by = assertEraseActor(ctx);
  const refs = projectRefs(project);
  if (refs.length === 0) {
    throw eraseError("invalid_request", "eraseByProject needs a project uuid or a project id");
  }
  if (!(await historyInstalled(db))) return { erased: [], versions: 0, projectRefs: refs, by };

  const placeholders = refs.map(() => "?").join(", ");
  // The latest version is the one with no newer row; `latest.op = 'delete'` is
  // the whole safety rule (an unfiled memory's latest version is an update).
  const candidateSql = `
    SELECT v.item_type, v.item_id, COUNT(*) AS versions
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

  const results = await withoutWriteContext(() =>
    runArmedStatements(db, [
      { sql: candidateSql, args: refs },
      { sql: deleteSql, args: refs },
    ]),
  );
  const erased = (results[0]?.rows ?? []).map((row) => ({
    itemType: String(row.item_type),
    itemId: String(row.item_id),
    versions: Number(row.versions || 0),
  }));

  return { erased, versions: erased.reduce((sum, e) => sum + e.versions, 0), projectRefs: refs, by };
}