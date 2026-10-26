/**
 * schedule-catalog — the Schedule panel's model, built from the database: the agenda (each
 * schedule once, at its next run), the problems strip (each problem with its fixes) and the one
 * open detail (next 3 runs, last 10 runs).
 *
 * Crow-owned sources only (reminders, bot routines, the News briefing). Read-only sources (box
 * windows, machine timers) join in a later PR. No strings here: problems and runs carry codes the
 * renderer (dashboard/panels/schedule/html.js) words in en or es.
 *
 * Zones: a reminder runs in its own zone (schedules.tz) or the instance zone; the briefing in
 * News's zone; a bot routine in the host zone, because the bot ticker computes its next run with
 * no zone until bot routines learn zones. Agenda days are the instance zone's.
 */
import {
  ONCE, BOTCRON_PREFIX, scheduleKind, reminderText, zoneFor, hostZone,
  cronNext, cadenceMinutes, graceMs,
} from "../shared/schedule-core.js";
import { instanceZone, ownerZone, hasRunsTable, hasTzColumn } from "../shared/schedule-store.js";
import { describeCron } from "../shared/schedule-words.js";
import { localYmd, dayNum } from "../shared/relative-dates.js";
import { isVoiceBotId } from "../shared/voice-bot.js";
import { readSetting } from "./dashboard/settings/registry.js";

const MIN = 60_000;
const DAY_MS = 86_400_000;
/** An enabled bot routine this far past its time has no runner (grace + the ticker's own poll). */
const RUNNER_SLACK_MS = 2 * MIN;
const NO_NEXT_AFTER_MS = 2 * MIN; // a recurring row still without a next run this long after an edit
const AGENDA_DAYS = 7; // Today, Tomorrow and the next five days by weekday
const DONE_DAYS = 7;
const FREQUENT_MIN = 60; // repeats more often than hourly → the "Runs all the time" fold
const DEFAULT_TYPES = ["reminder", "media", "peer", "system", "attention"];

const parseMs = (s) => { const t = Date.parse(s ?? ""); return Number.isFinite(t) ? t : null; };
/** A SQLite datetime ("YYYY-MM-DD HH:MM:SS[.mmm]", UTC) or an ISO string, as ms. */
function sqliteMs(s) {
  if (!s) return null;
  const v = String(s).replace(" ", "T");
  return parseMs(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v.slice(10)) ? v : v + "Z");
}
const json = (s, dflt) => { try { const v = JSON.parse(s ?? ""); return v ?? dflt; } catch { return dflt; } };

async function tableExists(db, name) {
  try {
    const { rows } = await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", args: [name] });
    return rows.length > 0;
  } catch { return false; }
}

async function safeRows(db, sql, args = []) {
  try { return (await db.execute({ sql, args })).rows; } catch { return []; }
}

/** The bot routine's job spec (schedules.description JSON). */
export function botSpec(row) {
  const spec = json(row.description, {});
  return spec && typeof spec === "object" ? spec : {};
}

/** A schedule row as one agenda item. `bots` maps bot_id → {display_name, enabled}. */
function toItem(row, { now, zone, briefingZone, bots, lang }) {
  const kind = scheduleKind(row.task);
  const once = row.cron_expression === ONCE;
  const z = kind === "briefing" ? briefingZone : kind === "bot_routine" ? hostZone() : zoneFor(row.tz, zone);
  const botId = kind === "bot_routine" ? String(row.task).trim().slice(BOTCRON_PREFIX.length) : null;
  const spec = kind === "bot_routine" ? botSpec(row) : null;
  const bot = botId ? bots.get(botId) || null : null;
  let title;
  if (kind === "reminder") title = reminderText(row.task);
  else if (kind === "bot_routine") title = (spec.label && String(spec.label)) || (bot && bot.display_name) || botId;
  else if (kind === "briefing") title = null; // the renderer words it ("Daily briefing")
  else title = String(row.task);
  const nextRun = parseMs(row.next_run);
  const cadence = once ? null : cadenceMinutes(row.cron_expression, z, now);
  return {
    id: Number(row.id),
    ref: `crow:${Number(row.id)}`,
    kind,
    title,
    task: row.task,
    cron: row.cron_expression,
    once,
    tz: row.tz || null,
    zone: z,
    zoneDiffers: z !== zone,
    enabled: !!Number(row.enabled),
    nextRun,
    lastRun: parseMs(row.last_run),
    updatedAt: sqliteMs(row.updated_at),
    cadence,
    summary: once ? null : describeCron(row.cron_expression, lang),
    botId,
    bot,
    goal: spec ? (spec.goal ? String(spec.goal) : null) : null,
    readOnly: kind === "system",
    // News owns its row: every control is a link to News → Briefings.
    owned: kind === "briefing",
  };
}

