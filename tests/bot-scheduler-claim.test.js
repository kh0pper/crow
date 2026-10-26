import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

let dir, dbPath, prev;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "botcron-claim-"));
  dbPath = join(dir, "crow.db");
  prev = process.env.CROW_DB_PATH;
  process.env.CROW_DB_PATH = dbPath;
  const d = new Database(dbPath);
  d.exec(`CREATE TABLE schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT, cron_expression TEXT, description TEXT,
    enabled INTEGER DEFAULT 1, last_run TEXT, next_run TEXT, updated_at TEXT)`);
  d.close();
});
afterEach(() => {
  if (prev === undefined) delete process.env.CROW_DB_PATH; else process.env.CROW_DB_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

async function load() {
  const [sched, jr] = await Promise.all([import("../scripts/pi-bots/bot_scheduler.mjs"), import("../scripts/pi-bots/job_runner.mjs")]);
  return { ...sched, ensure: jr.ensureBotJobsSchema };
}
function seed(cron = "*/5 * * * *", goal = "do it") {
  const d = new Database(dbPath);
  const past = new Date(Date.now() - 60000).toISOString();
  d.prepare("INSERT INTO schedules (task, cron_expression, description, enabled, next_run) VALUES (?,?,?,1,?)")
    .run("pipeline:botcron:bot-1", cron, JSON.stringify({ goal }), past);
  const row = d.prepare("SELECT id, task, cron_expression, description, next_run FROM schedules").get();
  d.close();
  return row;
}
const jobCount = () => { const d = new Database(dbPath); try { return d.prepare("SELECT COUNT(*) c FROM bot_jobs").get().c; } finally { d.close(); } };

test("two connections claiming the same stale row enqueue exactly one job", async () => {
  const { claimAndEnqueue, ensure } = await load();
  const row = seed();
  const a = new Database(dbPath), b = new Database(dbPath);
  ensure(a);
  const now = new Date().toISOString();
  const r1 = claimAndEnqueue(a, row, now);
  const r2 = claimAndEnqueue(b, row, now);
  a.close(); b.close();
  assert.equal(r1, true);
  assert.equal(r2, false);
  assert.equal(jobCount(), 1);
});

test("a row whose next_run changed after the select is not claimed", async () => {
  const { claimAndEnqueue, ensure } = await load();
  const row = seed();
  const d = new Database(dbPath);
  ensure(d);
  d.prepare("UPDATE schedules SET next_run=? WHERE id=?").run(new Date(Date.now() + 3600000).toISOString(), row.id);
  assert.equal(claimAndEnqueue(d, row, new Date().toISOString()), false);
  d.close();
  assert.equal(jobCount(), 0);
});

test("a bad cron expression runs once, then next_run is NULL and it never ticks again", async () => {
  const { claimAndEnqueue, tickBotSchedules, ensure } = await load();
  const row = seed("not a cron");
  const d = new Database(dbPath);
  ensure(d);
  assert.equal(claimAndEnqueue(d, row, new Date().toISOString()), true);
  assert.equal(d.prepare("SELECT next_run FROM schedules WHERE id=?").get(row.id).next_run, null);
  d.close();
  assert.equal(jobCount(), 1);
  assert.equal(tickBotSchedules().fired, 0);
  assert.equal(jobCount(), 1);
});

test("tickBotSchedules still fires a due schedule once", async () => {
  const { tickBotSchedules, ensure } = await load();
  seed();
  const e = new Database(dbPath); ensure(e); e.close(); // module self-heal flag is per-process, DB is per-test
  assert.equal(tickBotSchedules().fired, 1);
  assert.equal(tickBotSchedules().fired, 0);
  assert.equal(jobCount(), 1);
});

test("a schedule whose previous run is still queued is advanced but not enqueued again (coalesced)", async () => {
  const { tickBotSchedules, ensure } = await load();
  seed();
  const e = new Database(dbPath); ensure(e); e.close();
  assert.equal(tickBotSchedules().fired, 1);
  const due = () => { const d = new Database(dbPath); d.prepare("UPDATE schedules SET next_run=?").run(new Date(Date.now() - 60000).toISOString()); d.close(); };
  due();
  const lines = [];
  assert.equal(tickBotSchedules({ log: (m) => lines.push(m) }).fired, 0);
  assert.equal(jobCount(), 1);
  assert.ok(lines.some((l) => l.includes("previous run still queued")));
  const d = new Database(dbPath);
  assert.ok(d.prepare("SELECT next_run FROM schedules").get().next_run > new Date().toISOString(), "still advanced");
  d.prepare("UPDATE bot_jobs SET status='running'").run(); // the previous run started
  d.close();
  due();
  assert.equal(tickBotSchedules().fired, 1);
  assert.equal(jobCount(), 2);
});

// ---------------------------------------------------------------------------
// Missed runs (no catch-up for repeating bot-cron schedules)
// ---------------------------------------------------------------------------
// A fixed clock keeps these deterministic (no wall-clock grid or New Year's edge).
const MIN = 60000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-06-15T12:00:30.000Z");
const iso = (t) => new Date(t).toISOString();
const YEARLY_A = "0 0 1 1 *"; // Jan 1 / Jan 2: never inside a window near NOW
const YEARLY_B = "0 0 2 1 *";

function seedAt(nextRunIso, cron = "*/15 * * * *", botId = "bot-1", goal = "do it") {
  const d = new Database(dbPath);
  const id = Number(d.prepare("INSERT INTO schedules (task, cron_expression, description, enabled, next_run) VALUES (?,?,?,1,?)")
    .run("pipeline:botcron:" + botId, cron, JSON.stringify({ goal }), nextRunIso).lastInsertRowid);
  d.close();
  return id;
}
const nextRunOf = (id) => { const d = new Database(dbPath); try { return d.prepare("SELECT next_run FROM schedules WHERE id=?").get(id).next_run; } finally { d.close(); } };
const rowOf = (id) => { const d = new Database(dbPath); try { return d.prepare("SELECT id, task, cron_expression, description, next_run FROM schedules WHERE id=?").get(id); } finally { d.close(); } };
const ensured = async () => { const m = await load(); const e = new Database(dbPath); m.ensure(e); e.close(); return m; };
/** The last grid occurrence of `cron` at or before `t` (ms), via the scheduler's own computeNextRun. */
async function gridAtOrBefore(cron, t) {
  const { computeNextRun } = await load();
  let g = Date.parse(computeNextRun(cron, new Date(t - 24 * HOUR)));
  for (;;) {
    const n = Date.parse(computeNextRun(cron, new Date(g)));
    if (n > t) return g;
    g = n;
  }
}

test("an on-time run (one occurrence) enqueues one job and sends no notification", async () => {
  const { tickBotSchedules } = await ensured();
  const id = seedAt(iso(NOW - 2 * MIN), YEARLY_A);
  const calls = [];
  const r = tickBotSchedules({ notify: (w) => calls.push(w), now: NOW });
  assert.equal(r.fired, 1);
  assert.equal(r.missed, 0);
  assert.equal(jobCount(), 1);
  assert.equal(calls.length, 0);
  assert.ok(nextRunOf(id) > iso(NOW));
});

test("beyond grace: no job, next_run moves past now, one notification; a second sweep (or a restart) adds none", async () => {
  const { tickBotSchedules } = await ensured();
  const id = seedAt(iso(NOW - 3 * HOUR), YEARLY_A);
  const calls = [];
  const lines = [];
  const r = tickBotSchedules({ notify: (w) => calls.push(w), log: (m) => lines.push(m), now: NOW });
  assert.equal(r.fired, 0);
  assert.equal(r.missed, 1);
  assert.equal(jobCount(), 0);
  assert.ok(nextRunOf(id) > iso(NOW), "advanced to the next occurrence after now");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  assert.equal(calls[0][0].schedule_id, id);
  assert.equal(calls[0][0].bot_id, "bot-1");
  assert.equal(calls[0][0].count, 1);
  assert.ok(lines.some((l) => /schedule #\d+ \(bot=bot-1\) missed 1 run\(s\) .* → .*; not run \(no catch-up\)/.test(l)));

  const again = tickBotSchedules({ notify: (w) => calls.push(w), now: NOW + MIN });
  assert.equal(again.missed, 0);
  assert.equal(calls.length, 1, "notified once per missed window");
  assert.equal(jobCount(), 0);
});

test("every-minute cron, 10 h outage, first sweep after boot: the latest run fires and the skipped ones are one missed window", async () => {
  const { tickBotSchedules } = await ensured();
  const due = await gridAtOrBefore("* * * * *", NOW - 10 * HOUR);
  seedAt(iso(due), "* * * * *");
  const calls = [];
  const r = tickBotSchedules({ notify: (w) => calls.push(w), now: NOW, aliveAt: null });
  assert.equal(r.fired, 1);
  assert.equal(jobCount(), 1);
  assert.equal(calls.length, 1);
  const w = calls[0][0];
  assert.equal(w.first, iso(due));
  assert.equal(w.count, 500, "about 600 skipped, counted up to the cap");
  assert.equal(w.capped, true);
  assert.equal(w.last, iso(Math.floor(NOW / MIN) * MIN - MIN), "the occurrence before the one that ran");
});

test("alive heartbeat across a 10 h suspend: the latest run fires late and the skipped ones are one missed window", async () => {
  const { tickBotSchedules } = await ensured();
  const due = await gridAtOrBefore("15,45 * * * *", NOW - 10 * HOUR); // last one 15 min before NOW
  seedAt(iso(due), "15,45 * * * *");
  const calls = [];
  const lines = [];
  const r = tickBotSchedules({ notify: (w) => calls.push(w), log: (m) => lines.push(m), now: NOW, aliveAt: due - 30000 });
  assert.equal(r.fired, 1);
  assert.equal(jobCount(), 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].count, 20, "21 occurrences, the latest ran");
  assert.equal(calls[0][0].capped, false);
  assert.ok(lines.some((l) => /running late/.test(l)));
});

test("two schedules missed in one sweep give one notifier call carrying both windows (one summary)", async () => {
  const { tickBotSchedules, missedNotifications } = await ensured();
  seedAt(iso(NOW - 3 * HOUR), YEARLY_A, "bot-1");
  seedAt(iso(NOW - 3 * HOUR), YEARLY_B, "bot-2");
  const calls = [];
  tickBotSchedules({ notify: (w) => calls.push(w), now: NOW });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 2);
  const notes = missedNotifications(calls[0]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, "2 bot routines missed runs while Crow wasn't running");
  assert.equal(notes[0].type, "system");
  assert.equal(notes[0].source, "scheduler:missed");
  const one = missedNotifications([calls[0][0]]);
  assert.equal(one.length, 1);
  assert.equal(one[0].title, "Missed: bot-1 routine");
  assert.equal(one[0].schedule_id, calls[0][0].schedule_id);
  assert.match(one[0].action_url, /^\/dashboard\/bot-builder\?bot=bot-1/);
});

test("a 15-minute schedule down for a day counts 96 missed runs, first..last on the grid", async () => {
  const { settleBotcron } = await load();
  const cron = "*/15 * * * *";
  const due = await gridAtOrBefore(cron, NOW - 2 * 24 * HOUR);
  const now = due + 24 * HOUR - MIN; // back 1 min before the day's last tick
  const s = settleBotcron(cron, iso(due), iso(now), 5 * MIN);
  assert.equal(s.fire, false);
  assert.equal(s.missed.count, 96);
  assert.equal(s.missed.capped, false);
  assert.equal(s.missed.first, iso(due));
  assert.equal(s.missed.last, iso(due + 95 * 15 * MIN));
  assert.ok(Date.parse(s.nextRun) > now);
});

test("the missed count stops at 500 (capped) but the last occurrence is still the real one", async () => {
  const { settleBotcron } = await load();
  const cron = "*/10 * * * *";
  const due = await gridAtOrBefore(cron, NOW - 5 * 24 * HOUR);
  const now = due + 4 * 24 * HOUR + 7 * MIN; // 577 occurrences, last one 7 min ago
  const s = settleBotcron(cron, iso(due), iso(now), 5 * MIN);
  assert.equal(s.fire, false);
  assert.equal(s.missed.count, 500);
  assert.equal(s.missed.capped, true);
  assert.equal(s.missed.last, iso(due + 4 * 24 * HOUR));
});

test("a next_run that does not parse is treated as due now (no throw)", async () => {
  const { settleBotcron } = await load();
  const s = settleBotcron("*/15 * * * *", "not a date", iso(NOW), 5 * MIN);
  assert.equal(s.fire, true);
  assert.equal(s.missed, null);
  assert.ok(Date.parse(s.nextRun) > NOW);
});

test("CROW_SCHEDULE_GRACE_MIN is clamped to 1..60 minutes, default 5", async () => {
  const { botcronGraceMs } = await load();
  assert.equal(botcronGraceMs({}), 5 * MIN);
  assert.equal(botcronGraceMs({ CROW_SCHEDULE_GRACE_MIN: "10" }), 10 * MIN);
  assert.equal(botcronGraceMs({ CROW_SCHEDULE_GRACE_MIN: "0" }), 1 * MIN);
  assert.equal(botcronGraceMs({ CROW_SCHEDULE_GRACE_MIN: "999" }), 60 * MIN);
  assert.equal(botcronGraceMs({ CROW_SCHEDULE_GRACE_MIN: "abc" }), 5 * MIN);
});

test("a bad cron beyond grace is a missed run: no job, next_run NULL, one notification", async () => {
  const { tickBotSchedules } = await ensured();
  const id = seedAt(iso(NOW - 3 * HOUR), "not a cron");
  const calls = [];
  const r = tickBotSchedules({ notify: (w) => calls.push(w), now: NOW });
  assert.equal(r.fired, 0);
  assert.equal(r.missed, 1);
  assert.equal(nextRunOf(id), null);
  assert.equal(jobCount(), 0);
  assert.equal(calls.length, 1);
});

test("two connections racing on one stale missed row: exactly one onMissed", async () => {
  const { claimAndEnqueue } = await ensured();
  const id = seedAt(iso(NOW - 3 * HOUR), YEARLY_A);
  const row = rowOf(id);
  const a = new Database(dbPath), b = new Database(dbPath);
  let missed = 0;
  const opts = { graceMs: 5 * MIN, onMissed: () => missed++ };
  claimAndEnqueue(a, row, iso(NOW), () => {}, opts);
  claimAndEnqueue(b, row, iso(NOW), () => {}, opts);
  a.close(); b.close();
  assert.equal(missed, 1);
  assert.equal(jobCount(), 0);
});

test("a notifier that throws (or rejects) never undoes the claim or crashes the sweep", async () => {
  const { tickBotSchedules } = await ensured();
  const a = seedAt(iso(NOW - 3 * HOUR), YEARLY_A, "bot-1");
  const lines = [];
  const r = tickBotSchedules({ notify: () => { throw new Error("boom"); }, log: (m) => lines.push(m), now: NOW });
  assert.equal(r.missed, 1);
  assert.ok(nextRunOf(a) > iso(NOW));
  assert.ok(lines.some((l) => l.includes("boom")));
  await r.notified;
  const b = seedAt(iso(NOW - 3 * HOUR), YEARLY_B, "bot-2");
  const r2 = tickBotSchedules({ notify: () => Promise.reject(new Error("async boom")), log: (m) => lines.push(m), now: NOW });
  assert.equal(r2.missed, 1);
  assert.ok(nextRunOf(b) > iso(NOW));
  await r2.notified; // resolves (never rejects) once the failure is logged
  assert.ok(lines.some((l) => l.includes("async boom")));
});

test("tickBotSchedules exposes the notify promise as r.notified (non-enumerable) so a CLI can await it before exiting", async () => {
  const { tickBotSchedules } = await ensured();
  seedAt(iso(NOW - 3 * HOUR), YEARLY_A);
  let done = false;
  const r = tickBotSchedules({ notify: () => new Promise((res) => setTimeout(() => { done = true; res(); }, 30)), now: NOW });
  assert.equal(done, false);
  assert.ok(r.notified && typeof r.notified.then === "function");
  assert.deepEqual(Object.keys(r).sort(), ["fired", "missed"], "JSON output stays {fired, missed}");
  await r.notified;
  assert.equal(done, true);
  const empty = tickBotSchedules({ notify: () => { throw new Error("never"); }, now: NOW });
  assert.equal(empty.missed, 0);
  await empty.notified; // a resolved promise when nothing was missed
});

test("the default notifier writes one system notification from scheduler:missed into the instance DB", async () => {
  const { tickBotSchedules } = await ensured();
  const d = new Database(dbPath);
  d.exec(`CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, source TEXT, title TEXT, body TEXT,
    priority TEXT, action_url TEXT, metadata TEXT, schedule_id INTEGER, expires_at TEXT, is_read INTEGER DEFAULT 0,
    is_dismissed INTEGER DEFAULT 0, snoozed_until TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  d.close();
  const id = seedAt(iso(NOW - 3 * HOUR), YEARLY_A);
  const r = tickBotSchedules({ now: NOW });
  assert.equal(r.missed, 1);
  await r.notified;
  const c = new Database(dbPath);
  const rows = c.prepare("SELECT type, source, title, schedule_id, action_url FROM notifications").all();
  c.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "system");
  assert.equal(rows[0].source, "scheduler:missed");
  assert.equal(rows[0].title, "Missed: bot-1 routine");
  assert.equal(rows[0].schedule_id, id);
});

// Heartbeat: a process that was ticking around `due` fires late, never "missed".
test("aliveAt just before due: a run 20 min late is a late fire (1 job, 0 notifications)", async () => {
  const { tickBotSchedules } = await ensured();
  const due = NOW - 20 * MIN;
  seedAt(iso(due), YEARLY_A);
  const calls = [];
  const lines = [];
  const r = tickBotSchedules({ notify: (w) => calls.push(w), log: (m) => lines.push(m), now: NOW, aliveAt: due - 30000 });
  assert.equal(r.fired, 1);
  assert.equal(r.missed, 0);
  assert.equal(jobCount(), 1);
  assert.equal(calls.length, 0);
  assert.ok(lines.some((l) => /late/.test(l)));
});

test("first sweep after boot (aliveAt null): the same 20-min-late run is missed, one notification", async () => {
  const { tickBotSchedules } = await ensured();
  seedAt(iso(NOW - 20 * MIN), YEARLY_A);
  const calls = [];
  const r = tickBotSchedules({ notify: (w) => calls.push(w), now: NOW, aliveAt: null });
  assert.equal(r.fired, 0);
  assert.equal(r.missed, 1);
  assert.equal(jobCount(), 0);
  assert.equal(calls.length, 1);
});

test("heartbeat slack: aliveAt must be within max(2 min, the poll interval) before due", async () => {
  const { settleBotcron } = await load();
  const due = NOW - 20 * MIN;
  assert.equal(settleBotcron(YEARLY_A, iso(due), iso(NOW), 5 * MIN, { aliveAt: due - 3 * MIN }).fire, false);
  const s = settleBotcron(YEARLY_A, iso(due), iso(NOW), 5 * MIN, { aliveAt: due - 2 * MIN });
  assert.equal(s.fire, true);
  assert.equal(s.late, true);
  // a 10-min poll: a sweep 9 min before due still counts as alive
  assert.equal(settleBotcron(YEARLY_A, iso(due), iso(NOW), 5 * MIN, { aliveAt: due - 9 * MIN, aliveSlackMs: 10 * MIN }).fire, true);
  assert.equal(settleBotcron(YEARLY_A, iso(due), iso(NOW), 5 * MIN, { aliveAt: due - 11 * MIN, aliveSlackMs: 10 * MIN }).fire, false);
});
