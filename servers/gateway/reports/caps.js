/**
 * A report's daily caps, and the counters that measure them.
 *
 * Four settings bound what a report can spend in one day (spec C5): emails sent, comments per
 * recipient, bot minutes, and extra step runs. The defaults live here; an operator's override is a
 * `dashboard_settings` row under the key named in CAP_KEYS, and a value that is not a non-negative
 * number falls back to the default rather than widening a cap to Infinity or narrowing it to NaN.
 *
 * A "day" is the day in the report's own IANA time zone (`dayInTz`), so a morning report in one zone
 * and an evening report in another each count against their own day. An unknown zone falls back to
 * UTC: a cap counter must never throw because a stored zone stopped being valid.
 *
 * `report_usage` holds one row per (report, day) and the writes only ever ADD deltas, so two runs that
 * finish at once cannot lose each other's counts. The email cap is taken with `claimEmailSlot`, one
 * conditional increment, so two sends that are claimed at once cannot both pass a cap of one.
 *
 * The per-recipient comment cap is not a per-report counter, so it has no row here: it is only read
 * through `getCaps` by the recipient-facing paths that count a recipient's comments.
 */

/** The cap defaults (Global Constraints, spec C5). */
export const CAP_DEFAULTS = Object.freeze({
  maxEmailsPerReportDay: 50,
  maxCommentsPerRecipientDay: 20,
  maxBotMinutesPerReportDay: 30,
  maxExtraStepRunsPerReportDay: 10,
});

/** The `dashboard_settings` key an override is read from, per cap. */
export const CAP_KEYS = Object.freeze({
  maxEmailsPerReportDay: "reports.max_emails_per_report_day",
  maxCommentsPerRecipientDay: "reports.max_comments_per_recipient_day",
  maxBotMinutesPerReportDay: "reports.max_bot_minutes_per_report_day",
  maxExtraStepRunsPerReportDay: "reports.max_extra_step_runs_per_report_day",
});

/** A day key is what `dayInTz` writes: the local calendar date, no time. */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const dayFormatters = new Map();

function fail(code, detail) {
  const err = new Error(detail ? `${code}: ${detail}` : code);
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

/**
 * A number that can stand as a cap: finite and not negative. Anything else (a word, "12abc", "", a
 * negative number, a missing row) falls back to the default.
 */
function capValue(raw, fallback) {
  if (raw == null) return fallback;
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!text) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/**
 * The four caps in force on this instance, defaults with the operator's overrides applied.
 *
 * @param {object} db a libsql-shaped client
 * @returns {Promise<{maxEmailsPerReportDay: number, maxCommentsPerRecipientDay: number,
 *   maxBotMinutesPerReportDay: number, maxExtraStepRunsPerReportDay: number}>}
 */
export async function getCaps(db) {
  const keys = Object.values(CAP_KEYS);
  const { rows } = await db.execute({
    sql: `SELECT key, value FROM dashboard_settings WHERE key IN (${keys.map(() => "?").join(", ")})`,
    args: keys,
  });
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const caps = {};
  for (const [name, key] of Object.entries(CAP_KEYS)) {
    caps[name] = capValue(stored.get(key), CAP_DEFAULTS[name]);
  }
  return caps;
}

function formatterFor(tz) {
  const wanted = typeof tz === "string" && tz.trim() ? tz.trim() : "UTC";
  const cached = dayFormatters.get(wanted);
  if (cached) return cached;
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: wanted, year: "numeric", month: "2-digit", day: "2-digit",
    });
  } catch {
    // An unknown or malformed zone is not a reason to refuse a cap counter: count in UTC.
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit",
    });
  }
  dayFormatters.set(wanted, formatter);
  return formatter;
}

/**
 * The calendar day (YYYY-MM-DD) that `nowMs` falls on in `tz`. An invalid zone counts in UTC.
 *
 * @param {number} nowMs epoch ms
 * @param {string} [tz] an IANA zone name
 * @returns {string}
 */
