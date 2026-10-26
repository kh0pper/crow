/**
 * The Schedule panel's model (schedule panel PR 2): agenda grouping, every Crow-source problem's
 * detect rule and fix list, the detail's next runs and run history, and the panel's actions.
 * Real init-db into a tmpdir (never ~/.crow).
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { buildScheduleModel, agendaGroups, problemsFor, runHistory, scheduleOfRun } from "../servers/gateway/schedule-catalog.js";
import { createReminder, pauseSchedule, resumeSchedule, runScheduleNow, deleteScheduleRow, ackRun, previewWhen } from "../servers/gateway/schedule-actions.js";
import { _setNowForTest } from "../servers/gateway/scheduler.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-sched-catalog-"));
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe" });
const db = createDbClient(join(tmpDir, "crow.db"));
after(() => { _setNowForTest(null); try { db.close(); } catch {} rmSync(tmpDir, { recursive: true, force: true }); });

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
// Monday 2026-10-26, 15:00 UTC.
const NOW = Date.parse("2026-10-26T15:00:00.000Z");
_setNowForTest(() => NOW);
const iso = (ms) => new Date(ms).toISOString();
const all = async (sql, args = []) => (await db.execute({ sql, args })).rows;

beforeEach(async () => {
  await db.batch([
    "DELETE FROM schedules", "DELETE FROM schedule_runs", "DELETE FROM notifications", "DELETE FROM bot_jobs", "DELETE FROM pi_bot_defs",
    "DELETE FROM dashboard_settings WHERE key IN ('notification_prefs','media_briefing_config','instance_timezone','language','feature_flags')",
    "DELETE FROM dashboard_settings_overrides WHERE key IN ('notification_prefs','media_briefing_config','instance_timezone','language','feature_flags')",
  ]);
  await db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('instance_timezone', 'UTC')", args: [] });
});

async function seed(task, cron, nextRun, { tz = null, enabled = 1, description = null, lastRun = null } = {}) {
  const r = await db.execute({
    sql: "INSERT INTO schedules (task, cron_expression, next_run, tz, enabled, description, last_run) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [task, cron, nextRun, tz, enabled, description, lastRun],
  });
  return Number(r.lastInsertRowid);
}
async function bot(id, { enabled = 1 } = {}) {
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?, ?, '{}', ?)", args: [id, id.replace(/-/g, " "), enabled] });
}
const model = (opts = {}) => buildScheduleModel(db, { now: NOW, lang: "en", ...opts });
const codes = (m) => m.problems.map((p) => p.code);
const acts = (p) => p.fixes.map((f) => (f.act === "link" ? `link:${f.href}` : f.act));

test("an empty instance: no problems, an empty agenda", async () => {
  const m = await model();
  assert.deepEqual(m.problems, []);
  assert.equal(m.items.length, 0);
  assert.equal(m.zone, "UTC");
});

test("agenda: Now, Today, Tomorrow, weekdays, Later; the hourly-or-faster fold; paused; done in 7 days", async () => {
  const today = await seed("reminder:tea", "0 17 * * *", "2026-10-26T17:00:00.000Z");
  const tomorrow = await seed("reminder:bins", "0 7 * * 2", "2026-10-27T07:00:00.000Z");
  const friday = await seed("reminder:call mum", "@once", "2026-10-30T18:00:00.000Z");
  const later = await seed("reminder:rent", "0 9 1 * *", "2026-11-01T09:00:00.000Z");
  const far = await seed("reminder:taxes", "@once", "2026-12-01T09:00:00.000Z");
  await bot("lab-triage");
  const frequent = await seed("pipeline:botcron:lab-triage", "*/15 * * * *", "2026-10-26T15:15:00.000Z", { description: JSON.stringify({ goal: "triage" }) });
  const paused = await seed("reminder:old", "0 9 * * *", "2026-10-20T09:00:00.000Z", { enabled: 0 });
  const done = await seed("reminder:dentist", "@once", "2026-10-24T09:00:00.000Z", { enabled: 0, lastRun: "2026-10-24T09:00:10.000Z" });
  const stale = await seed("reminder:long ago", "@once", "2026-09-01T09:00:00.000Z", { enabled: 0, lastRun: "2026-09-01T09:00:10.000Z" });
  const g = (await model()).agenda;
  assert.deepEqual(g.days.map((d) => [d.offset, d.items.map((x) => x.id)]), [[0, [today]], [1, [tomorrow]], [4, [friday]], [6, [later]]]);
  assert.deepEqual(g.later.map((x) => x.id), [far]);
  assert.deepEqual(g.frequent.map((x) => x.id), [frequent]);
  assert.deepEqual(g.paused.map((x) => x.id), [paused]);
  assert.deepEqual(g.done.map((x) => x.id), [done]);
  assert.ok(![...g.days.flatMap((d) => d.items), ...g.later, ...g.paused, ...g.done].some((x) => x.id === stale), "a one-shot done more than 7 days ago is gone");
});

