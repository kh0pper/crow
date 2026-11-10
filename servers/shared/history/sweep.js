/**
 * sweep.js — the periodic pass that keeps history honest and small: redact,
 * coalesce, erase.
 *
 * Three jobs, in this order, each bounded so a big table never blocks a boot or a
 * request (the design §8.8 budget):
 *
 *   (a) REDACT. A secret must never sit in the version table a second time. The
 *       capture triggers cannot do this (SQLite has no `regexp` on a raw
 *       connection, and a trigger that fell back to LIKE would store the secret
 *       anyway — see covered.js), so the scan happens here in JavaScript against
 *       the SAME patterns CI uses for this public repository
 *       (scripts/check-public-hygiene.mjs's SECRET_PATTERNS). A matching
 *       snapshot_json is rewritten with "[redacted]" in place of each match and
 *       the row is marked redacted = 1 — which api.js then refuses to restore,
 *       because the row no longer holds the item's value.
 *       LIVE DATA IS NOT HISTORY'S BUSINESS: the memory, post or section itself
 *       keeps its text. Only the stored versions are rewritten.
 *       Rewriting a version is a history edit, so it goes through the armed
 *       switch (covered.js), one transaction per batch: arm → update → disarm.
 *
 *   (b) COALESCE. Rapid saves by the same author on the same item are one
 *       version, not twenty (§8.8: within 2 minutes). Only CONSECUTIVE `update`
 *       versions of one item with the same author and job, less than 120 s apart,
 *       and never a redacted row (that is evidence, not noise) — the earlier of
 *       the pair goes. Deletes need the armed switch, like every other history
 *       write.
 *
 *   (c) ERASE. An item that has been in the Trash longer than the Trash period is
 *       erased for real — every version of it, through erase.js's armed door. The
 *       Trash period is a local setting (history.trash_days, default 30).
 *
 * RETENTION. `history.retention` defaults to `forever`, and `forever` keeps
 * everything. Any other value is currently a NO-OP: a thinning schedule is not
 * specified yet, so this pass reports the value it saw and changes nothing. It
 * must not throw on an unexpected value — a settings typo may never stop the
 * redaction or the Trash clock.
 *
 * BOUNDED AND EVENTUALLY COMPLETE. Each pass walks at most `batchSize` rows, by
 * id, continuing from a per-connection cursor (a WeakMap keyed by the db handle,
 * so an in-process caller that keeps one handle — the gateway's sweep does —
 * keeps making progress across runs while a fresh handle restarts from the
 * beginning). Redaction walks the backlog from the cursor AND scans the newest
 * batch, so a secret written a minute ago is caught by the next run while the
 * older rows are still covered over time. A full walk is idempotent: redacted
 * rows are excluded and a coalesce pair is gone after the first pass.
 */
import { SECRET_PATTERNS } from "../../../scripts/check-public-hygiene.mjs";
import { withoutWriteContext } from "./write-context.js";
import { eraseItems } from "./erase.js";
import { trashEntries, normalizeTrashDays, DEFAULT_TRASH_DAYS } from "./trash.js";

/** Rows per pass when the caller does not say. */
export const DEFAULT_BATCH = 500;

/** The only retention value that is applied today. */
export const RETENTION_FOREVER = "forever";

/** What a matched secret becomes. */
export const REDACTION_PLACEHOLDER = "[redacted]";

/** Two saves this close together, by the same author on the same item, are one. */
export const COALESCE_WINDOW_MS = 120_000;

const MS_PER_DAY = 86_400_000;

/** Per-handle scan cursors: db → { redact: lastId, coalesce: lastId }. */
const CURSORS = new WeakMap();

function cursorFor(db) {
  let cursor = CURSORS.get(db);
  if (!cursor) {
    cursor = { redact: 0, coalesce: 0 };
    CURSORS.set(db, cursor);
  }
  return cursor;
}

/** The batch size actually used: a positive integer, else the default. */
function normalizeBatch(batchSize) {
  const n = Math.trunc(Number(batchSize));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BATCH;
}

/**
 * Replace every secret-shaped match in `text` with the placeholder.
 * @returns {string|null} the rewritten text, or null when nothing matched
 */