/** The next `n` runs of an item (ms), in its zone. */
export function nextRuns(item, now, n = 3) {
  if (item.once) return item.nextRun !== null && item.nextRun > now && item.enabled ? [item.nextRun] : [];
  const out = [];
  let t = item.enabled && item.nextRun !== null && item.nextRun > now ? item.nextRun - 1 : now;
  for (let i = 0; i < n; i++) {
    t = cronNext(item.cron, item.zone, t);
    if (t === null) break;
    out.push(t);
  }
  return out;
}

/**
 * The agenda: enabled items once, at their next run, grouped Now → Today → Tomorrow → weekdays →
 * Later; the high-frequency fold; Paused; Done in the last 7 days (fired one-shots).
 */
export function agendaGroups(items, { now, zone, running = new Map() }) {
  const today = dayNum(localYmd(now, zone));
  const groups = { now: [], days: [], later: [], frequent: [], paused: [], done: [] };
  const byDay = new Map();
  for (const it of items) {
    if (it.kind === "system") { groups.paused.push(it); continue; }
    if (!it.enabled) {
      if (it.once && it.lastRun !== null) { if (now - it.lastRun <= DONE_DAYS * DAY_MS) groups.done.push(it); continue; }
      groups.paused.push(it);
      continue;
    }
    if (running.has(it.id) || (it.nextRun !== null && it.nextRun <= now)) { groups.now.push(it); continue; }
    if (it.cadence !== null && it.cadence < FREQUENT_MIN) { groups.frequent.push(it); continue; }
    if (it.nextRun === null) { groups.paused.push(it); continue; }
    const d = dayNum(localYmd(it.nextRun, zone)) - today;
    if (d >= AGENDA_DAYS) { groups.later.push(it); continue; }
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(it);
  }
  const byTime = (a, b) => (a.nextRun ?? Infinity) - (b.nextRun ?? Infinity) || a.id - b.id;
  for (const k of ["now", "later", "frequent"]) groups[k].sort(byTime);
  groups.paused.sort((a, b) => a.id - b.id);
  groups.done.sort((a, b) => (b.lastRun ?? 0) - (a.lastRun ?? 0));
  groups.days = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([offset, list]) => ({ offset, ymdNum: today + offset, items: list.sort(byTime) }));
  return groups;
}

/** The newest schedule_runs rows of every schedule (newest first), with their bot job's status. */
async function loadRuns(db, ids, perSchedule = 10) {
  const out = new Map();
  if (!ids.length || !(await hasRunsTable(db))) return out;
  const marks = ids.map(() => "?").join(",");
  const jobs = await tableExists(db, "bot_jobs");
  const rows = await safeRows(db, `SELECT * FROM (
      SELECT r.*, ${jobs ? "j.status AS job_status, j.error AS job_error, j.bot_id AS job_bot" : "NULL AS job_status, NULL AS job_error, NULL AS job_bot"},
        ROW_NUMBER() OVER (PARTITION BY r.schedule_id ORDER BY r.id DESC) AS rn
      FROM schedule_runs r ${jobs ? "LEFT JOIN bot_jobs j ON j.job_id = r.job_id" : ""}
      WHERE r.schedule_id IN (${marks})) WHERE rn <= ?`, [...ids, perSchedule]);
  for (const r of rows) {
    const id = Number(r.schedule_id);
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(r);
  }
  return out;
}