test("agenda days are the instance zone's", () => {
  const it = { id: 1, kind: "reminder", enabled: true, once: true, nextRun: Date.parse("2026-10-27T03:00:00Z"), cadence: null };
  assert.equal(agendaGroups([it], { now: NOW, zone: "UTC" }).days[0].offset, 1);
  assert.equal(agendaGroups([it], { now: NOW, zone: "America/Chicago" }).days[0].offset, 0, "22:00 on Monday in Chicago");
});

test("a reminder's times are in its own zone; the briefing in News's zone; each flags a zone that differs", async () => {
  await db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('media_briefing_config', ?)", args: [JSON.stringify({ tz: "Europe/Madrid" })] });
  const a = await seed("reminder:stand up", "0 9 * * 1-5", "2026-10-27T14:00:00.000Z", { tz: "America/Chicago" });
  const b = await seed("media:briefing", "0 7 * * *", "2026-10-27T06:00:00.000Z");
  const m = await model({ selected: a });
  const ia = m.items.find((x) => x.id === a), ib = m.items.find((x) => x.id === b);
  assert.equal(ia.zone, "America/Chicago"); assert.equal(ia.zoneDiffers, true);
  assert.equal(ia.summary, "Every weekday at 9:00 AM");
  assert.equal(ib.kind, "briefing"); assert.equal(ib.zone, "Europe/Madrid"); assert.equal(ib.owned, true);
  assert.deepEqual(m.detail.next.map(iso), ["2026-10-27T14:00:00.000Z", "2026-10-28T14:00:00.000Z", "2026-10-29T14:00:00.000Z"]);
});

test("problem: missed run(s) → Run now + Dismiss; a dismissed one is gone", async () => {
  const id = await seed("reminder:stretch", "0 9 * * *", "2026-10-27T09:00:00.000Z");
  const r = await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, scheduled_for, status, missed_count, detail) VALUES (?, '2026-10-24T09:00:00.000Z', 'missed', 3, ?)", args: [id, JSON.stringify({ last_missed: "2026-10-26T09:00:00.000Z" })] });
  let m = await model();
  assert.deepEqual(codes(m), ["missed"]);
  assert.deepEqual(acts(m.problems[0]), ["run-now", "ack-run"]);
  assert.equal(m.problems[0].runId, Number(r.lastInsertRowid));
  assert.equal((await ackRun(db, Number(r.lastInsertRowid), { now: NOW })).ok, true);
  m = await model();
  assert.deepEqual(codes(m), []);
});

test("problem: the latest run failed → Run now + Dismiss (reminder); a later good run clears it", async () => {
  const id = await seed("reminder:water", "0 9 * * *", "2026-10-27T09:00:00.000Z");
  await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, scheduled_for, status, detail) VALUES (?, '2026-10-26T09:00:00.000Z', 'failed', ?)", args: [id, JSON.stringify({ error: "push down" })] });
  let m = await model({ selected: id });
  assert.deepEqual(codes(m), ["failed"]);
  assert.deepEqual(acts(m.problems[0]), ["run-now", "ack-run"]);
  assert.equal(m.detail.runs[0].error, "push down");
  await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, ran_at, status, source) VALUES (?, ?, 'ok', 'run-now')", args: [id, iso(NOW)] });
  m = await model();
  assert.deepEqual(codes(m), []);
});