export function redactText(text) {
  if (typeof text !== "string" || text === "") return null;
  let out = text;
  let hit = false;
  for (const [, pattern] of SECRET_PATTERNS) {
    // String#replace resets a global regex's lastIndex itself, so the shared
    // pattern objects are safe to reuse across rows and runs.
    const next = out.replace(pattern, REDACTION_PLACEHOLDER);
    if (next !== out) {
      out = next;
      hit = true;
    }
  }
  return hit ? out : null;
}

/**
 * Are the history tables there? A store that has not run migration 0024 (it
 * defers until the covered tables exist) has nothing to sweep, and a pass that
 * threw "no such table" every five minutes would bury a real failure in noise.
 */
async function historyReady(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('item_versions', 'item_versions_erase')",
      args: [],
    });
    return rows.length === 2;
  } catch {
    return false;
  }
}

/** Run `work` with the erase switch armed, in one immediate transaction. */
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
        /* already rolled back */
      }
    }
    try {
      await db.execute("UPDATE item_versions_erase SET armed = 0");
    } catch {
      /* unreadable store: the boot ensure disarms a stuck switch */
    }
    throw err;
  }
}

/* ------------------------------------------------------------- (a) redact */

/** Redact one page of versions. @returns {Promise<number>} rows rewritten */
async function redactPage(db, rows) {
  const matches = [];
  for (const row of rows) {
    const rewritten = redactText(row.snapshot_json);
    if (rewritten !== null) matches.push({ id: Number(row.id), snapshot: rewritten });
  }
  if (matches.length === 0) return 0;
  await withoutWriteContext(() =>
    inArmedTransaction(db, async () => {
      for (const match of matches) {
        await db.execute({
          sql: "UPDATE item_versions SET snapshot_json = ?, redacted = 1 WHERE id = ?",
          args: [match.snapshot, match.id],
        });
      }
    }),
  );
  return matches.length;
}

/**
 * One redaction pass: continue the backlog walk from the cursor, then scan the
 * newest batch (so a secret written since the last run is caught at once).
 */
async function redactPass(db, batchSize) {
  const cursor = cursorFor(db);
  const backlog = await db.execute({
    sql: `SELECT id, snapshot_json FROM item_versions
           WHERE redacted = 0 AND id > ?
           ORDER BY id ASC LIMIT ?`,
    args: [cursor.redact, batchSize],
  });
  let redacted = await redactPage(db, backlog.rows);
  if (backlog.rows.length > 0) {
    cursor.redact = Number(backlog.rows[backlog.rows.length - 1].id);
  } else if (cursor.redact > 0) {
    // The walk reached the end: start the next one from the top. Rows written
    // meanwhile have higher ids and are scanned by the newest-batch pass below.
    cursor.redact = 0;
  }

  const newest = await db.execute({
    sql: `SELECT id, snapshot_json FROM item_versions
           WHERE redacted = 0
           ORDER BY id DESC LIMIT ?`,
    args: [batchSize],
  });
  redacted += await redactPage(db, newest.rows);
  return redacted;
}

/* ----------------------------------------------------------- (b) coalesce */

const isMillis = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));

/**
 * Are these two versions of one item one save? Both updates, by the same named
 * author in the same job, less than COALESCE_WINDOW_MS apart, neither redacted.
 * An unattributed pair (author_id NULL) is never coalesced: "the same author" is
 * unknowable, and guessing would delete history nothing accounts for.
 */
export function coalescible(older, newer) {
  if (!older || !newer) return false;
  if (older.op !== "update" || newer.op !== "update") return false;
  if (Number(older.redacted) === 1 || Number(newer.redacted) === 1) return false;
  if (older.author_id == null || older.author_id !== newer.author_id) return false;
  if ((older.job_id ?? null) !== (newer.job_id ?? null)) return false;
  if (!isMillis(older.created_at) || !isMillis(newer.created_at)) return false;
  return Math.abs(Date.parse(newer.created_at) - Date.parse(older.created_at)) < COALESCE_WINDOW_MS;
}

