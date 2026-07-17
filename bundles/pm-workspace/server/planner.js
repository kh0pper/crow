/**
 * PM Workspace — planner: human-gated calendar-block proposals and the
 * planned-events feed.
 *
 * Flow: a proposal (typically drafted from board/task due dates by an
 * assistant) is stored as `proposed`. A human approves or rejects it —
 * either via the dashboard queue or via the MCP tools (chat). Approved
 * events are exported as a JSON feed file into a Drive folder
 * (PLANNER_DRIVE_FOLDER_ID) where an external agent — e.g. a Power
 * Automate flow — picks them up and creates REAL calendar events, tagged
 * with a marker category (PLANNER_CATEGORY, default "Crow Plan").
 *
 * Loop guard: the calendar ingest drop (see digest/adapters/outlook.js)
 * carries each event's categories. reconcile() matches exported events
 * against the newest drop by marker category + subject + start time and
 * promotes them to `confirmed` — so the system recognizes its own events
 * and never re-proposes them.
 *
 * Status lifecycle:
 *   proposed → approved → exported → confirmed
 *            ↘ rejected            (terminal)
 *   any non-exported status → cancelled (terminal)
 *
 * Each event is exported at most once (status flips to `exported` only
 * after the feed file upload succeeds; the export query only ever selects
 * `approved` rows).
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mintGoogleToken, uploadJson } from "./google-drive.js";
import { readDriveDrop } from "./digest/adapters/outlook.js";

const DEFAULT_CATEGORY = "Crow Plan";
const STATUSES = ["proposed", "approved", "rejected", "exported", "confirmed", "cancelled"];

export function plannerConfigured(config) {
  return Boolean(
    config.PLANNER_DRIVE_FOLDER_ID && config.GOOGLE_TOKEN_FILE && existsSync(config.GOOGLE_TOKEN_FILE)
  );
}

/** Parse an ISO datetime; throws with the field name on garbage. */
function parseIso(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    throw new Error(`${field} must be an ISO datetime (got ${JSON.stringify(value)})`);
  }
  let iso = value.replace(/\.\d+/, "");
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(iso)) iso += "Z"; // bare datetime → UTC
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`${field} is not a valid datetime: ${value}`);
  return d;
}

