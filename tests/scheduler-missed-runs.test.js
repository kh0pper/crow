/**
 * The scheduler's run history, missed runs and notify-once (schedule panel PR 1).
 * Real init-db into a tmpdir (never ~/.crow); the clock is the _setNowForTest seam.
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { _tickForTest, _bootRecomputeForTest, _setNowForTest, _resetForTest, runNow } from "../servers/gateway/scheduler.js";
import { registerSchedulerHook, unregisterSchedulerHook } from "../servers/gateway/scheduler-hooks.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-missed-test-"));
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe" });
const db = createDbClient(join(tmpDir, "crow.db"));
after(() => { _setNowForTest(null); try { db.close(); } catch {} rmSync(tmpDir, { recursive: true, force: true }); });

const MIN = 60_000, HOUR = 3_600_000;
const NOW = Date.parse("2026-10-26T15:00:30.000Z");
let clock = NOW;
_setNowForTest(() => clock);
const iso = (ms) => new Date(ms).toISOString();

beforeEach(async () => {
  clock = NOW;
  _resetForTest();
  await db.batch([
    "DELETE FROM schedules", "DELETE FROM schedule_runs", "DELETE FROM notifications",
    "DELETE FROM dashboard_settings WHERE key IN ('notification_prefs','media_briefing_config','instance_timezone','language')",
    "DELETE FROM dashboard_settings_overrides WHERE key IN ('notification_prefs','media_briefing_config','instance_timezone','language')",
  ]);
  await db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('instance_timezone', 'UTC')", args: [] });
});

async function seed(task, cron, nextRun, { tz = null, enabled = 1 } = {}) {
  const r = await db.execute({
    sql: "INSERT INTO schedules (task, cron_expression, next_run, tz, enabled) VALUES (?, ?, ?, ?, ?)",
    args: [task, cron, nextRun, tz, enabled],
  });
  return Number(r.lastInsertRowid);
}
const all = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const row = async (id) => (await all("SELECT * FROM schedules WHERE id = ?", [id]))[0];
const runs = (id) => all("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY id", [id]);
const delivered = () => all("SELECT * FROM notifications WHERE source = 'scheduler' ORDER BY id");
const notices = () => all("SELECT * FROM notifications WHERE source = 'scheduler:missed' ORDER BY id");
async function boot() { await _bootRecomputeForTest(db); await _tickForTest(db); }

test("a restart across a fire time within grace still fires", async () => {
  const due = Date.parse("2026-10-26T15:00:00Z") - 2 * MIN; // 14:58, a */1-free daily-ish grid point
  const id = await seed("reminder:stand up", "58 14 * * *", iso(due));
  await boot();
  assert.equal((await delivered()).length, 1);
  assert.equal((await delivered())[0].title, "stand up");
  const r = await runs(id);
  assert.equal(r.length, 1);
  assert.equal(r[0].status, "late");
  assert.equal(r[0].scheduled_for, iso(due));
  assert.ok(r[0].ran_at);
  assert.equal((await row(id)).next_run, "2026-10-27T14:58:00.000Z");
  assert.equal((await notices()).length, 0);
});

test("beyond grace: a missed window, no delivery, exactly one notice, and a second boot adds nothing", async () => {
  const id = await seed("reminder:stretch", "0 9 * * *", "2026-10-26T09:00:00.000Z");
  await boot();
  assert.equal((await delivered()).length, 0, "no catch-up for a repeating schedule");
  const r = await runs(id);
  assert.equal(r.length, 1);
  assert.equal(r[0].status, "missed");
  assert.equal(r[0].missed_count, 1);
  assert.ok(r[0].notified_at);
  const n = await notices();
  assert.equal(n.length, 1);
  assert.match(n[0].title, /stretch/);
  assert.equal(n[0].type, "reminder");
  assert.equal(Number(n[0].schedule_id), id);
  assert.equal((await row(id)).next_run, "2026-10-27T09:00:00.000Z");
  clock += 30_000;
  await boot();
  assert.equal((await notices()).length, 1);
  assert.equal((await runs(id)).length, 1);
});