/** Bot jobs a schedule launched (the ticker's and run-now's), newest first, per schedule id. */
async function loadBotJobs(db, ids, perSchedule = 10) {
  const out = new Map();
  if (!ids.length || !(await tableExists(db, "bot_jobs"))) return out;
  const marks = ids.map(() => "?").join(",");
  const rows = await safeRows(db, `SELECT * FROM (
      SELECT job_id, bot_id, status, error, schedule_id, created_at, started_at, ended_at,
        ROW_NUMBER() OVER (PARTITION BY schedule_id ORDER BY created_at DESC, job_id DESC) AS rn
      FROM bot_jobs WHERE source = 'schedule' AND schedule_id IN (${marks})) WHERE rn <= ?`, [...ids, perSchedule]);
  for (const r of rows) {
    const id = Number(r.schedule_id);
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(r);
  }
  return out;
}

/**
 * One schedule's last runs for the detail: its schedule_runs rows, plus bot jobs it launched that
 * no run row points at (a bot routine's ticker writes jobs, not runs, until bot routines record
 * runs), newest first, at most `n`. Each is { status, at, source, count?, first?, last?, jobId?,
 * error?, capped? }; a bot run's status is its job's (queued/running/completed/failed).
 */
export function runHistory(runs = [], jobs = [], n = 10) {
  const seen = new Set();
  const out = [];
  for (const r of runs) {
    const detail = json(r.detail, {}) || {};
    if (r.job_id) seen.add(r.job_id);
    // A missed window sorts by its LAST missed occurrence.
    const at = parseMs(r.ran_at) ?? (r.status === "missed" ? parseMs(detail.last_missed) : null) ?? parseMs(r.scheduled_for) ?? sqliteMs(r.created_at);
    out.push({
      runId: Number(r.id),
      status: r.job_status ? `job-${r.job_status}` : r.status,
      at,
      source: r.source || "clock",
      count: Number(r.missed_count || 0),
      first: parseMs(r.scheduled_for),
      last: parseMs(detail.last_missed) ?? parseMs(r.scheduled_for),
      capped: !!detail.capped,
      jobId: r.job_id || null,
      error: detail.error ? String(detail.error).slice(0, 200) : r.job_error ? String(r.job_error).slice(0, 200) : null,
      reason: detail.reason || null,
      acknowledged: !!r.acknowledged_at,
    });
  }
  for (const j of jobs) {
    if (seen.has(j.job_id)) continue;
    out.push({
      runId: null, status: `job-${j.status}`, at: sqliteMs(j.ended_at) ?? sqliteMs(j.started_at) ?? sqliteMs(j.created_at),
      source: "clock", count: 0, first: null, last: null, capped: false, jobId: j.job_id,
      error: j.error ? String(j.error).slice(0, 200) : null, reason: null, acknowledged: false,
    });
  }
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, n);
}

const SEVERITY = { error: 0, warning: 1 };

/**
 * The problems strip, errors before warnings. Each is
 *   { code, severity, scheduleId?, runId?, item?, run?, fixes: [{ act, href? }] }
 * where act is a POST action (run-now, ack-run, pause, resume, delete) or "link" (with href).
 */