test("problem: a bot job behind the latest run failed → Run now + Open job + Dismiss", async () => {
  await bot("lab-triage");
  const id = await seed("pipeline:botcron:lab-triage", "0 9 * * *", iso(NOW + HOUR), { description: JSON.stringify({ goal: "triage" }) });
  await db.execute({ sql: "INSERT INTO bot_jobs (job_id, bot_id, goal, status, source, schedule_id, error) VALUES ('job-a', 'lab-triage', 'triage', 'failed', 'schedule', ?, 'pi crashed')", args: [id] });
  await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, ran_at, status, source, job_id) VALUES (?, ?, 'ok', 'run-now', 'job-a')", args: [id, iso(NOW - HOUR)] });
  const m = await model({ selected: id });
  assert.deepEqual(codes(m), ["failed"]);
  assert.deepEqual(acts(m.problems[0]), ["run-now", "link:/dashboard/bot-builder?bot=lab-triage&tab=activity", "ack-run"]);
  assert.equal(m.detail.runs[0].status, "job-failed");
  assert.equal(m.detail.runs.length, 1, "the job is not listed twice");
});

test("problem: reminders can't reach you (notification type off) → link to Settings → Notifications", async () => {
  await seed("reminder:x", "0 9 * * *", "2026-10-27T09:00:00.000Z");
  await db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('notification_prefs', ?)", args: [JSON.stringify({ types_enabled: ["system"] })] });
  const m = await model();
  assert.deepEqual(codes(m), ["reminders-off"]);
  assert.deepEqual(acts(m.problems[0]), ["link:/dashboard/settings?section=notifications"]);
});

test("problem: a bot routine waiting for a runner → Run now + Pause; within grace + 2 min it is not", async () => {
  await bot("lab-triage");
  const late = await seed("pipeline:botcron:lab-triage", "0 9 * * *", iso(NOW - 8 * MIN), { description: JSON.stringify({ goal: "triage" }) });
  await seed("pipeline:botcron:lab-triage", "0 9 * * *", iso(NOW - 6 * MIN), { description: JSON.stringify({ goal: "triage", label: "fresh" }) });
  const m = await model();
  const waiting = m.problems.filter((p) => p.code === "no-runner");
  assert.deepEqual(waiting.map((p) => p.scheduleId), [late]);
  assert.deepEqual(acts(waiting[0]), ["run-now", "pause"]);
});

test("problem: paused during the upgrade → Turn back on + Delete + Dismiss (no Turn back on for a system row)", async () => {
  const a = await seed("check the logs", "*/5 * * * *", null, { enabled: 0 });
  const s = await seed("pipeline:legacy", "0 9 * * *", null, { enabled: 0 });
  for (const [id, reason] of [[a, "frequent"], [s, "system"]]) {
    await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, scheduled_for, status, source, detail) VALUES (?, 'upgrade:0009', 'paused', 'upgrade', ?)", args: [id, JSON.stringify({ reason, every_min: 5 })] });
  }
  const m = await model();
  const by = Object.fromEntries(m.problems.map((p) => [p.scheduleId, acts(p)]));
  assert.deepEqual(by[a], ["resume", "delete", "ack-run"]);
  assert.deepEqual(by[s], ["delete", "ack-run"]);
});

test("problem: bot engine not installed / bot runtime off → Open Bot Runtime settings", async () => {
  await bot("lab-triage");
  await seed("pipeline:botcron:lab-triage", "0 9 * * *", iso(NOW + HOUR), { description: JSON.stringify({ goal: "triage" }) });
  let m = await model({ engine: () => "absent" });
  assert.deepEqual(codes(m), ["engine-missing"]);
  assert.deepEqual(acts(m.problems[0]), ["link:/dashboard/settings?section=bot-runtime"]);
  m = await model({ runtimeOn: async () => false });
  assert.deepEqual(codes(m), ["runtime-off"]);
  m = await model();
  assert.deepEqual(codes(m), []);
});

