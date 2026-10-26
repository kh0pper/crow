/**
 * The memory server's schedule tools after the schedule-core change: every row gets a type (from
 * its task text), reminders keep their prefix, one-shots via `at`, zones, refusals, run_now, and
 * delete taking the run history with it. Real init-db into a tmpdir (never ~/.crow).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "memory-schedule-tools-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname;
const raw = () => new Database(DB_FILE);
const q = (sql, ...args) => { const c = raw(); try { return c.prepare(sql).all(...args); } finally { c.close(); } };
const x = (sql, ...args) => { const c = raw(); try { return c.prepare(sql).run(...args); } finally { c.close(); } };

let client;
before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  x("INSERT INTO dashboard_settings (key, value) VALUES ('instance_timezone', 'America/Chicago')");
  const { createMemoryServer } = await import("../servers/memory/server.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const server = createMemoryServer(DB_FILE);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
});
after(async () => { try { await client?.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
};
const create = (args) => call("crow_create_schedule", args);
const update = (args) => call("crow_update_schedule", args);
const lastRow = () => q("SELECT * FROM schedules ORDER BY id DESC LIMIT 1")[0];
const idOf = (text) => Number(/id: (\d+)/.exec(text)[1]);

test("a reminder is stored with its prefix and no zone (it follows the instance)", async () => {
  const r = await create({ task: "stretch", cron_expression: "0 9 * * *" });
  assert.equal(r.isError, false, r.text);
  const row = lastRow();
  assert.equal(row.task, "reminder:stretch");
  assert.equal(row.tz, null);
  assert.match(r.text, /Reminder/);
  // 09:00 in the instance zone (America/Chicago, CDT/CST) — 14:00Z or 15:00Z
  assert.ok(/T1[45]:00:00\.000Z$/.test(row.next_run), row.next_run);
  const again = await create({ task: "reminder:water", cron_expression: "0 9 * * *" });
  assert.equal(again.isError, false);
  assert.equal(lastRow().task, "reminder:water", "an existing prefix is not doubled");
});

test("tz is validated and stored; the next run is in that zone", async () => {
  const bad = await create({ task: "x", cron_expression: "0 9 * * *", tz: "Mars/Base" });
  assert.equal(bad.isError, true);
  const ok = await create({ task: "tokyo", cron_expression: "0 9 * * *", tz: "Asia/Tokyo" });
  assert.equal(ok.isError, false, ok.text);
  const row = lastRow();
  assert.equal(row.tz, "Asia/Tokyo");
  assert.ok(row.next_run.endsWith("T00:00:00.000Z"), row.next_run);
});

test("`at` makes a one-shot; a past time and two timings are refused", async () => {
  const at = new Date(Date.now() + 3_600_000).toISOString();
  const r = await create({ task: "call the vet", at });
  assert.equal(r.isError, false, r.text);
  const row = lastRow();
  assert.equal(row.cron_expression, "@once");
  assert.equal(row.next_run, at);
  assert.equal((await create({ task: "late", at: new Date(Date.now() - 60_000).toISOString() })).isError, true);
  assert.equal((await create({ task: "both", at, cron_expression: "0 9 * * *" })).isError, true);
  assert.equal((await create({ task: "neither" })).isError, true);
  assert.equal((await create({ task: "raw once", cron_expression: "@once" })).isError, true);
});

test("`when` takes plain words: a repeating one, a one-shot, and a refusal with its hint", async () => {
  const r = await create({ task: "standup", when: "every weekday at 8" });
  assert.equal(r.isError, false, r.text);
  let row = lastRow();
  assert.equal(row.cron_expression, "0 8 * * 1-5");
  assert.equal(row.task, "reminder:standup");
  assert.match(r.text, /Every weekday at 8:00 AM/);
  assert.equal((r.text.match(/^- .*\d:\d\d/gm) || []).length, 3, "the next 3 runs are listed");
  const es = await create({ task: "gym", when: "todos los lunes a las 18:00", tz: "Europe/Madrid" });
  assert.equal(es.isError, false, es.text);
  row = lastRow();
  assert.equal(row.cron_expression, "0 18 * * 1");
  assert.equal(row.tz, "Europe/Madrid");
  const once = await create({ task: "oven", when: "in 20 minutes" });
  assert.equal(once.isError, false, once.text);
  row = lastRow();
  assert.equal(row.cron_expression, "@once");
  const gap = Date.parse(row.next_run) - Date.now();
  assert.ok(gap > 19 * 60_000 && gap <= 21 * 60_000, row.next_run);
  const often = await create({ task: "spam", when: "every 15 minutes" });
  assert.equal(often.isError, true);
  assert.match(often.text, /at most once an hour/);
  const vague = await create({ task: "x", when: "whenever" });
  assert.equal(vague.isError, true);
  assert.match(vague.text, /every weekday at 8/);
  assert.equal((await create({ task: "both", when: "every day at 8", cron_expression: "0 8 * * *" })).isError, true);
  const long = await create({ task: "x", when: "every day at 8 ".repeat(30) });
  assert.equal(long.isError, true);
  assert.match(long.text, /too long/, "the parser's own hint reaches the caller");
});

test("a reminder more often than hourly is refused; a bot routine may be", async () => {
  const r = await create({ task: "check logs", cron_expression: "*/5 * * * *" });
  assert.equal(r.isError, true);
  assert.match(r.text, /hour/);
  assert.equal((await create({ task: "hourly", cron_expression: "0 * * * *" })).isError, false);
  assert.equal((await create({ task: "pipeline:botcron:alpha", cron_expression: "*/10 * * * *" })).isError, false, "today's raw botcron create still works");
});