test("two schedules missed in one pass → one summary notice", async () => {
  await seed("reminder:a", "0 9 * * *", "2026-10-26T09:00:00.000Z");
  await seed("reminder:b", "0 10 * * *", "2026-10-25T10:00:00.000Z");
  await boot();
  const n = await notices();
  assert.equal(n.length, 1);
  assert.match(n[0].title, /2 schedules/);
  assert.equal(n[0].schedule_id, null);
});

test("C2: a notify that throws after the mark, then another tick → never a second notice", async () => {
  const id = await seed("reminder:x", "0 9 * * *", "2026-10-26T09:00:00.000Z");
  let armed = true;
  const flaky = {
    execute: async (arg) => {
      const sql = typeof arg === "string" ? arg : arg.sql;
      if (armed && /INSERT INTO notifications/.test(sql)) { armed = false; throw new Error("boom"); }
      return db.execute(arg);
    },
    batch: (...a) => db.batch(...a),
  };
  const warn = console.error; console.error = () => {};
  try { await _bootRecomputeForTest(flaky); await _tickForTest(flaky); } finally { console.error = warn; }
  await _tickForTest(db);
  await _tickForTest(db);
  assert.ok((await notices()).length <= 1);
  assert.ok((await runs(id))[0].notified_at, "marked before notifying");
});

test("C2: two ticks on one database → one delivery, one run row, one notice", async () => {
  const fire = await seed("reminder:race", "0 15 * * *", "2026-10-26T15:00:00.000Z");
  const miss = await seed("reminder:old", "0 9 * * *", "2026-10-26T09:00:00.000Z");
  await Promise.all([_tickForTest(db), _tickForTest(db)]);
  assert.equal((await delivered()).length, 1);
  assert.equal((await runs(fire)).length, 1);
  assert.equal((await runs(miss)).length, 1);
  assert.equal((await notices()).length, 1);
});

test("a muted reminder type: marked, nothing created, no retry", async () => {
  await db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('notification_prefs', ?)", args: [JSON.stringify({ types_enabled: ["system"] })] });
  const id = await seed("reminder:muted", "0 9 * * *", "2026-10-26T09:00:00.000Z");
  await boot();
  await _tickForTest(db);
  assert.equal((await notices()).length, 0);
  assert.ok((await runs(id))[0].notified_at);
});

test("a plain-text row (#364 shape) delivers as a reminder", async () => {
  await seed("water the plants", "0 15 * * *", "2026-10-26T15:00:00.000Z");
  await _tickForTest(db);
  const d = await delivered();
  assert.equal(d.length, 1);
  assert.equal(d[0].title, "water the plants");
  assert.equal(d[0].type, "reminder");
});

test("a pipeline: row is never delivered or advanced by this scheduler", async () => {
  const id = await seed("pipeline:old-runner", "0 15 * * *", "2026-10-26T15:00:00.000Z");
  const bot = await seed("pipeline:botcron:lab", "0 15 * * *", "2026-10-26T15:00:00.000Z");
  await boot();
  assert.equal((await delivered()).length, 0);
  assert.equal((await row(id)).next_run, "2026-10-26T15:00:00.000Z");
  assert.equal((await row(bot)).next_run, "2026-10-26T15:00:00.000Z");
  assert.equal((await runs(id)).length + (await runs(bot)).length, 0);
});