export function problemsFor(items, { now, runsBy = new Map(), jobsBy = new Map(), notifTypes = DEFAULT_TYPES, engine = "ready", botDefsTable = true, runtimeOn = true, grace = graceMs() }) {
  const out = [];
  const byId = new Map(items.map((it) => [it.id, it]));
  const runnable = (it) => it && (it.kind === "reminder" || it.kind === "bot_routine");
  // Missed windows, failures and upgrade pauses: one problem per unacknowledged run row.
  for (const [id, runs] of runsBy) {
    const it = byId.get(id);
    if (!it) continue;
    runs.forEach((r, idx) => {
      if (r.acknowledged_at) return;
      if (r.status === "missed") {
        out.push({ code: "missed", severity: "warning", scheduleId: id, runId: Number(r.id), item: it, run: r,
          fixes: [...(runnable(it) ? [{ act: "run-now" }] : []), { act: "ack-run" }] });
      } else if (r.status === "paused" && r.source === "upgrade") {
        const fixes = [];
        if (!it.enabled && it.kind !== "system") fixes.push({ act: "resume" });
        fixes.push({ act: "delete" }, { act: "ack-run" });
        out.push({ code: "paused-upgrade", severity: "warning", scheduleId: id, runId: Number(r.id), item: it, run: r, fixes });
      } else if (idx === 0 && (r.status === "failed" || r.job_status === "failed")) {
        // The LATEST run failed (an older failure followed by a good run is not a problem).
        const fixes = [...(runnable(it) ? [{ act: "run-now" }] : [])];
        if (it.kind === "bot_routine" && r.job_id) fixes.push({ act: "link", href: `/dashboard/bot-builder?bot=${encodeURIComponent(it.botId)}&tab=activity`, label: "openJob" });
        fixes.push({ act: "ack-run" });
        out.push({ code: "failed", severity: "error", scheduleId: id, runId: Number(r.id), item: it, run: r, fixes });
      }
    });
  }
  // A bot job the ticker launched that failed, with no run row behind it (no Dismiss: there is
  // no run row to mark; the next good run clears it).
  for (const [id, jobs] of jobsBy) {
    const it = byId.get(id);
    const latest = jobs[0];
    if (!it || !latest || latest.status !== "failed") continue;
    if ((runsBy.get(id) || []).some((r) => r.job_id === latest.job_id)) continue;
    out.push({ code: "failed", severity: "error", scheduleId: id, item: it, job: latest,
      fixes: [{ act: "run-now" }, { act: "link", href: `/dashboard/bot-builder?bot=${encodeURIComponent(it.botId)}&tab=activity`, label: "openJob" }] });
  }

  const enabled = items.filter((it) => it.enabled);
  if (enabled.some((it) => it.kind === "reminder") && !notifTypes.includes("reminder")) {
    out.push({ code: "reminders-off", severity: "error", fixes: [{ act: "link", href: "/dashboard/settings?section=notifications", label: "notifOn" }] });
  }
  const bots = enabled.filter((it) => it.kind === "bot_routine");
  if (bots.length && (engine === "absent" || !botDefsTable)) {
    out.push({ code: "engine-missing", severity: "error", count: bots.length, fixes: [{ act: "link", href: "/dashboard/settings?section=bot-runtime", label: "botRuntime" }] });
  } else if (bots.length && !runtimeOn) {
    out.push({ code: "runtime-off", severity: "error", count: bots.length, fixes: [{ act: "link", href: "/dashboard/settings?section=bot-runtime", label: "botRuntime" }] });
  }
  for (const it of bots) {
    const why = !it.botId ? "no-bot" : isVoiceBotId(it.botId) ? "voice-bot" : !it.bot ? "bot-missing" : !Number(it.bot.enabled) ? "bot-disabled" : !it.goal ? "no-goal" : null;
    if (why) { out.push({ code: "cant-run", severity: "error", why, scheduleId: it.id, item: it, fixes: [{ act: "pause" }, { act: "delete" }] }); continue; }
    if (it.nextRun !== null && it.nextRun < now - (grace + RUNNER_SLACK_MS)) {
      out.push({ code: "no-runner", severity: "warning", scheduleId: it.id, item: it, fixes: [{ act: "run-now" }, { act: "pause" }] });
    }
  }
  for (const it of enabled) {
    if (it.once || it.kind === "system" || it.kind === "briefing") continue;
    const unparseable = cronNext(it.cron, it.zone, now) === null;
    if (unparseable || (it.nextRun === null && (it.updatedAt === null || now - it.updatedAt > NO_NEXT_AFTER_MS))) {
      if (!out.some((p) => p.code === "cant-run" && p.scheduleId === it.id)) {
        out.push({ code: "no-next", severity: "error", scheduleId: it.id, item: it, fixes: [{ act: "pause" }, { act: "delete" }] });
      }
    }
  }
  return out.map((p, i) => ({ ...p, order: i })).sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || a.order - b.order);
}

