/**
 * The boot sweep for sends that were in flight when the gateway went away.
 *
 * A `report_sends` row is written `pending` and moved to `sending` by one guarded claim, which also
 * stamps the claiming process's `gateway_run_id` (run-id.js: 128 random bits minted per process, never
 * the kernel's boot id, because an auto-update restart does not reboot the kernel). If the process
 * dies between the claim and the settle, the row stays `sending` forever — and because `sending` is
 * never claimed again, that recipient would silently never hear from the report again.
 *
 * So boot marks those rows once: ONE guarded UPDATE over `sending` rows whose `gateway_run_id` is NULL
 * or is not this process's becomes `unknown` with the reason `restarted`. The rows the current process
 * is sending right now are left exactly as they are, and a second sweep marks nothing (the rows it
 * would have marked are `unknown`, and nothing here moves a row back to `pending`).
 *
 * `unknown` is the honest answer: nobody knows whether the provider took the message, so it is never
 * resent automatically. The owner gets ONE notice per affected run, with plain counts for that run:
 * how many went, how many nobody can confirm, and how many are still waiting (a `pending` row stays
 * pending; the delivery seam picks it up whenever it runs). The report title is untrusted text, so it
 * loses its control characters and is bounded before it reaches a bell.
 *
 * This module imports nothing under `mail/`: the notification comes in as a callback, and the caller
 * (reports/schedule-hook.js) already holds the owner's notice channel and the reports lease.
 */
import { getReport } from "./store.js";

/** The reason a swept row carries, the twin of run.js's restart sentence for a run. */
export const RESTARTED_SEND_REASON = "restarted";

/** The bell's title tail: what happened, said the same way for every run. */
export const RESTARTED_SENDING_TITLE = "Crow restarted while sending";

/** The longest report title a bell carries. */
const TITLE_MAX = 80;

/** The shortest count sentence there is, in the words the plan's own example uses. */
export function countsText({ sent, unknown, notSent }) {
  return `${sent} sent, ${unknown} unknown, ${notSent} not sent.`;
}

/**
 * The notice for one run, as the notification layer takes it: the report's title and what happened in
 * the title, the counts in the body.
 *
 * @param {{title?: string|null, sent?: number, unknown?: number, notSent?: number}} input
 * @returns {{title: string, body: string}}
 */
export function restartSendNotice({ title, sent = 0, unknown = 0, notSent = 0 } = {}) {
  const flat = String(title == null ? "" : title)
    .replace(/[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = flat.length > TITLE_MAX ? flat.slice(0, TITLE_MAX) : flat;
  return {
    title: `${bounded || "This report"}: ${RESTARTED_SENDING_TITLE}`,
    body: countsText({ sent, unknown, notSent }),
  };
}

/** How many of one run's rows hold each state this notice talks about. */
async function countsForRun(db, runId) {
  const { rows } = await db.execute({
    sql: "SELECT status, COUNT(*) AS n FROM report_sends WHERE run_id = ? GROUP BY status",
    args: [runId],
  });
  const counts = { sent: 0, unknown: 0, notSent: 0 };
  for (const row of rows) {
    const n = Number(row.n) || 0;
    if (row.status === "sent") counts.sent = n;
    else if (row.status === "unknown") counts.unknown = n;
    else if (row.status === "pending") counts.notSent = n;
  }
  return counts;
}

/**
 * Mark every `sending` row this process did not claim as `unknown`, then tell the owner once per run.
 *
 * @param {object} db a libsql-shaped client
 * @param {{gatewayRunId: string, now?: number, notify?: Function}} [input] `notify` receives
 *   `{reportId, runId, title, body}` once per affected run
 * @returns {Promise<{marked: number, runs: Array<{runId: string, reportId: string}>}>}
 * @throws {Error} `bad_input` when no gateway run id was given
 */
export async function sweepStaleSends(db, { gatewayRunId, now, notify } = {}) {
  if (typeof gatewayRunId !== "string" || !gatewayRunId) {
    throw Object.assign(new Error("bad_input: gatewayRunId"), { code: "bad_input" });
  }
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const notifyOwner = typeof notify === "function" ? notify : null;

  const { rows } = await db.execute({
    sql: `UPDATE report_sends
             SET status = 'unknown', reason = ?, updated_at = ?
           WHERE status = 'sending'
             AND (gateway_run_id IS NULL OR gateway_run_id <> ?)
          RETURNING id, run_id, report_id, recipient_id`,
    args: [RESTARTED_SEND_REASON, at, gatewayRunId],
  });

  // One notice per run, whatever number of its rows were swept.
  const byRun = new Map();
  for (const row of rows) {
    if (!byRun.has(row.run_id)) byRun.set(row.run_id, row.report_id);
  }
  const touched = [];
  for (const [runId, reportId] of byRun) {
    let report = null;
    try {
      report = await getReport(db, reportId);
    } catch {
      report = null;
    }
    const notice = restartSendNotice({ title: report?.title, ...(await countsForRun(db, runId)) });
    touched.push({ runId, reportId });
    if (!notifyOwner) continue;
    try {
      await notifyOwner({ reportId, runId, ...notice });
    } catch {
      // A bell that cannot be written is not a reason to leave rows half swept: the rows are the record.
    }
  }
  return { marked: rows.length, runs: touched };
}