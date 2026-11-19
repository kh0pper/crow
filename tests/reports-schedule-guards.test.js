// The guards around a report's schedule row: the memory server's schedule tools, the Schedule page's
// actions, the scheduler's Run now, and what the Schedule panel shows for a row it may not touch.
//
// Harness: a real init-db'd scratch crow.db in a tmpdir (never ~/.crow), the real memory server over
// the MCP in-memory transport (as tests/memory-schedule-tools.test.js drives it), the real dashboard
// panel handler with a local password session (as tests/schedule-panel.test.js drives it), and real
// report rows, so the panel can read a report's title.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { fromLaptop } from "./helpers/off-box.js";

const dir = mkdtempSync(join(tmpdir(), "reports-schedule-guards-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname;

const raw = () => new Database(DB_FILE);
const q = (sql, ...args) => { const c = raw(); try { return c.prepare(sql).all(...args); } finally { c.close(); } };
const x = (sql, ...args) => { const c = raw(); try { return c.prepare(sql).run(...args); } finally { c.close(); } };

const { createDbClient } = await import("../servers/db.js");
const { createReport, updateReportColumns } = await import("../servers/gateway/reports/store.js");
const { scheduleKind } = await import("../servers/shared/schedule-core.js");
const { runNow, _resetForTest, _setNowForTest, _tickForTest } = await import("../servers/gateway/scheduler.js");
const {
  deleteScheduleRow, pauseSchedule, resumeSchedule, runScheduleNow,
} = await import("../servers/gateway/schedule-actions.js");
const { buildScheduleModel } = await import("../servers/gateway/schedule-catalog.js");
const { renderSchedulePage } = await import("../servers/gateway/dashboard/panels/schedule/html.js");
const { registerSchedulerHook, unregisterSchedulerHook } = await import("../servers/gateway/scheduler-hooks.js");
const { registerReportsHook, _setReportsHookForTest } = await import("../servers/gateway/reports/schedule-hook.js");
const { translations } = await import("../servers/gateway/dashboard/shared/i18n.js");

const NOW = Date.parse("2026-10-26T15:00:00.000Z");
const HOUR = 3_600_000;
const SESSION = "sess-local";
const OWNED_TEXT = "Reports are scheduled from the report page.";

let db;
let client;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  x("INSERT INTO dashboard_settings (key, value) VALUES ('instance_timezone', 'UTC')");
  const hash = (t) => createHash("sha256").update(t).digest("hex");
  const until = new Date(Date.now() + 3_600_000).toISOString();
  x("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard', ?)", hash(SESSION), until);

  db = createDbClient(DB_FILE);
  const { createMemoryServer } = await import("../servers/memory/server.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const server = createMemoryServer(DB_FILE);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
});

after(async () => {
  try { await client?.close(); } catch {}
  try { db?.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
};

let made = 0;

/** A report row plus its own `report:<id>` schedule row: what the report page would have created. */
async function seedReportSchedule({ title = "Weekly listings", enabled = 1 } = {}) {
  const { id } = await createReport(db, { projectId: 7, owner: "owner", botId: "bot-1", title });
  x("INSERT INTO schedules (task, cron_expression, tz, next_run, enabled) VALUES (?, '0 7 * * 1', 'UTC', ?, ?)",
    `report:${id}`, new Date(NOW + HOUR).toISOString(), enabled);
  const idRow = q("SELECT id FROM schedules ORDER BY id DESC LIMIT 1")[0];
  made += 1;
  await updateReportColumns(db, id, { schedule_id: Number(idRow.id) });
  return { reportId: id, scheduleId: Number(idRow.id), title };
}

/* --------------------------------------------------------------- schedule-core */

test("a report: task is its own kind only in its exact shape", () => {
  assert.equal(scheduleKind("report:rpt-0011223344556677"), "report");
  assert.equal(scheduleKind("  report:rpt-0011223344556677  "), "report");
  // Everything else beginning `report:` is the owner's own reminder text, and a report id that is not
  // the store's shape names no report at all, so it must never be handed to the reports hook.
  assert.equal(scheduleKind("report:rpt-x"), "reminder");
  assert.equal(scheduleKind("report: Q3 numbers"), "reminder");
  assert.equal(scheduleKind("Report: Q3 numbers"), "reminder", "the prefix is case sensitive");
  assert.equal(scheduleKind("report:rpt-001122334455667"), "reminder", "a 15 digit id is not an id");
  assert.equal(scheduleKind("reminder:report the leak"), "reminder");
  assert.equal(scheduleKind("reports weekly"), "reminder");
  assert.equal(scheduleKind("pipeline:botcron:alpha"), "bot_routine");
  assert.equal(scheduleKind("media:briefing"), "briefing");
});

test("settlePass fires report:rpt-foo as a reminder, and a real report id is left to the hook", async () => {
  const real = await seedReportSchedule({ title: "Real report" });
  const due = new Date(NOW - 60_000).toISOString();
  x("INSERT INTO schedules (task, cron_expression, tz, next_run) VALUES ('report:rpt-foo', '0 7 * * 1', 'UTC', ?)", due);
  const fooId = q("SELECT id FROM schedules ORDER BY id DESC LIMIT 1")[0].id;
  x("UPDATE schedules SET next_run = ? WHERE id = ?", due, real.scheduleId);

  // The gateway scheduler's own settle pass: `report:rpt-foo` is not the store's id shape, so it is
  // the owner's reminder text and it fires. A row whose task IS that shape belongs to the reports
  // hook, and this pass never delivers it as a reminder.
  unregisterSchedulerHook("reports");
  _setReportsHookForTest(null);
  _setNowForTest(() => NOW);
  _resetForTest();
  try {
    await _tickForTest(db);
  } finally {
    _setNowForTest(null);
    _resetForTest();
    unregisterSchedulerHook("reports");
    _setReportsHookForTest(null);
  }

  assert.equal(q("SELECT COUNT(*) AS n FROM notifications WHERE source = 'scheduler' AND title LIKE '%rpt-foo%'")[0].n, 1,
    "report:rpt-foo fired as a reminder");
  assert.equal(q("SELECT COUNT(*) AS n FROM notifications WHERE source = 'scheduler' AND title LIKE '%Real report%'")[0].n, 0,
    "a real report row is never delivered as a reminder");
  assert.equal(q("SELECT next_run FROM schedules WHERE id = ?", real.scheduleId)[0].next_run, due,
    "the reports hook's row was left alone");

  // The reports hook takes only the exact id shape, so `report:rpt-foo` is not one of its rows and
  // never a stray it says anything about. Its window is made due again, so the hook's own due query
  // really faces the row.
  x("UPDATE schedules SET next_run = ? WHERE id = ?", due, fooId);
  const warnings = [];
  const original = console.warn;
  const hook = registerReportsHook(db, {
    approvals: { loadSeed: () => ({ seed: Buffer.alloc(32, 3) }), now: () => NOW, senderReady: async () => true, registry: {} },
    now: () => NOW,
    notify: async () => {},
    instanceZone: async () => "UTC",
    lease: { now: () => NOW, pid: 1, isPidAlive: () => true, kernelBootId: () => "boot", runId: "run-test" },
    deliver: async () => {},
    runBlocks: async () => ({ items: [] }),
  });
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  try {
    await hook.tick(db);
  } finally {
    console.warn = original;
    unregisterSchedulerHook("reports");
    _setReportsHookForTest(null);
  }
  assert.deepEqual(warnings.filter((line) => /names no report/.test(line)), [],
    "report:rpt-foo is not a report row, so it is not a stray");
  assert.equal(q("SELECT COUNT(*) AS n FROM report_runs")[0].n, 0, "and nothing ran");

  // Both rows are removed again: the tests below count the `report:` rows in the table.
  for (const id of [fooId, real.scheduleId]) {
    x("DELETE FROM schedule_runs WHERE schedule_id = ?", id);
    x("DELETE FROM schedules WHERE id = ?", id);
  }
});

/* ----------------------------------------------------------- the memory tools */

test("crow_create_schedule refuses a report: task", async () => {
  const before = q("SELECT COUNT(*) AS n FROM schedules")[0].n;
  for (const args of [
    { task: "report:rpt-0011223344556677", cron_expression: "0 7 * * 1" },
    { task: "report:rpt-0011223344556677", cron_expression: "0 7 * * 1", type: "reminder" },
  ]) {
    const r = await call("crow_create_schedule", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.equal(r.text, OWNED_TEXT);
  }
  assert.equal(q("SELECT COUNT(*) AS n FROM schedules")[0].n, before, "nothing was stored");
});

test("crow_create_schedule stores report: text as a reminder, and the settle pass fires it", async () => {
  for (const task of ["report: Q3 numbers", "Report: Q3 numbers"]) {
    const made = await call("crow_create_schedule", { task, cron_expression: "0 7 * * 1" });
    assert.equal(made.isError, false, made.text);
    assert.match(made.text, /Reminder/);
    const row = q("SELECT * FROM schedules ORDER BY id DESC LIMIT 1")[0];
    assert.equal(row.task, `reminder:${task}`, "stored as a reminder with its usual prefix");
    assert.equal(scheduleKind(row.task), "reminder");
  }
  assert.equal(q("SELECT COUNT(*) AS n FROM schedules WHERE task LIKE 'report:%'")[0].n, 0,
    "nothing was stored as a report row");

  // The gateway scheduler's own settle pass delivers it (the row is made due now).
  const due = new Date(NOW - 60_000).toISOString();
  x("UPDATE schedules SET next_run = ? WHERE task IN ('reminder:report: Q3 numbers', 'reminder:Report: Q3 numbers')", due);
  _setNowForTest(() => NOW);
  _resetForTest();
  try {
    await _tickForTest(db);
  } finally {
    _setNowForTest(null);
    _resetForTest();
  }
  const delivered = q("SELECT * FROM notifications WHERE source = 'scheduler' AND title LIKE '%Q3%'");
  assert.equal(delivered.length, 2, `both reminders fired (${JSON.stringify(delivered)})`);
});

test("crow_update_schedule refuses every change to a report: row, and the row is unchanged", async () => {
  const seeded = await seedReportSchedule();
  const before = q("SELECT * FROM schedules WHERE id = ?", seeded.scheduleId)[0];
  for (const args of [
    { enabled: false },
    { enabled: true },
    { run_now: true },
    { delete: true },
    { task: "reminder:something else" },
    { cron_expression: "0 9 * * *" },
    { tz: "Europe/Madrid" },
    { tz: null },
  ]) {
    const r = await call("crow_update_schedule", { id: seeded.scheduleId, ...args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.equal(r.text, OWNED_TEXT, JSON.stringify(args));
  }
  assert.deepEqual({ ...q("SELECT * FROM schedules WHERE id = ?", seeded.scheduleId)[0] }, { ...before },
    "the row is exactly as it was");
  assert.equal(q("SELECT COUNT(*) AS n FROM schedule_runs WHERE schedule_id = ?", seeded.scheduleId)[0].n, 0,
    "no run was requested");
});

test("crow_list_schedules words a report row as a Report and can filter by it", async () => {
  const seeded = await seedReportSchedule({ title: "Board pack" });
  const all = await call("crow_list_schedules", {});
  const block = all.text.split("\n\n").find((b) => b.startsWith(`[#${seeded.scheduleId}]`));
  assert.ok(block, all.text);
  assert.match(block, /\] Report \|/);
  assert.equal(block.includes(OWNED_TEXT), false);
  const reports = await call("crow_list_schedules", { type: "report" });
  assert.match(reports.text, new RegExp(`\\[#${seeded.scheduleId}\\] Report`));
  const reminders = await call("crow_list_schedules", { type: "reminder" });
  assert.equal(reminders.text.includes(`[#${seeded.scheduleId}]`), false);
});

/* --------------------------------------------------------- the Schedule page */

test("the Schedule page's actions refuse a report row and change nothing", async () => {
  const seeded = await seedReportSchedule();
  const before = { ...q("SELECT * FROM schedules WHERE id = ?", seeded.scheduleId)[0] };
  for (const [name, fn] of [
    ["pause", (d, id) => pauseSchedule(d, id)],
    ["resume", (d, id) => resumeSchedule(d, id, { now: NOW })],
    ["run now", (d, id) => runScheduleNow(d, id, { now: NOW })],
    ["delete", (d, id) => deleteScheduleRow(d, id)],
  ]) {
    const r = await fn(db, seeded.scheduleId);
    assert.deepEqual(r, { ok: false, code: "report-owned" }, name);
  }
  assert.deepEqual({ ...q("SELECT * FROM schedules WHERE id = ?", seeded.scheduleId)[0] }, before);
  assert.equal(q("SELECT COUNT(*) AS n FROM schedule_runs WHERE schedule_id = ?", seeded.scheduleId)[0].n, 0);
});

test("runNow on a report row refuses a report that is not live, and delivers no reminder", async () => {
  const seeded = await seedReportSchedule();
  unregisterSchedulerHook("reports");
  _setReportsHookForTest(null);
  const notes = [];
  registerReportsHook(db, {
    approvals: { loadSeed: () => ({ seed: Buffer.alloc(32, 3) }), now: () => NOW, senderReady: async () => true, registry: {} },
    now: () => NOW,
    notify: async (_db, note) => { notes.push(note); },
    instanceZone: async () => "UTC",
    lease: { now: () => NOW, pid: 1, isPidAlive: () => true, kernelBootId: () => "boot", runId: "run-test" },
    deliver: async () => {},
    runBlocks: async () => ({ items: [] }),
  });
  const schedule = q("SELECT * FROM schedules WHERE id = ?", seeded.scheduleId)[0];
  let result;
  try {
    result = await runNow(db, schedule);
  } finally {
    unregisterSchedulerHook("reports");
    _setReportsHookForTest(null);
  }
  // A draft report is not runnable: the caller is told so, and neither a report run nor a reminder is
  // recorded for it.
  assert.deepEqual(result, { ok: false, error: "not live" });
  assert.equal(q("SELECT COUNT(*) AS n FROM report_runs WHERE report_id = ?", seeded.reportId)[0].n, 0,
    "no report run was started");
  assert.deepEqual(notes, [], "no reminder was delivered");
  assert.equal(q("SELECT COUNT(*) AS n FROM schedule_runs WHERE schedule_id = ?", seeded.scheduleId)[0].n, 0);
});

test("runNow on a report row settles the run id it was handed", async () => {
  const seeded = await seedReportSchedule();
  unregisterSchedulerHook("reports");
  _setReportsHookForTest(null);
  const schedule = q("SELECT * FROM schedules WHERE id = ?", seeded.scheduleId)[0];
  const sent = [];
  registerSchedulerHook("reports", {
    tick: async () => {},
    runNow: async (_db, row) => { sent.push(Number(row.id)); return { ok: true }; },
  });
  try {
    x("INSERT INTO schedule_runs (schedule_id, scheduled_for, status, source) VALUES (?, NULL, 'requested', 'run-now')",
      seeded.scheduleId);
    const runId = q("SELECT id FROM schedule_runs ORDER BY id DESC LIMIT 1")[0].id;
    const result = await runNow(db, schedule, { runId });
    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.deepEqual(sent, [seeded.scheduleId], "the reports hook was asked");
    const settled = q("SELECT * FROM schedule_runs WHERE id = ?", runId)[0];
    assert.equal(settled.status, "ok", "the request row is settled, never left 'requested'");
    assert.equal(settled.detail, null);

    // A refusal settles 'failed' with the hook's own error, so the owner sees why.
    registerSchedulerHook("reports", { tick: async () => {}, runNow: async () => ({ ok: false, error: "not live" }) });
    x("INSERT INTO schedule_runs (schedule_id, scheduled_for, status, source) VALUES (?, NULL, 'requested', 'run-now')",
      seeded.scheduleId);
    const refusedId = q("SELECT id FROM schedule_runs ORDER BY id DESC LIMIT 1")[0].id;
    const refused = await runNow(db, schedule, { runId: refusedId });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "not live");
    const settledRefusal = q("SELECT * FROM schedule_runs WHERE id = ?", refusedId)[0];
    assert.equal(settledRefusal.status, "failed");
    assert.deepEqual(JSON.parse(settledRefusal.detail), { error: "not live" });
  } finally {
    unregisterSchedulerHook("reports");
    _setReportsHookForTest(null);
  }
});

test("runNow says so plainly when no reports hook is registered here", async () => {
  const seeded = await seedReportSchedule();
  const schedule = q("SELECT * FROM schedules WHERE id = ?", seeded.scheduleId)[0];
  const result = await runNow(db, schedule);
  assert.deepEqual(result, { ok: false, error: "reports are not running here" });
});

/* -------------------------------------------------------------- the panel */

/** Call the panel handler the way the dashboard router does. */
async function panelCall({ method = "GET", query = {}, body = {}, lang = "en" } = {}) {
  const out = { status: 200, html: null, location: null };
  const req = fromLaptop({ method, query, body, csrfToken: "tok123", dashboardSession: SESSION });
  const res = {
    headersSent: false,
    status(n) { out.status = n; return this; },
    set() { return this; },
    json(v) { out.json = v; this.headersSent = true; },
    redirect(a, b) { out.status = typeof a === "number" ? a : 302; out.location = typeof a === "number" ? b : a; this.headersSent = true; },
    redirectAfterPost(url) { out.status = 303; out.location = url; this.headersSent = true; },
  };
  const layout = (o) => `<title>${o.title}</title>${o.content}`;
  const { default: panel } = await import("../servers/gateway/dashboard/panels/schedule.js");
  const html = await panel.handler(req, res, { db, layout, lang });
  if (html !== undefined) out.html = html;
  return out;
}

test("the Schedule panel shows a report row's own note and no controls for it", async () => {
  const seeded = await seedReportSchedule({ title: "Board pack" });
  const model = await buildScheduleModel(db, { now: NOW, selected: seeded.scheduleId });
  const item = model.items.find((it) => it.id === seeded.scheduleId);
  assert.equal(item.kind, "report");
  assert.equal(item.owned, true);
  assert.equal(item.app, "Reports");
  assert.equal(item.title, seeded.title, "the report's own title");

  const html = renderSchedulePage({
    ...model, lang: "en", csrf: "tok123", toast: null, notice: null, pageNotice: null,
    confirmDelete: false, create: null, createOpen: false, mediaInstalled: false,
  });
  assert.match(html, /Reports are scheduled from the report page\./);
  assert.match(html, /href="\/dashboard\/reports"/);
  assert.doesNotMatch(html, /name="action" value="(run-now|pause|resume|delete)"/,
    "no Run now, Pause, Resume or Delete for a report's row");
  assert.match(html, /sc-chip-info">Report</, "the type chip says Report");

  const es = renderSchedulePage({
    ...model, lang: "es", csrf: "tok123", toast: null, notice: null, pageNotice: null,
    confirmDelete: false, create: null, createOpen: false, mediaInstalled: false,
  });
  assert.match(es, /Los informes se programan desde la página del informe\./);
  assert.equal(translations["schedule.err.reportOwned"].en, OWNED_TEXT);
});

test("the delete confirm is never offered for a report row, and the delete POST is refused", async () => {
  const seeded = await seedReportSchedule();
  const confirmPage = await panelCall({ query: { id: `crow:${seeded.scheduleId}`, confirm: "delete" } });
  assert.equal(confirmPage.status, 200);
  assert.doesNotMatch(confirmPage.html, /id="sc-confirm-text"/, "no confirm pane");
  assert.doesNotMatch(confirmPage.html, /name="action" value="delete"/);
  assert.match(confirmPage.html, /Reports are scheduled from the report page\./);

  const refused = await panelCall({
    method: "POST",
    body: { _csrf: "tok123", action: "delete", id: String(seeded.scheduleId), confirm: "1" },
  });
  assert.equal(refused.status, 303);
  assert.match(refused.location, /error=report-owned/);
  assert.equal(q("SELECT COUNT(*) AS n FROM schedules WHERE id = ?", seeded.scheduleId)[0].n, 1,
    "the row survived");

  const page = await panelCall({ query: { id: `crow:${seeded.scheduleId}`, error: "report-owned" } });
  assert.equal(page.status, 200);
  assert.match(page.html, new RegExp(OWNED_TEXT.replace(/\./g, "\\.")));
});