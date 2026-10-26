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
// Missed runs: the shared schedule-core rule (no catch-up for repeating runs).
// The claimer records each missed window in schedule_runs; the gateway
// scheduler's sweep sends the one notice.
// ---------------------------------------------------------------------------
// A fixed clock keeps these deterministic (no wall-clock grid or New Year's edge).
const MIN = 60000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-06-15T12:00:30.000Z");
const iso = (t) => new Date(t).toISOString();
const YEARLY_A = "0 0 1 1 *"; // Jan 1 / Jan 2: never inside a window near NOW
const YEARLY_B = "0 0 2 1 *";
const RUNS_DDL = `CREATE TABLE IF NOT EXISTS schedule_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id INTEGER NOT NULL, scheduled_for TEXT, ran_at TEXT,
  status TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'clock', missed_count INTEGER NOT NULL DEFAULT 0,
  job_id TEXT, detail TEXT, notified_at TEXT, acknowledged_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE UNIQUE INDEX IF NOT EXISTS ux_schedule_runs_occ ON schedule_runs(schedule_id, scheduled_for) WHERE scheduled_for IS NOT NULL;`;

function seedAt(nextRunIso, cron = "*/15 * * * *", botId = "bot-1", goal = "do it") {
  const d = new Database(dbPath);
  const id = Number(d.prepare("INSERT INTO schedules (task, cron_expression, description, enabled, next_run) VALUES (?,?,?,1,?)")
    .run("pipeline:botcron:" + botId, cron, JSON.stringify({ goal }), nextRunIso).lastInsertRowid);
  d.close();
  return id;
}
const nextRunOf = (id) => { const d = new Database(dbPath); try { return d.prepare("SELECT next_run FROM schedules WHERE id=?").get(id).next_run; } finally { d.close(); } };
const rowOf = (id) => { const d = new Database(dbPath); try { return d.prepare("SELECT id, task, cron_expression, description, next_run FROM schedules WHERE id=?").get(id); } finally { d.close(); } };
const runs = () => {
  const d = new Database(dbPath);
  try {
    return d.prepare("SELECT schedule_id, scheduled_for, status, source, missed_count, detail, notified_at FROM schedule_runs ORDER BY id").all()
      .map((r) => ({ ...r, detail: JSON.parse(r.detail || "{}") }));
  } finally { d.close(); }
};
/** bot_jobs ensured + schedule_runs created (a migrated instance). */
const ready = async ({ withRuns = true } = {}) => {
  const m = await load();
  const e = new Database(dbPath); m.ensure(e); if (withRuns) e.exec(RUNS_DDL); e.close();
  return m;
};
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

test("an on-time run (one occurrence) enqueues one job and records no missed window", async () => {
  const { tickBotSchedules } = await ready();
  const id = seedAt(iso(NOW - 2 * MIN), YEARLY_A);
  const r = tickBotSchedules({ now: NOW });
  assert.equal(r.fired, 1);
  assert.equal(r.missed, 0);
  assert.equal(jobCount(), 1);
  assert.equal(runs().length, 0);
  assert.ok(nextRunOf(id) > iso(NOW));
});