/** Normalize any accepted datetime input to a UTC ISO string (second precision). */
function toUtcIso(value, field) {
  return parseIso(value, field).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Create a proposal (status `proposed`). Returns the stored row. */
export async function propose(db, { title, start, end, location, body, source, source_ref }) {
  if (!title || !String(title).trim()) throw new Error("title is required");
  const startUtc = toUtcIso(start, "start");
  const endUtc = toUtcIso(end, "end");
  if (endUtc <= startUtc) throw new Error("end must be after start");
  const uid = "pe-" + randomBytes(6).toString("hex");
  await db.execute({
    sql: `INSERT INTO pm_planned_events (uid, title, start_utc, end_utc, location, body, source, source_ref)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [uid, String(title).trim(), startUtc, endUtc, location || null, body || null, source || null, source_ref || null],
  });
  return getByUid(db, uid);
}

export async function getByUid(db, uid) {
  const { rows } = await db.execute({
    sql: "SELECT * FROM pm_planned_events WHERE uid = ?",
    args: [uid],
  });
  return rows[0] || null;
}

/** List planned events, optionally filtered by status. Newest first. */
export async function list(db, { status, limit = 50 } = {}) {
  if (status && !STATUSES.includes(status)) throw new Error(`unknown status: ${status}`);
  const { rows } = await db.execute({
    sql: status
      ? "SELECT * FROM pm_planned_events WHERE status = ? ORDER BY start_utc ASC LIMIT ?"
      : "SELECT * FROM pm_planned_events ORDER BY id DESC LIMIT ?",
    args: status ? [status, limit] : [limit],
  });
  return rows;
}

/**
 * Decide a proposal: decision `approved` | `rejected` | `cancelled`.
 * `via` records the gate surface ("dashboard" | "chat" | ...).
 * Only `proposed` rows can be approved/rejected; `cancelled` additionally
 * applies to `approved` rows not yet exported. Exported rows are immutable
 * here (the external agent may already have created the event).
 */
export async function decide(db, { uid, decision, via }) {
  const row = await getByUid(db, uid);
  if (!row) throw new Error(`no planned event with uid ${uid}`);
  const allowedFrom = decision === "cancelled" ? ["proposed", "approved"] : ["proposed"];
  if (!["approved", "rejected", "cancelled"].includes(decision)) {
    throw new Error(`decision must be approved, rejected, or cancelled (got ${decision})`);
  }
  if (!allowedFrom.includes(row.status)) {
    throw new Error(`cannot mark ${row.status} event ${uid} as ${decision}`);
  }
  await db.execute({
    sql: `UPDATE pm_planned_events
          SET status = ?, decided_at = datetime('now'), decided_via = ?, updated_at = datetime('now')
          WHERE uid = ?`,
    args: [decision, via || "chat", uid],
  });
  return getByUid(db, uid);
}

/**
 * Export all `approved` events as one feed file in PLANNER_DRIVE_FOLDER_ID.
 * No-op ({ exported: 0 }) when nothing is approved. Rows flip to `exported`
 * only after the upload succeeds.
 */
export async function exportApproved(db, config) {
  if (!plannerConfigured(config)) {
    throw new Error("planner not configured (set PLANNER_DRIVE_FOLDER_ID + GOOGLE_TOKEN_FILE)");
  }
  const approved = await list(db, { status: "approved", limit: 100 });
  if (approved.length === 0) return { exported: 0 };

  const category = config.PLANNER_CATEGORY || DEFAULT_CATEGORY;
  const generatedAt = new Date().toISOString();
  const feed = {
    generated_at: generatedAt,
    generator: "crow-pm-workspace",
    category,
    events: approved.map((e) => ({
      uid: e.uid,
      subject: e.title,
      start: e.start_utc,
      end: e.end_utc,
      location: e.location || "",
      body: e.body || "",
    })),
  };
  const stamp = generatedAt.replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const name = `planned-events-${stamp}.json`;

  const token = await mintGoogleToken(config.GOOGLE_TOKEN_FILE);
  const file = await uploadJson(token, config.PLANNER_DRIVE_FOLDER_ID, name, feed);

  for (const e of approved) {
    await db.execute({
      sql: `UPDATE pm_planned_events
            SET status = 'exported', exported_at = datetime('now'), feed_file = ?, updated_at = datetime('now')
            WHERE uid = ? AND status = 'approved'`,
      args: [file.name || name, e.uid],
    });
  }
  return { exported: approved.length, file: file.name || name, file_id: file.id || null };
}

/** Epoch millis for an ingest-drop datetime (bare datetimes are UTC). */
function dropTimeMs(value) {
  if (typeof value !== "string") return NaN;
  let iso = value.replace(/\.\d+/, "");
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(iso)) iso += "Z";
  return Date.parse(iso);
}

/**
 * Reconcile `exported` events against the newest calendar ingest drop:
 * an exported event whose subject + start (±5 min) match a drop event
 * carrying the marker category becomes `confirmed`.
 */
export async function reconcile(db, config) {
  const exported = await list(db, { status: "exported", limit: 100 });
  if (exported.length === 0) return { checked: 0, confirmed: 0 };

  if (!config.OUTLOOK_DRIVE_FOLDER_ID || !config.GOOGLE_TOKEN_FILE) {
    return { checked: exported.length, confirmed: 0, reason: "calendar ingest not configured (OUTLOOK_DRIVE_FOLDER_ID)" };
  }
  const drop = await readDriveDrop(config);
  if (drop.empty || !Array.isArray(drop.payload?.calendar)) {
    return { checked: exported.length, confirmed: 0, reason: "no calendar data in ingest drop" };
  }
  const category = config.PLANNER_CATEGORY || DEFAULT_CATEGORY;
  const marked = drop.payload.calendar.filter(
    (e) => Array.isArray(e.categories) && e.categories.includes(category)
  );

  let confirmed = 0;
  for (const ev of exported) {
    const evStart = Date.parse(ev.start_utc);
    const hit = marked.find(
      (m) =>
        String(m.subject || "").trim() === String(ev.title).trim() &&
        Math.abs(dropTimeMs(m.start) - evStart) <= 5 * 60 * 1000
    );
    if (hit) {
      await db.execute({
        sql: `UPDATE pm_planned_events
              SET status = 'confirmed', confirmed_at = datetime('now'), updated_at = datetime('now')
              WHERE uid = ? AND status = 'exported'`,
        args: [ev.uid],
      });
      confirmed += 1;
    }
  }
  return { checked: exported.length, confirmed };
}

/** Digest section: pending gate decisions + exports awaiting confirmation. */
export async function plannerSection(db) {
  const section = { title: "Planner", available: false, items: [] };
  try {
    const proposed = await list(db, { status: "proposed", limit: 10 });
    const exported = await list(db, { status: "exported", limit: 10 });
    section.available = true;
    for (const e of proposed) {
      section.items.push({
        label: e.title,
        detail: `PROPOSED ${e.start_utc}–${e.end_utc}` + (e.source ? ` · from ${e.source}` : ""),
        urgent: true,
      });
    }
    for (const e of exported) {
      section.items.push({
        label: e.title,
        detail: `exported ${e.exported_at || ""} — awaiting calendar confirmation`,
      });
    }
    if (section.items.length === 0) section.note = "No pending proposals or unconfirmed exports.";
  } catch (err) {
    section.available = false;
    section.reason = `planner unavailable: ${err.message}`;
  }
  return section;
}
