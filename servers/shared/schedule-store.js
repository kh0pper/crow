/**
 * schedule-store — the database side of Crow's schedules, shared by the gateway scheduler and the
 * memory server's schedule tools: the instance zone and language, the zone of a bundle-owned row,
 * shape probes for databases that have not been migrated yet, delete with its run history, and
 * "run now" requests.
 *
 * The rules themselves (types, zones, missed runs) are pure, in schedule-core.js.
 */
import { readSetting } from "../gateway/dashboard/settings/registry.js";
import { validTimeZone } from "./relative-dates.js";
import { SCHEDULE_OWNERS, hostZone } from "./schedule-core.js";

export const INSTANCE_ZONE_KEY = "instance_timezone";

async function setting(db, key) {
  try { return await readSetting(db, key); } catch { return null; }
}

/** The instance zone: the instance_timezone setting if valid, else the host's zone. */
export async function instanceZone(db) {
  return validTimeZone(await setting(db, INSTANCE_ZONE_KEY)) || hostZone();
}

/** "es" for a Spanish instance, otherwise "en". */
export async function instanceLang(db) {
  return String((await setting(db, "language")) || "en").toLowerCase().startsWith("es") ? "es" : "en";
}

/** The zone a bundle-owned row runs in (News's briefing zone), else the given fallback. */
export async function ownerZone(db, task, fallback) {
  const owner = SCHEDULE_OWNERS[String(task ?? "").trim()];
  if (!owner?.zoneSetting) return fallback;
  try {
    const v = JSON.parse((await setting(db, owner.zoneSetting.key)) || "null");
    return validTimeZone(v?.[owner.zoneSetting.field]) || fallback;
  } catch { return fallback; }
}

// Shape probes. Only a positive answer is cached: the gateway's migration registry may add the
// shape after a memory server started against the same file.
const shapeCache = new WeakMap();
async function has(db, probe) {
  let c = shapeCache.get(db);
  if (!c) { c = new Set(); shapeCache.set(db, c); }
  if (c.has(probe)) return true;
  let ok = false;
  try {
    const [table, column] = probe.split(".");
    const { rows } = await db.execute({ sql: `PRAGMA table_info(${table})`, args: [] });
    ok = column ? rows.some((r) => r.name === column) : rows.length > 0;
  } catch { ok = false; }
  if (ok) c.add(probe);
  return ok;
}
export const hasRunsTable = (db) => has(db, "schedule_runs");
export const hasTzColumn = (db) => has(db, "schedules.tz");

/** Delete a schedule and its run history in one transaction. → true when a row was deleted. */
export async function deleteSchedule(db, id) {
  const stmts = [];
  if (await hasRunsTable(db)) stmts.push({ sql: "DELETE FROM schedule_runs WHERE schedule_id = ?", args: [id] });
  stmts.push({ sql: "DELETE FROM schedules WHERE id = ?", args: [id] });
  const res = await db.batch(stmts, "write");
  return Number(res.at(-1)?.rowsAffected || 0) > 0;
}

/**
 * Ask the gateway to run a schedule now: a 'requested' run row its next tick executes (the memory
 * server is a separate process with no delivery hooks). → the run id, or null on an old database.
 */
export async function requestRun(db, scheduleId) {
  if (!(await hasRunsTable(db))) return null;
  const r = await db.execute({
    sql: "INSERT INTO schedule_runs (schedule_id, status, source) VALUES (?, 'requested', 'run-now')",
    args: [scheduleId],
  });
  return Number(r.lastInsertRowid);
}

/** The newest run's status and the open (unacknowledged) missed count per schedule id. */
export async function runSummaries(db, ids) {
  const out = new Map();
  if (!ids.length || !(await hasRunsTable(db))) return out;
  const marks = ids.map(() => "?").join(",");
  const { rows } = await db.execute({
    sql: `SELECT schedule_id,
            (SELECT status FROM schedule_runs r2 WHERE r2.schedule_id = r.schedule_id ORDER BY id DESC LIMIT 1) AS last_status,
            SUM(CASE WHEN status = 'missed' AND acknowledged_at IS NULL THEN missed_count ELSE 0 END) AS open_missed
          FROM schedule_runs r WHERE schedule_id IN (${marks}) GROUP BY schedule_id`,
    args: ids,
  });
  for (const r of rows) out.set(Number(r.schedule_id), { lastStatus: r.last_status, openMissed: Number(r.open_missed || 0) });
  return out;
}