test("D7: a one-shot missed while Crow was down fires once, late, with '(late)'", async () => {
  let spoke = [];
  registerSchedulerHook("t-late", { reminder: async (_db, r) => { spoke.push(r); } });
  try {
    const id = await seed("reminder:call the vet", "@once", iso(NOW - 3 * HOUR));
    await boot();
    await _tickForTest(db);
    const d = await delivered();
    assert.equal(d.length, 1);
    assert.equal(d[0].title, "call the vet (late)");
    assert.deepEqual(spoke, [{ type: "reminder", text: "call the vet", late: true }]);
    const r = await runs(id);
    assert.equal(r.length, 1);
    assert.equal(r[0].status, "late");
    assert.equal(Number((await row(id)).enabled), 0);
    assert.equal((await notices()).length, 0, "a fired one-shot is not also a missed notice");
  } finally { unregisterSchedulerHook("t-late"); }
});

test("Spanish instance: the late note and the missed notice are in Spanish", async () => {
  await db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('language', 'es')", args: [] });
  await seed("reminder:llamar", "@once", iso(NOW - 3 * HOUR));
  await seed("reminder:estirar", "0 9 * * *", "2026-10-26T09:00:00.000Z");
  await boot();
  assert.equal((await delivered())[0].title, "llamar (tarde)");
  assert.match((await notices())[0].title, /Recordatorio perdido: estirar/);
});

test("a requested run executes exactly once and leaves next_run alone", async () => {
  const id = await seed("reminder:now please", "0 9 * * *", "2026-10-27T09:00:00.000Z");
  await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, status, source) VALUES (?, 'requested', 'run-now')", args: [id] });
  await Promise.all([_tickForTest(db), _tickForTest(db)]);
  await _tickForTest(db);
  assert.equal((await delivered()).length, 1);
  const r = await runs(id);
  assert.equal(r.length, 1);
  assert.equal(r[0].status, "ok");
  assert.equal(r[0].source, "run-now");
  assert.equal((await row(id)).next_run, "2026-10-27T09:00:00.000Z");
});

test("a request nobody ran for an hour fails with 'no runner'", async () => {
  const id = await seed("reminder:stale", "0 9 * * *", "2026-10-27T09:00:00.000Z");
  await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, status, source, created_at) VALUES (?, 'requested', 'run-now', datetime('now', '-2 hours'))", args: [id] });
  await _tickForTest(db);
  const r = await runs(id);
  assert.equal(r[0].status, "failed");
  assert.equal(JSON.parse(r[0].detail).error, "no runner");
  assert.equal((await delivered()).length, 0);
});

test("runNow refuses anything but a reminder", async () => {
  const bot = await seed("pipeline:botcron:lab", "0 9 * * *", null);
  const brief = await seed("media:briefing", "0 8 * * *", null);
  for (const id of [bot, brief]) {
    const res = await runNow(db, await row(id));
    assert.equal(res.ok, false);
  }
  const rem = await seed("reminder:go", "0 9 * * *", "2026-10-27T09:00:00.000Z");
  const res = await runNow(db, await row(rem));
  assert.equal(res.ok, true);
  assert.equal((await delivered()).length, 1);
  assert.equal((await runs(rem))[0].source, "run-now");
});

test("the briefing row advances in News's zone and records nothing", async () => {
  await db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('media_briefing_config', ?)", args: [JSON.stringify({ tz: "Asia/Tokyo" })] });
  const id = await seed("media:briefing", "0 8 * * *", "2026-10-26T14:59:00.000Z");
  await _tickForTest(db);
  assert.equal((await row(id)).next_run, "2026-10-26T23:00:00.000Z", "08:00 in Tokyo");
  assert.equal((await runs(id)).length, 0);
  assert.equal((await delivered()).length + (await notices()).length, 0);
  // and at boot a future briefing next_run is recomputed in that zone too
  await db.execute({ sql: "UPDATE schedules SET next_run = '2026-10-27T08:00:00.000Z' WHERE id = ?", args: [id] });
  await _bootRecomputeForTest(db);
  assert.equal((await row(id)).next_run, "2026-10-26T23:00:00.000Z");
});

test("a row's own zone wins over the instance zone", async () => {
  const id = await seed("reminder:madrid", "0 9 * * *", null, { tz: "Europe/Madrid" });
  await _tickForTest(db);
  assert.equal((await row(id)).next_run, "2026-10-27T08:00:00.000Z", "09:00 CET");
});