test("problem: a bot routine that can't run (missing / disabled / voice bot / no goal) → Pause + Delete", async () => {
  await bot("off-bot", { enabled: 0 });
  const missing = await seed("pipeline:botcron:ghost", "0 9 * * *", iso(NOW + HOUR), { description: JSON.stringify({ goal: "x" }) });
  const disabled = await seed("pipeline:botcron:off-bot", "0 9 * * *", iso(NOW + HOUR), { description: JSON.stringify({ goal: "x" }) });
  const voice = await seed("pipeline:botcron:crow.voice", "0 9 * * *", iso(NOW + HOUR), { description: JSON.stringify({ goal: "x" }) });
  await bot("lab-triage");
  const nogoal = await seed("pipeline:botcron:lab-triage", "0 9 * * *", iso(NOW + HOUR), { description: "{}" });
  const m = await model();
  const cant = m.problems.filter((p) => p.code === "cant-run");
  assert.deepEqual(Object.fromEntries(cant.map((p) => [p.scheduleId, p.why])), { [missing]: "bot-missing", [disabled]: "bot-disabled", [voice]: "voice-bot", [nogoal]: "no-goal" });
  for (const p of cant) assert.deepEqual(acts(p), ["pause", "delete"]);
});

test("problem: a recurring schedule with no next run (unparseable cron) → Pause + Delete", async () => {
  const id = await seed("reminder:broken", "61 9 * * *", null);
  const m = await model();
  assert.deepEqual(m.problems.map((p) => [p.code, p.scheduleId]), [["no-next", id]]);
  assert.deepEqual(acts(m.problems[0]), ["pause", "delete"]);
});

test("errors come before warnings", () => {
  const items = [{ id: 1, kind: "reminder", enabled: true, once: false, cron: "0 9 * * *", zone: "UTC", nextRun: NOW + HOUR, updatedAt: NOW }];
  const runsBy = new Map([[1, [{ id: 9, status: "missed", acknowledged_at: null }]]]);
  const p = problemsFor(items, { now: NOW, runsBy, notifTypes: [] });
  assert.deepEqual(p.map((x) => x.code), ["reminders-off", "missed"]);
});

test("run history: missed windows, run-now rows, bot jobs with no run row, newest first, at most 10", () => {
  const runs = [
    { id: 3, status: "missed", scheduled_for: "2026-10-24T09:00:00.000Z", missed_count: 3, detail: JSON.stringify({ last_missed: "2026-10-26T09:00:00.000Z" }) },
    { id: 2, status: "ok", source: "run-now", ran_at: "2026-10-23T10:00:00.000Z", job_id: "job-b", job_status: "completed" },
  ];
  const jobs = [{ job_id: "job-b", status: "completed", created_at: "2026-10-23 10:00:00" }, { job_id: "job-c", status: "queued", created_at: "2026-10-25 08:00:00" }];
  const h = runHistory(runs, jobs);
  assert.deepEqual(h.map((x) => [x.status, x.jobId]), [["missed", null], ["job-queued", "job-c"], ["job-completed", "job-b"]]);
  assert.equal(h[0].count, 3);
  assert.equal(iso(h[0].last), "2026-10-26T09:00:00.000Z");
});

test("?run=<id> finds its schedule", async () => {
  const id = await seed("reminder:x", "0 9 * * *", "2026-10-27T09:00:00.000Z");
  const r = await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, status) VALUES (?, 'missed')", args: [id] });
  assert.equal(await scheduleOfRun(db, Number(r.lastInsertRowid)), id);
  assert.equal(await scheduleOfRun(db, 999999), null);
});

// ---------------------------------------------------------------- actions

test("create: plain words → a reminder: prefixed task, next run, NULL zone when it is the instance's", async () => {
  const r = await createReminder(db, { text: "  take the bins out ", when: "every tuesday at 7", tz: "UTC", lang: "en", now: NOW });
  assert.equal(r.ok, true);
  const [row] = await all("SELECT * FROM schedules WHERE id = ?", [r.id]);
  assert.equal(row.task, "reminder:take the bins out");
  assert.equal(row.cron_expression, "0 7 * * 2");
  assert.equal(row.next_run, "2026-10-27T07:00:00.000Z");
  assert.equal(row.tz, null);
});