test("beyond grace: no job, next_run moves past now, one missed row (notice left to the gateway sweep); a second sweep adds none", async () => {
  const { tickBotSchedules } = await ready();
  const due = NOW - 3 * HOUR;
  const id = seedAt(iso(due), YEARLY_A);
  const lines = [];
  const r = tickBotSchedules({ log: (m) => lines.push(m), now: NOW });
  assert.equal(r.fired, 0);
  assert.equal(r.missed, 1);
  assert.equal(jobCount(), 0);
  assert.ok(nextRunOf(id) > iso(NOW), "advanced to the next occurrence after now");
  const rs = runs();
  assert.equal(rs.length, 1);
  assert.equal(rs[0].schedule_id, id);
  assert.equal(rs[0].status, "missed");
  assert.equal(rs[0].source, "clock");
  assert.equal(rs[0].scheduled_for, iso(due));
  assert.equal(rs[0].missed_count, 1);
  assert.equal(rs[0].notified_at, null, "the gateway scheduler's sweep marks and notifies");
  assert.ok(lines.some((l) => /schedule #\d+ \(bot=bot-1\) missed 1 run\(s\) .* → .*; not run \(no catch-up\)/.test(l)));

  const again = tickBotSchedules({ now: NOW + MIN });
  assert.equal(again.missed, 0);
  assert.equal(runs().length, 1, "recorded once per missed window");
  assert.equal(jobCount(), 0);
});

test("every-minute cron, 10 h outage, first sweep after boot: the latest run fires and the skipped ones are one recorded window (capped)", async () => {
  const { tickBotSchedules } = await ready();
  const due = await gridAtOrBefore("* * * * *", NOW - 10 * HOUR);
  seedAt(iso(due), "* * * * *");
  const r = tickBotSchedules({ now: NOW, aliveAt: null });
  assert.equal(r.fired, 1);
  assert.equal(r.missed, 1);
  assert.equal(jobCount(), 1);
  const [w] = runs();
  assert.equal(w.scheduled_for, iso(due));
  assert.equal(w.missed_count, 500, "about 600 skipped, counted up to the cap");
  assert.equal(w.detail.capped, true);
  assert.equal(w.detail.last_missed, iso(Math.floor(NOW / MIN) * MIN - MIN), "the occurrence before the one that ran");
});

test("alive heartbeat across a 10 h suspend: the latest run fires late and the skipped ones are one recorded window", async () => {
  const { tickBotSchedules } = await ready();
  const due = await gridAtOrBefore("15,45 * * * *", NOW - 10 * HOUR); // last one 15 min before NOW
  seedAt(iso(due), "15,45 * * * *");
  const lines = [];
  const r = tickBotSchedules({ log: (m) => lines.push(m), now: NOW, aliveAt: due - 30000 });
  assert.equal(r.fired, 1);
  assert.equal(jobCount(), 1);
  const rs = runs();
  assert.equal(rs.length, 1);
  assert.equal(rs[0].missed_count, 20, "21 occurrences, the latest ran");
  assert.equal(rs[0].detail.capped, undefined);
  assert.ok(lines.some((l) => /running late/.test(l)));
});

test("heartbeat: aliveAt just before due fires a 20-min-late run (1 job, no row); aliveAt null records it missed", async () => {
  const { tickBotSchedules } = await ready();
  const due = NOW - 20 * MIN;
  const a = seedAt(iso(due), YEARLY_A, "bot-1");
  assert.equal(tickBotSchedules({ now: NOW, aliveAt: due - 30000 }).fired, 1);
  assert.equal(runs().length, 0);
  const b = seedAt(iso(due), YEARLY_B, "bot-2");
  const r = tickBotSchedules({ now: NOW, aliveAt: null });
  assert.equal(r.fired, 0);
  assert.equal(r.missed, 1);
  assert.deepEqual(runs().map((x) => x.schedule_id), [b]);
  assert.ok(a !== b);
});

test("heartbeat: a sweep that started AFTER due proves nothing (a re-enabled row with an old next_run stays missed)", async () => {
  const { tickBotSchedules } = await ready();
  const due = NOW - 20 * MIN;
  seedAt(iso(due), YEARLY_A);
  const r = tickBotSchedules({ now: NOW, aliveAt: due + MIN });
  assert.equal(r.fired, 0);
  assert.equal(r.missed, 1);
  assert.equal(jobCount(), 0);
});

test("heartbeat slack: with a 10-min poll, a sweep 9 min before due counts as alive; 11 min does not", async () => {
  const { tickBotSchedules } = await ready();
  const due = NOW - 20 * MIN;
  seedAt(iso(due), YEARLY_A, "bot-1");
  assert.equal(tickBotSchedules({ now: NOW, aliveAt: due - 9 * MIN, aliveSlackMs: 10 * MIN }).fired, 1);
  seedAt(iso(due), YEARLY_B, "bot-2");
  const r = tickBotSchedules({ now: NOW, aliveAt: due - 11 * MIN, aliveSlackMs: 10 * MIN });
  assert.equal(r.fired, 0);
  assert.equal(r.missed, 1);
});

test("two schedules missed in one sweep record two windows", async () => {
  const { tickBotSchedules } = await ready();
  seedAt(iso(NOW - 3 * HOUR), YEARLY_A, "bot-1");
  seedAt(iso(NOW - 3 * HOUR), YEARLY_B, "bot-2");
  const r = tickBotSchedules({ now: NOW });
  assert.equal(r.missed, 2);
  assert.equal(runs().length, 2);
});

test("a 15-minute schedule down for a day records 96 missed runs, first..last on the grid", async () => {
  const { tickBotSchedules } = await ready();
  const cron = "*/15 * * * *";
  const due = await gridAtOrBefore(cron, NOW - 2 * 24 * HOUR);
  const now = due + 24 * HOUR - MIN; // back 1 min before the day's last tick
  seedAt(iso(due), cron);
  assert.equal(tickBotSchedules({ now }).fired, 0);
  const [w] = runs();
  assert.equal(w.missed_count, 96);
  assert.equal(w.scheduled_for, iso(due));
  assert.equal(w.detail.last_missed, iso(due + 95 * 15 * MIN));
});

test("the missed count stops at 500 (capped) but the last occurrence is still the real one", async () => {
  const { tickBotSchedules } = await ready();
  const cron = "*/10 * * * *";
  const due = await gridAtOrBefore(cron, NOW - 5 * 24 * HOUR);
  const now = due + 4 * 24 * HOUR + 7 * MIN; // 577 occurrences, last one 7 min ago
  seedAt(iso(due), cron);
  assert.equal(tickBotSchedules({ now }).fired, 0);
  const [w] = runs();
  assert.equal(w.missed_count, 500);
  assert.equal(w.detail.capped, true);
  assert.equal(w.detail.last_missed, iso(due + 4 * 24 * HOUR));
});

test("a bad cron beyond grace is recorded missed and next_run becomes NULL", async () => {
  const { tickBotSchedules } = await ready();
  const id = seedAt(iso(NOW - 3 * HOUR), "not a cron");
  const r = tickBotSchedules({ now: NOW });
  assert.equal(r.fired, 0);
  assert.equal(r.missed, 1);
  assert.equal(nextRunOf(id), null);
  assert.equal(jobCount(), 0);
  assert.equal(runs().length, 1);
});

test("two connections racing on one stale missed row: only the claimer records it (one row, one onMissed)", async () => {
  const { claimAndEnqueue } = await ready();
  const id = seedAt(iso(NOW - 3 * HOUR), YEARLY_A);
  const row = rowOf(id);
  const a = new Database(dbPath), b = new Database(dbPath);
  let missed = 0;
  const opts = { graceMs: 5 * MIN, onMissed: () => missed++ };
  claimAndEnqueue(a, row, iso(NOW), () => {}, opts);
  claimAndEnqueue(b, row, iso(NOW), () => {}, opts);
  a.close(); b.close();
  assert.equal(missed, 1);
  assert.equal(runs().length, 1);
  assert.equal(jobCount(), 0);
});

test("a DB without schedule_runs still advances the row and logs that the window was not recorded", async () => {
  const { tickBotSchedules } = await ready({ withRuns: false });
  const id = seedAt(iso(NOW - 3 * HOUR), YEARLY_A);
  const lines = [];
  const r = tickBotSchedules({ log: (m) => lines.push(m), now: NOW });
  assert.equal(r.missed, 1);
  assert.ok(nextRunOf(id) > iso(NOW));
  assert.ok(lines.some((l) => /missed window not recorded/.test(l)));
});

// ---------------------------------------------------------------------------
// The one-shot CLI: it sweeps the notices itself only when no gateway ticker
// holds the lease.
// ---------------------------------------------------------------------------
test("CLI tick with a live gateway lease leaves the notices to that gateway (no sweep)", async () => {
  const { runCliTick } = await ready();
  let sweeps = 0;
  const r = await runCliTick({ tick: () => ({ fired: 0, missed: 1 }), leaseHeld: async () => true, sweep: async () => { sweeps++; return { claimed: [] }; } });
  assert.equal(sweeps, 0);
  assert.equal(r.swept, false);
});

test("CLI tick with no live lease sweeps the notices once, on an async client over the instance DB", async () => {
  const { runCliTick } = await ready();
  seedAt(iso(Date.now() - 3 * HOUR), YEARLY_A);
  const seen = [];
  const r = await runCliTick({
    leaseHeld: async () => false,
    sweep: async (client) => {
      const { rows } = await client.execute({ sql: "SELECT status FROM schedule_runs", args: [] });
      seen.push(rows.map((x) => x.status));
      return { claimed: [1] };
    },
  });
  assert.equal(r.swept, true);
  assert.equal(seen.length, 1, "swept exactly once");
  assert.deepEqual(seen[0], ["missed"], "the sweep sees the window this tick recorded");
});

test("CLI default sweep is the gateway scheduler's sweepMissedNotices: it marks the row and notifies once", async () => {
  const { runCliTick } = await ready();
  const d = new Database(dbPath);
  d.exec(`CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, source TEXT, title TEXT, body TEXT,
    priority TEXT, action_url TEXT, metadata TEXT, schedule_id INTEGER, expires_at TEXT, is_read INTEGER DEFAULT 0,
    is_dismissed INTEGER DEFAULT 0, snoozed_until TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS dashboard_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)`);
  d.close();
  seedAt(iso(Date.now() - 3 * HOUR), YEARLY_A);
  await runCliTick({ leaseHeld: async () => false });
  const c = new Database(dbPath);
  const notes = c.prepare("SELECT source, title FROM notifications").all();
  const marked = c.prepare("SELECT COUNT(*) n FROM schedule_runs WHERE notified_at IS NOT NULL").get().n;
  c.close();
  assert.equal(marked, 1);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].source, "scheduler:missed");
  assert.equal(notes[0].title, "Missed: bot-1 routine");
});
