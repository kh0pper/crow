/**
 * erase.js — the one door through which version history is destroyed.
 *
 * item_versions is append-only by trigger (covered.js). The single legal way to
 * remove rows is the erase control table: arm `item_versions_erase`, do the
 * deletes, disarm — all INSIDE ONE immediate transaction, so no other connection
 * ever sees the switch on (in WAL an uncommitted change is invisible to them) and
 * a failure leaves the door shut rather than open.
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
 *   eraseItems(db, [{itemType, itemId}], ctx)   the caller names the items (a
 *                                               learner's memories, one Trash
 *                                               item, the integer rows a purge
 *                                               deleted);
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
 * Run `work` with the erase switch armed, inside ONE immediate transaction.
 *
 * The disarm is inside the transaction, so it commits with the deletes: a
 * process that dies mid-erase leaves the switch armed in the WAL but never
 * committed, and a store that somehow sees an armed row at boot gets it reset by
 * servers/shared/history/ensure.js. If `work` throws, the ROLLBACK undoes the
 * arm — and a second, out-of-transaction disarm is attempted anyway, because the
 * one guarantee this helper must never break is "the door is shut afterwards"
 * even when the rollback itself failed.
 *
 * CONTRACT: the caller holds no transaction. This opens its own BEGIN IMMEDIATE
 * (a caller's open transaction makes that fail, and this helper's ROLLBACK must
 * never be the thing that ends someone else's work).
 */
async function inArmedTransaction(db, work) {
  let began = false;
  try {
    await db.execute("BEGIN IMMEDIATE");
    began = true;
    await db.execute("UPDATE item_versions_erase SET armed = 1");
    const result = await work();
    await db.execute("UPDATE item_versions_erase SET armed = 0");
    await db.execute("COMMIT");
    return result;
  } catch (err) {
    if (began) {
      try {
        await db.execute("ROLLBACK");
      } catch {
        /* already rolled back (or the transaction never opened) */
      }
    }
    try {
      await db.execute("UPDATE item_versions_erase SET armed = 0");
    } catch {
      /* the store is unreadable: the boot ensure disarms a stuck switch */
    }
    throw err;
  }
}

/**
 * Erase every version of the named items.
 *
 * @param {object} db libsql-shaped client (servers/db.js)
 * @param {Array<{itemType: string, itemId: string|number}>} items
 * @param {{authorKind: string, authorId?: string}} ctx a real owner or system actor
 * @returns {Promise<{erased: Array<{itemType: string, itemId: string, versions: number}>,
 *   versions: number, by: {authorKind: string, authorId: string|null}}>}
 *   `versions` per item is what the erase actually removed (0 for an item that
 *   had none — an idempotent repeat of an erase, which is not an error).
 */
export async function eraseItems(db, items, ctx) {
  const by = assertEraseActor(ctx);
  const wanted = normalizeItems(items);
  if (wanted.length === 0) return { erased: [], versions: 0, by };

  const erased = await withoutWriteContext(() =>
    inArmedTransaction(db, async () => {
      const out = [];
      for (const item of wanted) {
        const r = await db.execute({
          sql: "DELETE FROM item_versions WHERE item_type = ? AND item_id = ?",
          args: [item.itemType, item.itemId],
        });
        out.push({ ...item, versions: Number(r.rowsAffected || 0) });
      }
      return out;
    }),
  );

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

  const erased = await withoutWriteContext(() =>
    inArmedTransaction(db, async () => {
      const placeholders = refs.map(() => "?").join(", ");
      const { rows: candidates } = await db.execute({
        sql: `SELECT DISTINCT item_type, item_id FROM item_versions WHERE project_ref IN (${placeholders})`,
        args: refs,
      });
      const out = [];
      for (const candidate of candidates) {
        const itemType = String(candidate.item_type);
        const itemId = String(candidate.item_id);
        const { rows: latest } = await db.execute({
          sql: `SELECT op FROM item_versions WHERE item_type = ? AND item_id = ? ORDER BY id DESC LIMIT 1`,
          args: [itemType, itemId],
        });
        // A live item's history stays: the project delete did not remove it.
        if (latest[0]?.op !== "delete") continue;
        const r = await db.execute({
          sql: "DELETE FROM item_versions WHERE item_type = ? AND item_id = ?",
          args: [itemType, itemId],
        });
        out.push({ itemType, itemId, versions: Number(r.rowsAffected || 0) });
      }
      return out;
    }),
  );

  return { erased, versions: erased.reduce((sum, e) => sum + e.versions, 0), projectRefs: refs, by };
}