test("an upgrade-paused row gets one notice", async () => {
  const id = await seed("check the logs", "*/5 * * * *", null, { enabled: 0 });
  await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, status, source, detail) VALUES (?, 'paused', 'upgrade', ?)", args: [id, JSON.stringify({ reason: "frequent", every_min: 5 })] });
  await _tickForTest(db);
  await _tickForTest(db);
  const n = await notices();
  assert.equal(n.length, 1);
  assert.match(n[0].title, /Paused during the upgrade: check the logs/);
  assert.match(n[0].body, /every 5 minutes/);
});

test("retention prunes orphaned runs", async () => {
  const id = await seed("reminder:keep", "0 9 * * *", "2026-10-27T09:00:00.000Z");
  await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, status, notified_at) VALUES (?, 'ok', 'x'), (99999, 'missed', 'x')", args: [id] });
  await _tickForTest(db);
  assert.equal((await all("SELECT COUNT(*) AS n FROM schedule_runs WHERE schedule_id = 99999"))[0].n, 0);
  assert.equal((await runs(id)).length, 1);
});

test("notices carry no link and no pointer to a page that does not exist yet", async () => {
  const id = await seed("check the logs", "*/5 * * * *", null, { enabled: 0 });
  await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, status, source, detail) VALUES (?, 'paused', 'upgrade', ?)", args: [id, JSON.stringify({ reason: "frequent", every_min: 5 })] });
  await seed("reminder:a", "0 9 * * *", "2026-10-26T09:00:00.000Z");
  await _tickForTest(db);
  await seed("reminder:b", "0 10 * * *", "2026-10-26T10:00:00.000Z");
  await seed("reminder:c", "0 11 * * *", "2026-10-26T11:00:00.000Z");
  await _tickForTest(db);
  const n = await notices();
  assert.ok(n.length >= 2);
  for (const x of n) {
    assert.equal(x.action_url, null);
    assert.doesNotMatch(`${x.title} ${x.body}`, /Schedule|Agenda/);
  }
});

test("a run left 'running' by a crash is marked interrupted after ten minutes", async () => {
  const id = await seed("reminder:crash", "0 9 * * *", "2026-10-27T09:00:00.000Z");
  await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, status, source, ran_at) VALUES (?, 'running', 'run-now', ?)", args: [id, iso(NOW - 11 * MIN)] });
  await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, status, source, ran_at) VALUES (?, 'running', 'run-now', ?)", args: [id, iso(NOW - 1 * MIN)] });
  await _tickForTest(db);
  const r = await runs(id);
  assert.equal(r[0].status, "failed");
  assert.equal(JSON.parse(r[0].detail).error, "interrupted");
  assert.equal(r[1].status, "running", "a fresh one is left alone");
});

test("a slow tick (a hook taking ten minutes) does not turn a row that came due meanwhile into a miss", async () => {
  registerSchedulerHook("t-slow", { tick: async () => { clock += 10 * MIN; } });
  try {
    await _tickForTest(db); // starts at NOW; its hook ends at NOW + 10 min
    const id = await seed("reminder:during the hook", "5 15 * * *", "2026-10-26T15:05:00.000Z");
    clock += 5 * MIN; // the next tick starts at NOW + 15 min: beyond grace for 15:05
    await _tickForTest(db);
    const r = await runs(id);
    assert.equal(r.length, 1);
    assert.equal(r[0].status, "late");
    assert.equal((await delivered()).length, 1);
  } finally { unregisterSchedulerHook("t-slow"); }
});

