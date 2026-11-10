/**
 * data.js — the reads behind the History pages.
 *
 * Every query here is bounded (a page of versions, a page of jobs, a page of
 * Trash entries) and every one is a plain read on the request's db client. The
 * panel does the writing; this file never does.
 *
 * The two shapes worth knowing:
 *
 *   listJobs groups item_versions by job_id. Keyset pagination is on the job's
 *   NEWEST version id (`HAVING MAX(id) < :before`), never on a row id: a job's
 *   rows sit in whatever order the writes happened, and filtering rows by id
 *   would split one job across two pages and tell the reader an item count that
 *   is not the job's.
 *
 *   authorMaps resolves the two names a version can carry: a bot's display name
 *   (pi_bot_defs) and a paired machine's name (crow_instances). Both are stored
 *   here as the document wrote them, so the viewer escapes them; a lookup that
 *   fails just means the plain fallback phrase is shown.
 */
import { containmentBots } from "../../settings/sections/bot-runtime.js";
import { LEVEL_NOT } from "../../../../../scripts/pi-bots/containment-status.mjs";
import { itemLabel } from "../../shared/history-view.js";

/** Versions, jobs and Trash rows per page. */
export const HISTORY_PAGE_SIZE = 25;

/** Items listed per job. A job that touched more is a page in itself. */
export const MAX_JOB_ITEMS = 100;

/**
 * Is the containment caveat still true? True while ANY enabled bot is
 * `not contained` — that is the state in which a bot could still reach the
 * database directly and alter history (the private engineering notes, audit
 * N1b-4). A host with no bots, or with every bot contained, gets no banner.
 *
 * The status itself is never guessed here: containmentBots (the Bot Runtime
 * section's own helper) reads the defs and the spawns THIS process recorded. A
 * check that throws counts as "gap open": the banner is honest either way.
 */
export async function botContainmentGapOpen(db) {
  try {
    const bots = await containmentBots(db);
    return bots.some((bot) => bot && bot.level === LEVEL_NOT);
  } catch {
    return true;
  }
}

/** The display names a version's author can resolve to: bots and paired machines. */
export async function authorMaps(db) {
  const bots = new Map();
  const machines = new Map();
  try {
    const { rows } = await db.execute({ sql: "SELECT bot_id, display_name FROM pi_bot_defs", args: [] });
    for (const row of rows) if (row.bot_id) bots.set(String(row.bot_id), row.display_name == null ? "" : String(row.display_name));
  } catch {
    // No bot table on this install: a bot author falls back to a plain phrase.
  }
  try {
    const { rows } = await db.execute({ sql: "SELECT id, name FROM crow_instances", args: [] });
    for (const row of rows) if (row.id) machines.set(String(row.id), row.name == null ? "" : String(row.name));
  } catch {
    // No instance registry yet: a peer author falls back to a plain phrase.
  }
  return { bots, machines };
}

/**
 * Recent jobs, newest first.
 *
 * One job is one unit of work (the version history design §8.1): a board card,
 * a voice hand-off, a chat turn, a schedule, or the owner's sign-in. Every
 * version the job wrote carries its id, so the grouping is one indexed read.
 *
 * @param {object} db
 * @param {{before?: string|null, limit?: number}} [opts] `before` is the job's
 *   newest version id from the previous page (a keyset cursor).
 * @returns {Promise<{jobs: Array<object>, hasMore: boolean}>}
 */
export async function listJobs(db, { before = null, limit = HISTORY_PAGE_SIZE } = {}) {
  const pageSize = Math.max(1, Math.min(Number(limit) || HISTORY_PAGE_SIZE, 200));
  const cursor = before === null || before === undefined || String(before).trim() === "" ? null : Number(before);
  // One extra row: "is there another page" without a second count query.
  const args = [];
  let having = "";
  if (cursor !== null && Number.isFinite(cursor)) {
    having = "HAVING MAX(id) < ?";
    args.push(Math.trunc(cursor));
  }
  args.push(pageSize + 1);

  const { rows } = await db.execute({
    sql: `SELECT job_id, MIN(id) AS first_id, MAX(id) AS last_id, MAX(created_at) AS at,
                 COUNT(*) AS versions, COUNT(DISTINCT item_type || '/' || item_id) AS items
            FROM item_versions
           WHERE job_id IS NOT NULL AND job_id <> ''
           GROUP BY job_id
           ${having}
           ORDER BY last_id DESC
           LIMIT ?`,
    args,
  });

  const hasMore = rows.length > pageSize;
  const pageRows = rows.slice(0, pageSize);
  if (pageRows.length === 0) return { jobs: [], hasMore: false };

  // The author of a job is the author of its newest version (one job = one
  // author in practice; if it is not, the newest one is what the job looks like).
  const authors = new Map();
  try {
    const { rows: authorRows } = await db.execute({
      sql: `SELECT id, author_kind, author_id FROM item_versions
             WHERE id IN (${pageRows.map(() => "?").join(", ")})`,
      args: pageRows.map((row) => Number(row.last_id)),
    });
    for (const row of authorRows) authors.set(Number(row.id), row);
  } catch {
    // Without the author rows the job still lists; it reads "Unattributed".
  }

  const jobs = [];
  for (const row of pageRows) {
    const jobId = String(row.job_id);
    const author = authors.get(Number(row.last_id)) || {};
    let items = [];
    try {
      // Each item the job touched, labelled by the newest version of it that
      // this job wrote (the job's own result — never a later edit's value).
      const { rows: itemRows } = await db.execute({
        sql: `SELECT v.item_type, v.item_id, v.snapshot_json
                FROM item_versions v
                JOIN (SELECT item_type, item_id, MAX(id) AS mid
                        FROM item_versions
                       WHERE job_id = ?
                       GROUP BY item_type, item_id) newest
                  ON newest.item_type = v.item_type AND newest.item_id = v.item_id AND v.id = newest.mid
               ORDER BY newest.mid DESC
               LIMIT ?`,
        args: [jobId, MAX_JOB_ITEMS],
      });
      items = itemRows.map((item) => {
        let snapshot = {};
        try {
          snapshot = JSON.parse(item.snapshot_json) || {};
        } catch {
          snapshot = {};
        }
        return {
          itemType: String(item.item_type),
          itemId: String(item.item_id),
          label: itemLabel(String(item.item_type), snapshot),
        };
      });
    } catch {
      items = [];
    }
    jobs.push({
      jobId,
      lastId: Number(row.last_id),
      firstId: Number(row.first_id),
      at: row.at,
      versions: Number(row.versions) || 0,
      // The job's real item count (the list below is bounded by MAX_JOB_ITEMS).
      itemCount: Number(row.items) || 0,
      authorKind: author.author_kind ?? "unattributed",
      authorId: author.author_id ?? null,
      items,
    });
  }
  return { jobs, hasMore };
}
