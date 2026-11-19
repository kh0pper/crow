/**
 * The run request queue: the one way a bot tool asks for a preview or a run now.
 *
 * A bot never starts a run. It inserts a row here (`requestRun`) and the scheduler hook drains it
 * (`claimRunRequests`) on its next tick, exactly as it drains a due schedule. That keeps the whole
 * "what may actually run" decision in one place: this module knows nothing about running a report, and
 * the run engine knows nothing about who asked. Nothing here imports the run engine, and the bot-facing
 * tools that call `requestRun` import neither.
 *
 * Claiming is one statement: the UPDATE picks the oldest unclaimed rows and stamps them, so two ticks
 * running at once can never claim the same row twice (the inner SELECT is what an unclaimed row is, the
 * outer `claimed_at IS NULL` guard is what a row claimed between the two is not).
 *
 * `pruneRunRequests` removes CLAIMED rows past their cutoff. An unclaimed row is never pruned: a request
 * nobody picked up yet is a request the owner (or a bot) is still waiting on.
 *
 * Times are epoch ms from the injected `now`, so a test's clock moves them.
 */

/** The only two things a requester may ask for. */
export const REQUEST_KINDS = Object.freeze(["preview", "run_now"]);

/** How long a claimed request is kept before `pruneRunRequests` may remove it. */
export const REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const BOT_REQUESTER_RE = /^bot:.+$/;
const ID_RE = /^rpt-[0-9a-f]{16}$/;

function fail(code, detail) {
  const err = new Error(detail ? `${code}: ${detail}` : code);
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

function clock(now) {
  return Number.isFinite(now) ? Number(now) : Date.now();
}

function mapRequest(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    reportId: row.report_id,
    kind: row.kind,
    requestedBy: row.requested_by,
    createdAt: Number(row.created_at),
    claimedAt: row.claimed_at == null ? null : Number(row.claimed_at),
  };
}

/** The report a request names, or `not_found`: a request for no report would be claimed and dropped. */
async function requireReport(db, reportId) {
  if (typeof reportId !== "string" || !ID_RE.test(reportId)) throw fail("bad_input", "reportId");
  const { rows } = await db.execute({ sql: "SELECT id FROM reports WHERE id = ?", args: [reportId] });
  if (!rows[0]) throw fail("not_found", "report");
  return reportId;
}

/**
 * Ask for a preview or a run now. The requester is the owner or a bot (`bot:<id>`); the schedule never
 * asks through here, because a due window is a schedule and the hook makes those runs itself.
 *
 * @param {object} db
 * @param {{reportId: string, kind: "preview"|"run_now", requestedBy: "owner"|string,
 *   now?: number}} input
 * @returns {Promise<{id: number}>}
 * @throws {Error} `bad_input` or `not_found`
 */
export async function requestRun(db, { reportId, kind, requestedBy, now } = {}) {
  if (!REQUEST_KINDS.includes(kind)) throw fail("bad_input", "kind");
  const requester = requestedBy;
  if (requester !== "owner" && !(typeof requester === "string" && BOT_REQUESTER_RE.test(requester))) {
    throw fail("bad_input", "requestedBy");
  }
  const report = await requireReport(db, reportId);
  const result = await db.execute({
    sql: `INSERT INTO report_run_requests (report_id, kind, requested_by, created_at)
          VALUES (?, ?, ?, ?)`,
    args: [report, kind, requester, clock(now)],
  });
  return { id: Number(result.lastInsertRowid) };
}

/**
 * Claim up to `limit` unclaimed requests, oldest first, and answer the rows claimed by THIS call. Two
 * claims running at once split the queue between them; neither can hand back a row the other has.
 *
 * @param {object} db
 * @param {{limit?: number, now?: number}} [opts]
 * @returns {Promise<object[]>} the claimed rows, camelCase
 */
export async function claimRunRequests(db, { limit = 10, now } = {}) {
  const batch = Number.isInteger(limit) && limit > 0 ? limit : 10;
  const claimedAt = clock(now);
  const { rows } = await db.execute({
    sql: `UPDATE report_run_requests SET claimed_at = ?
           WHERE id IN (SELECT id FROM report_run_requests
                         WHERE claimed_at IS NULL ORDER BY id LIMIT ?)
             AND claimed_at IS NULL
          RETURNING *`,
    args: [claimedAt, batch],
  });
  return rows.map(mapRequest);
}

/**
 * Remove claimed requests older than the cutoff. Unclaimed rows are never removed: nobody has picked them
 * up yet.
 *
 * @param {object} db
 * @param {{olderThanMs?: number, now?: number}} [opts]
 * @returns {Promise<{deleted: number}>}
 */
export async function pruneRunRequests(db, { olderThanMs = REQUEST_RETENTION_MS, now } = {}) {
  const span = Number.isFinite(olderThanMs) && olderThanMs >= 0 ? Number(olderThanMs) : REQUEST_RETENTION_MS;
  const cutoff = clock(now) - span;
  const result = await db.execute({
    sql: "DELETE FROM report_run_requests WHERE claimed_at IS NOT NULL AND claimed_at < ?",
    args: [cutoff],
  });
  return { deleted: result.rowsAffected };
}