test("type refusals: briefing, other pipeline:, a bot routine without a botcron task, a reminder with one", async () => {
  const b = await create({ task: "news", cron_expression: "0 8 * * *", type: "briefing" });
  assert.equal(b.isError, true);
  assert.match(b.text, /crow_media_schedule_briefing/);
  assert.equal((await create({ task: "media:briefing", cron_expression: "0 8 * * *" })).isError, true);
  assert.equal((await create({ task: "pipeline:other", cron_expression: "0 8 * * *" })).isError, true);
  assert.equal((await create({ task: "do things", cron_expression: "0 8 * * *", type: "bot_routine" })).isError, true);
  assert.equal((await create({ task: "pipeline:botcron:alpha", cron_expression: "0 8 * * *", type: "reminder" })).isError, true);
});

test("a task edit may not change the type; a briefing row is managed in News", async () => {
  const id = idOf((await create({ task: "plain", cron_expression: "0 9 * * *" })).text);
  assert.equal((await update({ id, task: "pipeline:botcron:alpha" })).isError, true);
  const ok = await update({ id, task: "still a reminder" });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(q("SELECT task FROM schedules WHERE id = ?", id)[0].task, "reminder:still a reminder");
  const bid = Number(x("INSERT INTO schedules (task, cron_expression) VALUES ('media:briefing', '0 8 * * *')").lastInsertRowid);
  for (const args of [{ enabled: false }, { delete: true }, { cron_expression: "0 7 * * *" }]) {
    const r = await update({ id: bid, ...args });
    assert.equal(r.isError, true);
    assert.match(r.text, /crow_media_schedule_briefing/);
  }
});

test("run_now writes a requested run and never moves next_run; only reminders", async () => {
  const id = idOf((await create({ task: "now", cron_expression: "0 9 * * *" })).text);
  const before = q("SELECT next_run FROM schedules WHERE id = ?", id)[0].next_run;
  const r = await update({ id, run_now: true });
  assert.equal(r.isError, false, r.text);
  const runs = q("SELECT status, source FROM schedule_runs WHERE schedule_id = ?", id);
  assert.deepEqual(runs.map((x) => ({ ...x })), [{ status: "requested", source: "run-now" }]);
  assert.equal(q("SELECT next_run FROM schedules WHERE id = ?", id)[0].next_run, before);
  const bot = idOf((await create({ task: "pipeline:botcron:beta", cron_expression: "0 9 * * *" })).text);
  assert.equal((await update({ id: bot, run_now: true })).isError, true);
});

