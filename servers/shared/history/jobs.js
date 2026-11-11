/**
 * jobs.js — "Undo this job": put back everything one unit of work changed.
 *
 * A job is what already identifies a bot's unit of work (the version history
 * design §8.1): a board card (`card:<id>`), else a voice hand-off
 * (`handoff:<id>`), else a chat/Perch turn (`turn:<id>`), else the owner's
 * dashboard session (`session:<hash8>`). The gateway stamps that id onto every
 * version it writes inside the job's write context, so "what did this job do?"
 * is one indexed read — and it also covers the bot's writes that reached the DB
 * through the gateway's client rather than a tool the job called itself.
 *
 * THE CONFLICT RULE (§8.5). An item is skipped, not overwritten, when a newer
 * version exists that is NOT this job's — the owner's later edit, or the same
 * bot's later job. Undo is partial by design: it restores what it can and names
 * what it could not, with a reason a caller can show and a per-item Restore link
 * for the rest. Silently clobbering newer work would be the exact loss this
 * feature exists to prevent.
 *
 * Two shapes of undo, per item:
 *   - the job's first version there was an `insert` → the job created the item,
 *     so undo deletes the row. That lands it in the Trash (the capture trigger
 *     writes the `delete` version), so an undo of a creation is still undoable;
 *   - otherwise → restore the version immediately BEFORE the job's first version
 *     for that item, through api.js's restoreVersion, so the undo is itself a new
 *     version and everything after it stays in the History list.
 *
 * A version written by a peer (`peer`) or a schedule (`system`) is a "later
 * version from someone else" like any other: the undo stops there.
 *
 * STUDIO SONGS ARE LISTED AND NEVER RESTORED. A song keeps its own, richer edit
 * log (Yjs plus the bundle's studio_history, with inverse operations), so History
 * does not hold its versions and must not try to put one back: the undo result
 * names the song with reason `own_undo` and a link to the song's own page, where
 * the operator undoes an edit on the song itself (the same rule the design gives
 * artifacts and Studio: §8.7).
 *
 * AND ITS ONE HONEST LIMIT: studio_history records WHICH BOT edited a song
 * (`author_id` = `bot:<id>`) but not WHICH JOB it was working on — the Studio MCP
 * server runs in its own process and never sees a card, hand-off or turn id. So a
 * job's songs are found by the tightest linkage that exists: rows written by the
 * job's OWN bot inside the job's OWN write window (the span of the versions that
 * job wrote here). Two jobs of the same bot running at overlapping moments can
 * therefore list each other's song, which is why this is a READ-ONLY report of
 * "log in and undo it there" and never a write. Nothing is invented: no table, no
 * column, and no attribution Crow does not already have.
 */
import { COVERED } from "./covered.js";
import { AUTHOR_KINDS, withWriteContext } from "./write-context.js";
import { restoreVersion } from "./api.js";

/** Why an item was not undone. `edited_after` is the design's named reason. */
export const UNDO_REASONS = Object.freeze({
  /** a newer version exists that is not this job's */
  EDITED_AFTER: "edited_after",
  /** the version to put back was redacted by the sweep, so it no longer holds the value */
  REDACTED: "redacted",
  /** the row this undo would restore cannot exist beside what is there now */
  CONFLICT: "conflict",
  /** the item type is not covered by history (a Studio song, or a later task's type) */
  UNSUPPORTED: "unsupported",
  /** the job's oldest version for the item is an update with nothing before it */
  NO_PRIOR_VERSION: "no_prior_version",
  /** a Studio song: its own History has the undo, so this one never restores it */
  OWN_UNDO: "own_undo",
  /** anything unexpected: the item is reported, never silently counted as undone */
  FAILED: "failed",
});

/** The item type a Studio song is reported under (never a COVERED type). */
export const STUDIO_SONG_ITEM_TYPE = "studio_song";

/** Where a song's own page lives (its History and its per-step Undo). */
export function studioSongLink(songId) {
  return `/dashboard/studio?song=${encodeURIComponent(String(songId))}`;
}