/** One coalescing pass. @returns {Promise<number>} versions removed */
async function coalescePass(db, batchSize) {
  const cursor = cursorFor(db);
  const { rows } = await db.execute({
    sql: `SELECT id, item_type, item_id, op, author_id, job_id, created_at, redacted
            FROM item_versions
           WHERE id > ?
           ORDER BY id ASC LIMIT ?`,
    args: [cursor.coalesce, batchSize],
  });
  if (rows.length === 0) {
    cursor.coalesce = 0;
    return 0;
  }

  const doomed = new Set();
  for (const row of rows) {
    const { rows: prior } = await db.execute({
      sql: `SELECT id, item_type, item_id, op, author_id, job_id, created_at, redacted
              FROM item_versions
             WHERE item_type = ? AND item_id = ? AND id < ?
             ORDER BY id DESC LIMIT 1`,
      args: [row.item_type, row.item_id, Number(row.id)],
    });
    if (!prior.length) continue;
    if (coalescible(prior[0], row)) doomed.add(Number(prior[0].id));
  }
  const nextCursor = Number(rows[rows.length - 1].id);
  if (doomed.size === 0) {
    cursor.coalesce = nextCursor;
    return 0;
  }

  const ids = [...doomed];
  await withoutWriteContext(() =>
    inArmedTransaction(db, async () => {
      await db.execute({
        sql: `DELETE FROM item_versions WHERE id IN (${ids.map(() => "?").join(", ")})`,
        args: ids,
      });
    }),
  );
  // Only past a batch that actually landed: a failed delete leaves the pair for the
  // next run (it stays history, which is the safe direction).
  cursor.coalesce = nextCursor;
  return ids.length;
}

/* -------------------------------------------------------------- (c) erase */

/** Erase the Trash items older than the period, in one bounded page. */
async function erasePass(db, { now, trashDays, batchSize }) {
  const cutoff = new Date(now.getTime() - normalizeTrashDays(trashDays) * MS_PER_DAY).toISOString();
  const entries = await trashEntries(db, { before: cutoff, limit: batchSize });
  if (entries.length === 0) return { erased: [], versions: 0, cutoff };
  const { erased, versions } = await eraseItems(
    db,
    entries.map((e) => ({ itemType: e.itemType, itemId: e.itemId })),
    // The Trash clock is Crow's own unit of work: no person is pressing a button.
    { authorKind: "system", authorId: "history-sweep" },
  );
  return { erased, versions, cutoff };
}

/**
 * One sweep.
 *
 * Never throws for a configuration value: an unusable `trashDays` falls back to
 * the default, and any `retention` other than "forever" is reported and not
 * applied. Errors from the database DO propagate — the boot caller catches and
 * logs them, and a failed pass must not look like a clean one.
 *
 * @param {object} db
 * @param {{now?: Date, trashDays?: number, retention?: string, batchSize?: number}} [opts]
 * @returns {Promise<{redacted: number, coalesced: number,
 *   erased: Array<{itemType: string, itemId: string, versions: number}>,
 *   erasedVersions: number, retention: {value: string, applied: boolean},
 *   trashDays: number, batchSize: number}>}
 */
export async function sweep(db, { now = new Date(), trashDays = DEFAULT_TRASH_DAYS, retention = RETENTION_FOREVER, batchSize = DEFAULT_BATCH } = {}) {
  const batch = normalizeBatch(batchSize);
  const days = normalizeTrashDays(trashDays);
  const retentionValue = typeof retention === "string" && retention.trim() !== "" ? retention.trim() : RETENTION_FOREVER;
  const base = {
    redacted: 0,
    coalesced: 0,
    erased: [],
    erasedVersions: 0,
    // Only `forever` is applied; anything else is a no-op until a thinning
    // schedule is specified (the design §8.9 / the plan's Task 4 note).
    retention: { value: retentionValue, applied: retentionValue === RETENTION_FOREVER },
    trashDays: days,
    batchSize: batch,
  };
  if (!(await historyReady(db))) return { ...base, skipped: "item_versions absent" };

  // A sweep is nobody's unit of work: nothing it writes is attributed to whoever
  // happened to be on the stack when the interval fired.
  return withoutWriteContext(async () => {
    const redacted = await redactPass(db, batch);
    const coalesced = await coalescePass(db, batch);
    const erasedResult = await erasePass(db, { now, trashDays: days, batchSize: batch });
    return {
      ...base,
      redacted,
      coalesced,
      erased: erasedResult.erased,
      erasedVersions: erasedResult.versions,
    };
  });
}