// 0009-schedule-runs — schedules.tz + the schedule_runs history table on a co-hosted instance that
// converges without re-running init-db (the 0005–0008 story), and the upgrade pauses: rows that
// fired into nothing before this change and would start notifying every few minutes after it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { run, id } from "../scripts/migrations/0009-schedule-runs.mjs";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A crow.db with the pre-change schedules shape (no tz, no schedule_runs). */
function oldShapeDb({ withSchedules = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sched-mig-"));
  dirs.push(dir);
  const dbPath = join(dir, "crow.db");
  const db = new Database(dbPath);
  if (withSchedules) {
    db.exec(`CREATE TABLE schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, cron_expression TEXT NOT NULL,
      description TEXT, enabled INTEGER NOT NULL DEFAULT 1, last_run TEXT, next_run TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
  }
  db.close();
  return { dir, dbPath };
}

function seed(dbPath, rows) {
  const db = new Database(dbPath);
  const ins = db.prepare("INSERT INTO schedules (task, cron_expression, enabled) VALUES (?, ?, ?)");
  const ids = rows.map(([task, cron, enabled = 1]) => Number(ins.run(task, cron, enabled).lastInsertRowid));
  db.close();
  return ids;
}

function initDbShape() {
  const dir = mkdtempSync(join(tmpdir(), "sched-init-"));
  dirs.push(dir);
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe" });
  return shape(join(dir, "crow.db"));
}

function shape(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  const cols = (t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => [c.name, c.type, c.notnull, c.dflt_value]);
  const idx = d.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='schedule_runs' AND sql IS NOT NULL ORDER BY name").all();
  const out = { schedulesTz: cols("schedules").find((c) => c[0] === "tz") || null, runs: cols("schedule_runs"), idx: idx.map((i) => i.name) };
  d.close();
  return out;
}

test("the module id matches its filename", () => {
  assert.equal(id, "0009-schedule-runs");
});

test("adds schedules.tz and schedule_runs with the same shape init-db creates", () => {
  const { dbPath } = oldShapeDb();
  const r = run({ dbPath, log: () => {} });
  assert.equal(r.applied, true);
  const want = initDbShape();
  const got = shape(dbPath);
  assert.ok(want.schedulesTz, "init-db's CREATE body / addColumnIfMissing carries tz");
  assert.deepEqual(got.schedulesTz, want.schedulesTz);
  assert.deepEqual(got.runs, want.runs, "schedule_runs columns match init-db's");
  assert.deepEqual(got.idx, want.idx, "schedule_runs indexes match init-db's");
  assert.ok(got.idx.includes("ux_schedule_runs_occ"));
});

test("pauses only the rows that would start spamming, records each once, leaves the rest", () => {
  const { dbPath } = oldShapeDb();
  const [frequentBare, pipelineOther, frequentPrefixed, botcron, briefing, hourlyBare, dailyBare, disabledFrequent, once] = seed(dbPath, [
    ["check the logs", "*/5 * * * *"],
    ["pipeline:old-runner", "0 9 * * *"],
    ["reminder:drink water", "*/15 * * * *"],
    ["pipeline:botcron:lab", "*/10 * * * *"],
    ["media:briefing", "0 8 * * *"],
    ["look outside", "0 * * * *"],
    ["call mum", "0 9 * * *"],
    ["already off", "* * * * *", 0],
    ["reminder:once", "@once"],
  ]);
  const first = run({ dbPath, log: () => {} });
  const second = run({ dbPath, log: () => {} });
  assert.equal(first.applied, true);
  assert.equal(second.applied, true);
  const db = new Database(dbPath, { readonly: true });
  const enabled = (i) => db.prepare("SELECT enabled FROM schedules WHERE id = ?").get(i).enabled;
  assert.equal(enabled(frequentBare), 0);
  assert.equal(enabled(pipelineOther), 0);
  for (const i of [frequentPrefixed, botcron, briefing, hourlyBare, dailyBare, once]) assert.equal(enabled(i), 1, `row ${i} left alone`);
  assert.equal(enabled(disabledFrequent), 0);
  const runs = db.prepare("SELECT schedule_id, status, source, scheduled_for, detail, notified_at FROM schedule_runs ORDER BY schedule_id").all();
  db.close();
  assert.deepEqual(runs.map((r) => [r.schedule_id, r.status, r.source, r.scheduled_for, r.notified_at]),
    [[frequentBare, "paused", "upgrade", null, null], [pipelineOther, "paused", "upgrade", null, null]], "one record each, even after a second run");
  assert.deepEqual(JSON.parse(runs[0].detail), { reason: "frequent", every_min: 5 });
  assert.deepEqual(JSON.parse(runs[1].detail), { reason: "system" });
});

test("never deletes a schedule row", () => {
  const { dbPath } = oldShapeDb();
  seed(dbPath, [["a", "*/5 * * * *"], ["pipeline:x", "0 9 * * *"], ["reminder:b", "0 9 * * *"]]);
  run({ dbPath, log: () => {} });
  const db = new Database(dbPath, { readonly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schedules").get().n, 3);
  db.close();
});

test("a store without a schedules table is recorded applied and left alone (init-db creates the shape)", () => {
  const { dbPath } = oldShapeDb({ withSchedules: false });
  const r = run({ dbPath, log: () => {} });
  assert.equal(r.applied, true);
  const db = new Database(dbPath, { readonly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('schedules','schedule_runs')").get().n, 0);
  db.close();
});