export function dayInTz(nowMs, tz) {
  const at = new Date(Number(nowMs));
  if (!Number.isFinite(at.getTime())) throw fail("bad_input", "nowMs");
  const parts = formatterFor(tz).formatToParts(at);
  const find = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${find("year")}-${find("month")}-${find("day")}`;
}

function dayOf(value) {
  if (typeof value !== "string" || !DAY_RE.test(value)) throw fail("bad_input", "day");
  return value;
}

function reportOf(value) {
  if (typeof value !== "string" || !value) throw fail("bad_input", "reportId");
  return value;
}

function deltaOf(value, field) {
  if (value == null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw fail("bad_input", field);
  return value;
}

/**
 * One report's usage on one day. A day with no row is all zeros, never null: a caller that checks a cap
 * before a run must not have to special-case its first run.
 *
 * @param {object} db
 * @param {string} reportId
 * @param {string} day YYYY-MM-DD in the report's zone
 * @returns {Promise<{emails: number, botMs: number, extraStepRuns: number}>}
 */
export async function getUsage(db, reportId, day) {
  reportOf(reportId);
  dayOf(day);
  const { rows } = await db.execute({
    sql: "SELECT emails, bot_ms, extra_step_runs FROM report_usage WHERE report_id = ? AND day = ?",
    args: [reportId, day],
  });
  const row = rows[0];
  if (!row) return { emails: 0, botMs: 0, extraStepRuns: 0 };
  return {
    emails: Number(row.emails) || 0,
    botMs: Number(row.bot_ms) || 0,
    extraStepRuns: Number(row.extra_step_runs) || 0,
  };
}

/**
 * Add to one report's day counters and read the totals back, in one transaction. Missing deltas count
 * as 0; a negative or non-numeric delta is refused.
 *
 * @param {object} db
 * @param {{reportId: string, day: string, emails?: number, botMs?: number,
 *   extraStepRuns?: number}} fields
 * @returns {Promise<{emails: number, botMs: number, extraStepRuns: number}>}
 */
export async function addUsage(db, { reportId, day, emails, botMs, extraStepRuns } = {}) {
  reportOf(reportId);
  dayOf(day);
  const addEmails = deltaOf(emails, "emails");
  const addBotMs = deltaOf(botMs, "botMs");
  const addSteps = deltaOf(extraStepRuns, "extraStepRuns");
  const [, read] = await db.batch([
    {
      sql: `INSERT INTO report_usage (report_id, day, emails, bot_ms, extra_step_runs)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(report_id, day) DO UPDATE SET
              emails = emails + excluded.emails,
              bot_ms = bot_ms + excluded.bot_ms,
              extra_step_runs = extra_step_runs + excluded.extra_step_runs`,
      args: [reportId, day, addEmails, addBotMs, addSteps],
    },
    {
      sql: "SELECT emails, bot_ms, extra_step_runs FROM report_usage WHERE report_id = ? AND day = ?",
      args: [reportId, day],
    },
  ]);
  return {
    emails: Number(read.rows[0]?.emails) || 0,
    botMs: Number(read.rows[0]?.bot_ms) || 0,
    extraStepRuns: Number(read.rows[0]?.extra_step_runs) || 0,
  };
}

/**
 * Take one email slot for the day, or answer false because the cap is already used up. The read and
 * the increment are ONE batch (one transaction on the client), and the increment itself is
 * conditional (`emails < max`), so two claims that arrive at the same moment cannot both pass a cap
 * of one: exactly one of them moves the counter.
 *
 * The row is created at zero first (`INSERT OR IGNORE`), so the guarded UPDATE is the only statement
 * that decides anything and `rowsAffected` is its own answer. There is no way back: a claimed slot is
 * spent even if the send it was claimed for then fails, which is what a per-day cap counts.
 *
 * @param {object} db a libsql-shaped client
 * @param {{reportId: string, day: string, max: number}} fields
 * @returns {Promise<boolean>} whether this caller took the slot
 * @throws {Error} `bad_input` for a bad id, day or bound
 */
export async function claimEmailSlot(db, { reportId, day, max } = {}) {
  reportOf(reportId);
  dayOf(day);
  if (typeof max !== "number" || !Number.isFinite(max) || max < 0) throw fail("bad_input", "max");
  const [, claim] = await db.batch([
    {
      sql: "INSERT OR IGNORE INTO report_usage (report_id, day, emails) VALUES (?, ?, 0)",
      args: [reportId, day],
    },
    {
      sql: `UPDATE report_usage SET emails = emails + 1
             WHERE report_id = ? AND day = ? AND emails < ?`,
      args: [reportId, day, max],
    },
  ]);
  return Number(claim?.rowsAffected ?? 0) === 1;
}

/**
 * Each cap next to what has been used today, with whether the cap is reached. `botMinutes.used` is the
 * counted milliseconds as minutes; the comparison is made on the milliseconds, so a fractional minute
 * never rounds a report over its cap.
 *
 * @param {object} db
 * @param {{reportId: string, day: string}} fields
 * @returns {Promise<{emails: {used: number, max: number, exceeded: boolean},
 *   botMinutes: {used: number, max: number, exceeded: boolean},
 *   extraStepRuns: {used: number, max: number, exceeded: boolean}}>}
 */
export async function capState(db, { reportId, day } = {}) {
  const caps = await getCaps(db);
  const usage = await getUsage(db, reportId, day);
  return {
    emails: {
      used: usage.emails,
      max: caps.maxEmailsPerReportDay,
      exceeded: usage.emails >= caps.maxEmailsPerReportDay,
    },
    botMinutes: {
      used: usage.botMs / 60_000,
      max: caps.maxBotMinutesPerReportDay,
      exceeded: usage.botMs >= caps.maxBotMinutesPerReportDay * 60_000,
    },
    extraStepRuns: {
      used: usage.extraStepRuns,
      max: caps.maxExtraStepRunsPerReportDay,
      exceeded: usage.extraStepRuns >= caps.maxExtraStepRunsPerReportDay,
    },
  };
}