test("create: the browser's zone is stored when it differs from the instance's", async () => {
  const r = await createReminder(db, { text: "stand up", when: "every weekday at 9", tz: "America/Chicago", lang: "en", now: NOW });
  const [row] = await all("SELECT * FROM schedules WHERE id = ?", [r.id]);
  assert.equal(row.tz, "America/Chicago");
  assert.equal(row.next_run, "2026-10-27T14:00:00.000Z");
});

test("create: one time, Spanish words, the advanced cron field", async () => {
  const a = await createReminder(db, { text: "llamar", when: "mañana a las 9", lang: "es", now: NOW });
  assert.equal(a.ok, true);
  const [ra] = await all("SELECT * FROM schedules WHERE id = ?", [a.id]);
  assert.equal(ra.cron_expression, "@once");
  assert.equal(ra.next_run, "2026-10-27T09:00:00.000Z");
  const b = await createReminder(db, { text: "raw", when: "ignored words", cron: "30 8 * * 1", lang: "en", now: NOW });
  assert.equal(b.ok, true);
  assert.equal((await all("SELECT cron_expression FROM schedules WHERE id = ?", [b.id]))[0].cron_expression, "30 8 * * 1");
});

test("create refuses: empty text, too long, pipeline text, unknown words, more often than hourly", async () => {
  assert.equal((await createReminder(db, { text: " ", when: "every day at 9", lang: "en", now: NOW })).code, "empty-text");
  assert.equal((await createReminder(db, { text: "x".repeat(1001), when: "every day at 9", lang: "en", now: NOW })).code, "text-too-long");
  assert.equal((await createReminder(db, { text: "reminder:pipeline:x", when: "every day at 9", lang: "en", now: NOW })).ok, true, "a reminder may mention pipeline after its prefix");
  const bad = await createReminder(db, { text: "x", when: "whenever", lang: "en", now: NOW });
  assert.equal(bad.code, "bad-when"); assert.match(bad.hint, /couldn't tell when/);
  const often = await createReminder(db, { text: "x", when: "every 15 minutes", lang: "en", now: NOW });
  assert.equal(often.code, "bad-when"); assert.match(often.hint, /at most once an hour/);
  const rawOften = await createReminder(db, { text: "x", when: "", cron: "*/5 * * * *", lang: "en", now: NOW });
  assert.equal(rawOften.code, "bad-when");
  assert.equal((await all("SELECT COUNT(*) AS n FROM schedules"))[0].n, 1);
});

test("preview: the read-back and the next 3 runs, in the given zone", async () => {
  const p = await previewWhen(db, { when: "every weekday at 8", tz: "America/Chicago", lang: "en", now: NOW });
  assert.equal(p.ok, true);
  assert.equal(p.summary, "Every weekday at 8:00 AM");
  assert.equal(p.next3.length, 3);
  assert.equal(p.zone, "America/Chicago");
  assert.equal((await previewWhen(db, { when: "every day at 9", tz: "Not/AZone", lang: "en", now: NOW })).zone, "UTC", "an unknown zone falls back to the instance's");
});

test("pause, then resume recomputes next_run from now in the row's zone", async () => {
  const id = await seed("reminder:x", "0 9 * * *", "2026-10-20T09:00:00.000Z", { tz: "America/Chicago" });
  assert.equal((await pauseSchedule(db, id)).ok, true);
  assert.equal((await all("SELECT enabled FROM schedules WHERE id = ?", [id]))[0].enabled, 0);
  assert.equal((await resumeSchedule(db, id, { now: NOW })).ok, true);
  const [row] = await all("SELECT * FROM schedules WHERE id = ?", [id]);
  assert.equal(row.enabled, 1);
  assert.equal(row.next_run, "2026-10-27T14:00:00.000Z");
});

test("resume refuses a one-shot whose time has passed, and a system row; the briefing is News's", async () => {
  const once = await seed("reminder:x", "@once", "2026-10-25T09:00:00.000Z", { enabled: 0 });
  assert.equal((await resumeSchedule(db, once, { now: NOW })).code, "once-passed");
  const future = await seed("reminder:y", "@once", "2026-10-28T09:00:00.000Z", { enabled: 0 });
  assert.equal((await resumeSchedule(db, future, { now: NOW })).ok, true);
  assert.equal((await all("SELECT next_run FROM schedules WHERE id = ?", [future]))[0].next_run, "2026-10-28T09:00:00.000Z");
  const sys = await seed("pipeline:legacy", "0 9 * * *", null, { enabled: 0 });
  assert.equal((await resumeSchedule(db, sys, { now: NOW })).code, "not-runnable");
  const b = await seed("media:briefing", "0 7 * * *", "2026-10-27T07:00:00.000Z");
  for (const f of [pauseSchedule, resumeSchedule, runScheduleNow, deleteScheduleRow]) assert.equal((await f(db, b, { now: NOW })).code, "owned");
});

test("run now: a reminder delivers now and records a run-now run without moving next_run", async () => {
  const id = await seed("reminder:stretch", "0 9 * * *", "2026-10-27T09:00:00.000Z");
  assert.equal((await runScheduleNow(db, id, { now: NOW })).ok, true);
  assert.equal((await all("SELECT title FROM notifications WHERE source = 'scheduler'"))[0].title, "stretch");
  const [run] = await all("SELECT * FROM schedule_runs WHERE schedule_id = ?", [id]);
  assert.equal(run.source, "run-now"); assert.equal(run.status, "ok");
  assert.equal((await all("SELECT next_run FROM schedules WHERE id = ?", [id]))[0].next_run, "2026-10-27T09:00:00.000Z");
});

test("run now: a bot routine enqueues one job (coalesced while queued) with a run-now run carrying its id", async () => {
  await bot("lab-triage");
  const id = await seed("pipeline:botcron:lab-triage", "0 9 * * *", iso(NOW - HOUR), { description: JSON.stringify({ goal: "triage the inbox", deliver_to: { kind: "poll" } }) });
  const a = await runScheduleNow(db, id, { now: NOW });
  assert.equal(a.ok, true); assert.ok(a.jobId);
  const b = await runScheduleNow(db, id, { now: NOW + 1 });
  assert.equal(b.already, true);
  const jobs = await all("SELECT * FROM bot_jobs WHERE schedule_id = ?", [id]);
  assert.equal(jobs.length, 1);
  assert.deepEqual([jobs[0].bot_id, jobs[0].goal, jobs[0].status, jobs[0].source, jobs[0].deliver_to], ["lab-triage", "triage the inbox", "queued", "schedule", '{"kind":"poll"}']);
  const runs = await all("SELECT * FROM schedule_runs WHERE schedule_id = ?", [id]);
  assert.equal(runs.length, 1); assert.equal(runs[0].job_id, a.jobId); assert.equal(runs[0].source, "run-now");
  assert.equal((await all("SELECT next_run FROM schedules WHERE id = ?", [id]))[0].next_run, iso(NOW - HOUR), "next_run untouched");
});

test("run now refuses a bot routine that can't run and a system row", async () => {
  const ghost = await seed("pipeline:botcron:ghost", "0 9 * * *", iso(NOW + HOUR), { description: JSON.stringify({ goal: "x" }) });
  assert.equal((await runScheduleNow(db, ghost, { now: NOW })).code, "cant-run");
  const sys = await seed("pipeline:legacy", "0 9 * * *", null);
  assert.equal((await runScheduleNow(db, sys, { now: NOW })).code, "not-runnable");
  assert.equal((await all("SELECT COUNT(*) AS n FROM bot_jobs"))[0].n, 0);
});

test("delete removes the schedule and its runs; a bot routine only through the botcron guard", async () => {
  const id = await seed("reminder:x", "0 9 * * *", "2026-10-27T09:00:00.000Z");
  await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, status) VALUES (?, 'ok'), (?, 'missed')", args: [id, id] });
  assert.equal((await deleteScheduleRow(db, id)).ok, true);
  assert.equal((await all("SELECT COUNT(*) AS n FROM schedules"))[0].n, 0);
  assert.equal((await all("SELECT COUNT(*) AS n FROM schedule_runs"))[0].n, 0);
  await bot("lab-triage");
  const b = await seed("pipeline:botcron:lab-triage", "0 9 * * *", iso(NOW + HOUR), { description: "{}" });
  assert.equal((await deleteScheduleRow(db, b)).ok, true);
  assert.equal((await deleteScheduleRow(db, b)).code, "not-found");
});