test("resuming a one-shot whose time has passed is refused; a recurring one resumes from now", async () => {
  const past = Number(x("INSERT INTO schedules (task, cron_expression, enabled, next_run) VALUES ('reminder:gone', '@once', 0, ?)", new Date(Date.now() - 3_600_000).toISOString()).lastInsertRowid);
  const r = await update({ id: past, enabled: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /passed/);
  assert.equal(q("SELECT enabled FROM schedules WHERE id = ?", past)[0].enabled, 0);
  const rec = Number(x("INSERT INTO schedules (task, cron_expression, enabled, next_run) VALUES ('reminder:rec', '0 9 * * *', 0, '2020-01-01T15:00:00.000Z')").lastInsertRowid);
  assert.equal((await update({ id: rec, enabled: true })).isError, false);
  assert.ok(Date.parse(q("SELECT next_run FROM schedules WHERE id = ?", rec)[0].next_run) > Date.now());
});

test("delete takes the run history with it", async () => {
  const id = idOf((await create({ task: "doomed", cron_expression: "0 9 * * *" })).text);
  x("INSERT INTO schedule_runs (schedule_id, status) VALUES (?, 'ok'), (?, 'missed')", id, id);
  const r = await update({ id, delete: true });
  assert.equal(r.isError, false);
  assert.equal(q("SELECT COUNT(*) AS n FROM schedule_runs WHERE schedule_id = ?", id)[0].n, 0);
  assert.equal(q("SELECT COUNT(*) AS n FROM schedules WHERE id = ?", id)[0].n, 0);
});

test("list shows the type, the zone, the last run and the open missed count; and filters by type", async () => {
  const id = idOf((await create({ task: "listed", cron_expression: "0 9 * * *", tz: "Europe/Madrid" })).text);
  x("INSERT INTO schedule_runs (schedule_id, scheduled_for, status, missed_count) VALUES (?, '2026-10-20T08:00:00.000Z', 'missed', 3)", id);
  const all = await call("crow_list_schedules", {});
  const block = all.text.split("\n\n").find((b) => b.startsWith(`[#${id}]`));
  assert.ok(block, all.text);
  assert.match(block, /Reminder/);
  assert.match(block, /Europe\/Madrid/);
  assert.match(block, /missed/);
  assert.match(block, /3 missed/);
  const bots = await call("crow_list_schedules", { type: "bot_routine" });
  assert.ok(!bots.text.includes(`[#${id}]`));
  assert.match(bots.text, /pipeline:botcron:/);
});

test("a memory server newer than its database (no tz, no schedule_runs) still creates and lists", async () => {
  const old = mkdtempSync(join(tmpdir(), "memory-schedule-old-"));
  try {
    execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: old }, stdio: "pipe", cwd: REPO });
    const file = join(old, "crow.db");
    const c = new Database(file);
    c.exec("DROP TABLE schedule_runs; ALTER TABLE schedules DROP COLUMN tz;");
    c.close();
    const { createMemoryServer } = await import("../servers/memory/server.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const server = createMemoryServer(file);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c2 = new Client({ name: "t2", version: "1" });
    await Promise.all([server.connect(st), c2.connect(ct)]);
    try {
      const zoned = await c2.callTool({ name: "crow_create_schedule", arguments: { task: "old db", cron_expression: "0 9 * * *", tz: "Europe/Madrid" } });
      assert.equal(zoned.isError, true, "no tz column: a zone is refused, never silently used");
      const made = await c2.callTool({ name: "crow_create_schedule", arguments: { task: "old db", cron_expression: "0 9 * * *" } });
      assert.ok(!made.isError, made.content[0].text);
      const id0 = Number(/id: (\d+)/.exec(made.content[0].text)[1]);
      const before = new Database(file).prepare("SELECT next_run FROM schedules WHERE id = ?").get(id0).next_run;
      const tzEdit = await c2.callTool({ name: "crow_update_schedule", arguments: { id: id0, tz: "Asia/Tokyo" } });
      assert.equal(tzEdit.isError, true);
      assert.equal(new Database(file).prepare("SELECT next_run FROM schedules WHERE id = ?").get(id0).next_run, before, "next_run not moved to a zone it cannot store");
      const listed = await c2.callTool({ name: "crow_list_schedules", arguments: {} });
      assert.match(listed.content[0].text, /old db/);
      const id = Number(/id: (\d+)/.exec(made.content[0].text)[1]);
      const req = await c2.callTool({ name: "crow_update_schedule", arguments: { id, run_now: true } });
      assert.equal(req.isError, true, "no run history yet: said plainly");
      const del = await c2.callTool({ name: "crow_update_schedule", arguments: { id, delete: true } });
      assert.ok(!del.isError);
    } finally { await c2.close(); }
  } finally { rmSync(old, { recursive: true, force: true }); }
});

test("`at` needs an offset (Z or ±HH:MM); a bare local time is refused", async () => {
  const bare = await create({ task: "no offset", at: "2030-11-03T10:00:00" });
  assert.equal(bare.isError, true);
  assert.match(bare.text, /offset/);
  assert.equal((await create({ task: "with offset", at: "2030-11-03T10:00:00-06:00" })).isError, false);
  assert.equal(lastRow().next_run, "2030-11-03T16:00:00.000Z");
});

test("bot routines take no zone until they can use one; a zone can be cleared", async () => {
  const b = await create({ task: "pipeline:botcron:gamma", cron_expression: "0 9 * * *", tz: "Asia/Tokyo" });
  assert.equal(b.isError, true);
  assert.match(b.text, /zone/);
  const bid = idOf((await create({ task: "pipeline:botcron:gamma", cron_expression: "0 9 * * *" })).text);
  assert.equal((await update({ id: bid, tz: "Asia/Tokyo" })).isError, true);
  const id = idOf((await create({ task: "zoned", cron_expression: "0 9 * * *", tz: "Asia/Tokyo" })).text);
  const cleared = await update({ id, tz: null });
  assert.equal(cleared.isError, false, cleared.text);
  assert.equal(q("SELECT tz FROM schedules WHERE id = ?", id)[0].tz, null);
  assert.ok(/T1[45]:00:00\.000Z$/.test(q("SELECT next_run FROM schedules WHERE id = ?", id)[0].next_run), "back on the instance zone");
});