function jobError(code, message) {
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

/** SQL identifier quoting (nothing here is user input, but stay exact). */
const quote = (ident) => `"${String(ident).replace(/"/g, '""')}"`;

/** The reason a refusal maps to: a known code, else `failed`. */
function reasonFor(err) {
  const code = err && typeof err.code === "string" ? err.code : null;
  if (code === "redacted") return UNDO_REASONS.REDACTED;
  if (code === "conflict") return UNDO_REASONS.CONFLICT;
  if (code === "unsupported") return UNDO_REASONS.UNSUPPORTED;
  return UNDO_REASONS.FAILED;
}

/**
 * The Studio songs a job touched, as entries for the undo result.
 *
 * `studio_history` (the Studio bundle's table, in crow.db) records the author of
 * every song edit but no job id, so the linkage is the narrowest one available:
 * rows authored by the JOB's own bot (`bot:<authorId>`) whose `created_at` falls
 * inside the window the job's own versions span. See the module comment for the
 * limit that implies; the entry is read-only, so a false positive only offers a
 * link to the song.
 *
 * Never throws: a store without the Studio tables (the bundle is not installed)
 * has no songs, which is the honest answer, not an error.
 *
 * @param {object} db
 * @param {{authorId: string|null, from: string|null, to: string|null}} window
 * @returns {Promise<Array<{itemType: string, itemId: string, skipped: true,
 *   reason: string, link: string, label: string}>>}
 */
export async function studioSongsTouchedBy(db, { authorId = null, from = null, to = null } = {}) {
  const bot = str(authorId);
  if (bot === null || typeof from !== "string" || typeof to !== "string") return [];
  try {
    const { rows } = await db.execute({
      sql: `SELECT song_id, MAX(created_at) AS at
              FROM studio_history
             WHERE author_id = ? AND created_at >= ? AND created_at <= ?
             GROUP BY song_id
             ORDER BY at DESC
             LIMIT 50`,
      args: [`bot:${bot}`, from, to],
    });
    const out = [];
    for (const row of rows) {
      const songId = str(row.song_id);
      if (songId === null) continue;
      let label = songId;
      try {
        const { rows: songRows } = await db.execute({
          sql: "SELECT title FROM studio_songs WHERE id = ?",
          args: [songId],
        });
        const title = str(songRows[0]?.title);
        if (title !== null) label = title;
      } catch {
        // no studio_songs table: the id is the label, which is honest
      }
      out.push({
        itemType: STUDIO_SONG_ITEM_TYPE,
        itemId: songId,
        skipped: true,
        reason: UNDO_REASONS.OWN_UNDO,
        link: studioSongLink(songId),
        label,
      });
    }
    return out;
  } catch {
    return []; // no studio tables on this instance: no songs, not a failure
  }
}

/**
 * Undo one job.
 *
 * @param {object} db
 * @param {{jobId: string, syncManager?: object|null}} job `syncManager` is the
 *   process's InstanceSyncManager when it has one: a restore is an ordinary write,
 *   so it emits like one (see api.js's restoreVersion). The result follows the
 *   restore's own SYNC rule: an undo with no emitter still writes, and the caller
 *   is told `synced: false` rather than being told nothing.
 * @param {{authorKind: string, authorId?: string, jobId?: string}} ctx who is undoing
 *   (a real author: the undo is a write, and it is attributed like any other)
 * @returns {Promise<{restored: Array<{itemType: string, itemId: string,
 *   action: 'restored'|'deleted'|'unchanged', newVersionId: number|null,
 *   synced?: boolean, unfiled?: boolean}>,
 *   skipped: Array<{itemType: string, itemId: string, reason: string, message?: string,
 *   skipped?: true, link?: string, label?: string}>}>} a Studio song appears in
 *   `skipped` with reason `own_undo`, `skipped: true` and a `link` to the song's
 *   own page — History never restores one (see studioSongsTouchedBy).
 */
export async function undoJob(db, { jobId, syncManager = null } = {}, ctx) {
  if (!ctx || typeof ctx !== "object" || !AUTHOR_KINDS.includes(ctx.authorKind)) {
    throw jobError(
      "invalid_context",
      "undoing a job must name who is undoing it (authorKind owner, bot, peer or system)",
    );
  }
  const job = str(jobId);
  if (job === null) throw jobError("invalid_request", "undoJob needs a jobId");
  // The undo is its own unit of work. Without this, a caller that passed the
  // undone job's id in `ctx` would stamp the undo's versions with the job being
  // undone, and a second Undo would try to undo its own repair.
  const undoCtx = { ...ctx, jobId: `undo:${job}` };

  // Every item the job touched, and the id of the FIRST version it wrote for
  // each: that id is the boundary between "before the job" and "the job".
  const { rows: touched } = await db.execute({
    sql: `SELECT item_type, item_id, MIN(id) AS first_id
            FROM item_versions
           WHERE job_id = ?
        GROUP BY item_type, item_id
        ORDER BY first_id`,
    args: [job],
  });

  const restored = [];
  const skipped = [];

  for (const row of touched) {
    const itemType = String(row.item_type);
    const itemId = String(row.item_id);
    const firstId = Number(row.first_id);
    const spec = COVERED[itemType];
    if (!spec) {
      skipped.push({ itemType, itemId, reason: UNDO_REASONS.UNSUPPORTED });
      continue;
    }

    // A newer version from anyone but this job means someone else has worked on
    // the item since: the undo stops here rather than overwriting that work.
    const { rows: later } = await db.execute({
      sql: `SELECT id FROM item_versions
             WHERE item_type = ? AND item_id = ? AND id > ?
               AND (job_id IS NULL OR job_id <> ?)
             LIMIT 1`,
      args: [itemType, itemId, firstId, job],
    });
    if (later.length > 0) {
      skipped.push({ itemType, itemId, reason: UNDO_REASONS.EDITED_AFTER });
      continue;
    }

    const { rows: first } = await db.execute({
      sql: "SELECT op FROM item_versions WHERE id = ?",
      args: [firstId],
    });
    const firstOp = first[0]?.op ?? null;

    try {
      if (firstOp === "insert") {
        // The job created the item: undo removes it, which the capture trigger
        // turns into a `delete` version — so it waits in the Trash like any
        // other deletion instead of vanishing mid-undo.
        const r = await withWriteContext(undoCtx, () =>
          db.execute({
            sql: `DELETE FROM ${quote(spec.table)} WHERE ${quote(spec.idColumn)} = ?`,
            args: [itemId],
          }),
        );
        restored.push({ itemType, itemId, action: "deleted", newVersionId: null, rowsAffected: Number(r.rowsAffected || 0) });
        continue;
      }

      const { rows: before } = await db.execute({
        sql: `SELECT id FROM item_versions
               WHERE item_type = ? AND item_id = ? AND id < ?
               ORDER BY id DESC LIMIT 1`,
        args: [itemType, itemId, firstId],
      });
      if (!before.length) {
        // An update with nothing before it: the item's pre-job value was never
        // recorded (a store that lost its baseline), so there is nothing honest
        // to write back.
        skipped.push({ itemType, itemId, reason: UNDO_REASONS.NO_PRIOR_VERSION });
        continue;
      }

      const result = await restoreVersion(db, { versionId: Number(before[0].id), syncManager }, undoCtx);
      restored.push({
        itemType,
        itemId,
        action: result.unchanged ? "unchanged" : "restored",
        newVersionId: result.newVersionId,
        synced: result.synced,
        unfiled: result.unfiled,
      });
    } catch (err) {
      skipped.push({ itemType, itemId, reason: reasonFor(err), message: err?.message });
    }
  }

  return { restored, skipped: [...skipped, ...(await studioSongEntries(db, job))] };
}

/**
 * The Studio song entries for one job's undo result (see studioSongsTouchedBy).
 *
 * A job of the owner's, a schedule's or a peer's has no bot to match on, so it
 * lists no song: only a `bot` job's edits are attributable to that bot in
 * studio_history at all.
 */
async function studioSongEntries(db, jobId) {
  let window = null;
  try {
    const { rows } = await db.execute({
      sql: `SELECT MIN(created_at) AS from_at, MAX(created_at) AS to_at, MAX(author_id) AS author_id
              FROM item_versions
             WHERE job_id = ? AND author_kind = 'bot'`,
      args: [jobId],
    });
    window = rows[0] ?? null;
  } catch {
    return [];
  }
  if (!window) return [];
  return studioSongsTouchedBy(db, {
    authorId: window.author_id ?? null,
    from: typeof window.from_at === "string" ? window.from_at : null,
    to: typeof window.to_at === "string" ? window.to_at : null,
  });
}