test("a missed bot-routine window written with missedRunInsert gets the bot-cron wording, once", async () => {
  const { missedRunInsert } = await import("../servers/shared/schedule-core.js");
  const a = await seed("pipeline:botcron:lab-triage", "0 9 * * *", "2026-10-27T09:00:00.000Z");
  const w = missedRunInsert(a, { first: "2026-10-26T09:00:00.000Z", last: "2026-10-26T09:00:00.000Z", count: 1, capped: false });
  await db.execute(w);
  await db.execute(w); // the same window twice is one row
  assert.equal((await runs(a)).length, 1);
  await _tickForTest(db);
  await _tickForTest(db);
  const n = await notices();
  assert.equal(n.length, 1);
  assert.equal(n[0].title, "Missed: lab-triage routine");
  assert.equal(n[0].type, "system");
  const b = await seed("pipeline:botcron:writer", "0 9 * * *", "2026-10-27T09:00:00.000Z");
  const c = await seed("pipeline:botcron:helper", "0 9 * * *", "2026-10-27T09:00:00.000Z");
  for (const id of [b, c]) await db.execute(missedRunInsert(id, { first: Date.parse("2026-10-26T09:00:00Z"), last: Date.parse("2026-10-26T09:00:00Z"), count: 1, capped: false }));
  await _tickForTest(db);
  const n2 = await notices();
  assert.equal(n2.length, 2);
  assert.equal(n2[1].title, "2 bot routines missed runs while Crow wasn't running");
});

test("sweepMissedNotices: two handles racing on one database deliver exactly one notice per row", async () => {
  const { sweepMissedNotices } = await import("../servers/gateway/scheduler.js");
  const ids = [];
  for (const t of ["a", "b", "c"]) {
    const id = await seed(`reminder:${t}`, "0 9 * * *", "2026-10-27T09:00:00.000Z");
    await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, scheduled_for, status, missed_count) VALUES (?, '2026-10-26T09:00:00.000Z', 'missed', 1)", args: [id] });
    ids.push(id);
  }
  const second = createDbClient(join(tmpDir, "crow.db"));
  const sent = []; // [handle, run ids covered]
  const notify = (who) => async (_db, note, runIds) => { sent.push([who, [...runIds]]); };
  // Handle A reads the candidates, then handle B runs a whole sweep before A claims.
  const first = {
    execute: async (arg) => {
      const res = await db.execute(arg);
      const sql = typeof arg === "string" ? arg : arg.sql;
      if (/^SELECT r\.id/.test(sql.trim())) await sweepMissedNotices(second, { notify: notify("B"), zone: "UTC", lang: "en" });
      return res;
    },
    batch: (...a) => db.batch(...a),
  };
  try {
    const a = await sweepMissedNotices(first, { notify: notify("A"), zone: "UTC", lang: "en" });
    const covered = sent.flatMap(([, r]) => r).sort((x, y) => x - y);
    const runIds = (await all("SELECT id FROM schedule_runs ORDER BY id")).map((r) => Number(r.id));
    assert.deepEqual(covered, runIds, "every row is covered exactly once across both sweeps");
    assert.equal(sent.length, 1, "one summary notice, from the sweep that claimed");
    assert.equal(sent[0][0], "B");
    assert.deepEqual(a.claimed, [], "the sweep that lost the claim delivers nothing");
    assert.equal((await notices()).length, 0, "a custom notify replaces createNotification");
    const again = await sweepMissedNotices(db, { zone: "UTC", lang: "en" });
    assert.deepEqual(again.claimed, []);
  } finally { second.close(); }
});

test("sweepMissedNotices defaults to createNotification, reading zone and language from the instance", async () => {
  const { sweepMissedNotices } = await import("../servers/gateway/scheduler.js");
  const id = await seed("pipeline:botcron:lab", "0 9 * * *", "2026-10-27T09:00:00.000Z");
  await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, scheduled_for, status, missed_count) VALUES (?, '2026-10-26T09:00:00.000Z', 'missed', 1)", args: [id] });
  const r = await sweepMissedNotices(db);
  assert.equal(r.claimed.length, 1);
  const n = await notices();
  assert.equal(n.length, 1);
  assert.equal(n[0].title, "Missed: lab routine");
});