/** notification_prefs.types_enabled, or the default (every type on). */
async function notifTypesOf(db) {
  try {
    const raw = await readSetting(db, "notification_prefs");
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v?.types_enabled) ? v.types_enabled : DEFAULT_TYPES;
  } catch { return DEFAULT_TYPES; }
}

/**
 * Everything the page shows.
 * @param {object} db
 * @param {{now?:number, lang?:string, selected?:number|null, engine?:()=>string, runtimeOn?:()=>Promise<boolean>}} opts
 *   engine: "ready" | "absent" | … (the bot engine's state); runtimeOn: the bot runtime flag.
 */
export async function buildScheduleModel(db, { now = Date.now(), lang = "en", selected = null, engine = () => "ready", runtimeOn = async () => true } = {}) {
  const zone = await instanceZone(db);
  const tz = (await hasTzColumn(db)) ? "tz" : "NULL AS tz";
  const rows = await safeRows(db, `SELECT id, task, cron_expression, description, enabled, last_run, next_run, updated_at, ${tz} FROM schedules ORDER BY id`);
  const briefingZone = await ownerZone(db, "media:briefing", zone);
  const botDefsTable = await tableExists(db, "pi_bot_defs");
  const bots = new Map();
  if (botDefsTable) for (const b of await safeRows(db, "SELECT bot_id, display_name, enabled FROM pi_bot_defs")) bots.set(String(b.bot_id), b);
  const items = rows.map((r) => toItem(r, { now, zone, briefingZone, bots, lang }));
  const ids = items.map((it) => it.id);
  const runsBy = await loadRuns(db, ids);
  const botIds = items.filter((it) => it.kind === "bot_routine").map((it) => it.id);
  const jobsBy = await loadBotJobs(db, botIds);
  const running = new Map();
  for (const [id, jobs] of jobsBy) { const j = jobs.find((x) => x.status === "running"); if (j) running.set(id, j); }
  const anyBots = items.some((it) => it.kind === "bot_routine" && it.enabled);
  const problems = problemsFor(items, {
    now, runsBy, jobsBy, notifTypes: await notifTypesOf(db),
    engine: anyBots ? engine() : "ready", botDefsTable, runtimeOn: anyBots ? await runtimeOn() : true,
  });
  const agenda = agendaGroups(items, { now, zone, running });

  let detail = null;
  const it = selected !== null ? items.find((x) => x.id === selected) : null;
  if (it) {
    let briefing = null;
    if (it.kind === "briefing" && (await tableExists(db, "media_briefings"))) {
      const b = (await safeRows(db, "SELECT id, status, scheduled_for, created_at FROM media_briefings ORDER BY id DESC LIMIT 1"))[0];
      if (b) briefing = { id: Number(b.id), status: b.status || "ready", at: parseMs(b.scheduled_for) ?? sqliteMs(b.created_at) };
    }
    detail = {
      item: it,
      next: nextRuns(it, now, 3),
      runs: runHistory(runsBy.get(it.id) || [], jobsBy.get(it.id) || [], 10),
      running: running.get(it.id) || null,
      briefing,
    };
  }
  return { now, zone, items, problems, agenda, detail, running };
}

/** The schedule a run belongs to (?run=<id> from a notification), or null. */
export async function scheduleOfRun(db, runId) {
  if (!Number.isInteger(runId) || runId <= 0 || !(await hasRunsTable(db))) return null;
  const r = (await safeRows(db, "SELECT schedule_id FROM schedule_runs WHERE id = ?", [runId]))[0];
  return r ? Number(r.schedule_id) : null;
}
