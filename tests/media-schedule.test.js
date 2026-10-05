/**
 * The daily briefing schedule (bundles/media/server/schedule.js) on a real database with the real
 * core `schedules` and `notifications` tables: the one row, the time zone, the lead, catch-up,
 * exactly once across a restart and across two runners, retry once, and the announcement.
 * The voice is the gateway's real adapter against a local stand-in; notifications are the real helper.
 */
import "./helpers/media-isolate.js";   // first: this file's own home, data dir and database
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { freshMediaDb, startFakeVoice, setVoiceProfiles, CLOUD_DEFAULT, localVoice, seedSource, seedArticle, REPO } from "./helpers/media-fixtures.js";
import { startScheduler, stopScheduler } from "../servers/gateway/scheduler.js";
import { readJsonSetting, CONFIG_KEY, JOB_STATE_KEY } from "../bundles/media/server/settings.js";
import { getBriefing, ownerAlive, OWNER, processStart } from "../bundles/media/server/briefing.js";
import { resetWatcherState } from "../bundles/media/server/attachments.js";
import { SCHEDULE_TASK, DEFAULT_CRON, STUCK_MS, normalizeConfig, readSchedule, saveSchedule, scheduleView, runScheduleTick, startScheduleLoop } from "../bundles/media/server/schedule.js";
import { shouldRunBackgroundTasks } from "../bundles/media/server/tasks.js";
import { addonStdioEnv } from "../servers/gateway/proxy.js";
import { hostTimeZone } from "../bundles/media/server/zone.js";

const cleanups = [];
after(async () => { stopScheduler(); for (const c of cleanups.reverse()) await c(); });
const run = promisify(execFile);
const at = (s) => Date.parse(s);
const TZ = "America/Chicago";
const OCC = at("2026-10-06T13:00:00Z");            // Tuesday 08:00 in Chicago
const SAVED = at("2026-10-05T20:00:00Z");          // the schedule was set the afternoon before
const rows = async (db, sql, args = []) => (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const briefings = (db) => rows(db, "SELECT id, kind, status, scheduled_for, attempts, error, audio_path IS NOT NULL AS audio, announced_at, ready_at FROM media_briefings ORDER BY id");
const notices = (db) => rows(db, "SELECT title, body, action_url, priority, source FROM notifications ORDER BY id");
const hush = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

async function world({ voice = true, cron, show = false } = {}) {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const v = await startFakeVoice(); cleanups.push(() => v.close());
  await setVoiceProfiles(f.db, voice ? [CLOUD_DEFAULT, localVoice(v.url)] : [CLOUD_DEFAULT]);
  const wire = await seedSource(f.db, { name: "Example Wire", url: "https://wire.example.invalid/feed" });
  for (let i = 1; i <= 3; i++) await seedArticle(f.db, { source_id: wire, title: `Story number ${i}`, summary: `Text of story number ${i} for the listener.`, pub_date: new Date(OCC - i * 3_600_000).toISOString() });
  const showId = await seedSource(f.db, { name: "The Example Hour", url: "http://127.0.0.1:9/unused.xml", type: "podcast" });
  const input = { tz: TZ, ...(cron ? { cron } : { time: "08:00" }), ...(show ? { attach: [{ source_id: showId }] } : {}) };
  await saveSchedule(f.db, input, { now: SAVED });
  resetWatcherState();
  const tick = (iso, deps = {}) => hush(() => runScheduleTick(f.db, { now: () => at(iso), refresh: null, speech: { log: () => {} }, ...deps }));
  return { ...f, voice: v, tick, wire, showId };
}

test("saving the schedule: one row with the real column names, the next run in the named zone, settings stored per instance", async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  assert.deepEqual(scheduleView(null, normalizeConfig(null)).state, "unset");
  const first = await saveSchedule(f.db, { tz: TZ }, { now: at("2026-10-05T05:00:00Z") });
  const all = await rows(f.db, "SELECT task, cron_expression, description, enabled, next_run FROM schedules");
  assert.deepEqual(all, [{ task: SCHEDULE_TASK, cron_expression: DEFAULT_CRON, description: "Daily news briefing (News)", enabled: 1, next_run: "2026-10-05T13:00:00.000Z" }]);
  assert.deepEqual([first.view.state, first.view.time, first.view.tz, new Date(first.view.next).toISOString()], ["on", "08:00", TZ, "2026-10-05T13:00:00.000Z"]);
  const second = await saveSchedule(f.db, { time: "7:30", max_stories: 6 }, { now: at("2026-10-05T05:00:00Z") });
  assert.equal(second.row.cron_expression, "30 7 * * *");
  assert.equal(second.cfg.max_stories, 6);
  assert.equal((await rows(f.db, "SELECT COUNT(*) AS n FROM schedules"))[0].n, 1, "changing the time changes the row; it never adds one");
  assert.equal((await rows(f.db, "SELECT next_run FROM schedules"))[0].next_run, "2026-10-05T12:30:00.000Z");
  const off = await saveSchedule(f.db, { enabled: false }, { now: at("2026-10-05T05:00:00Z") });
  assert.deepEqual([off.view.state, off.view.next, off.row.next_run, off.row.cron_expression], ["off", null, null, "30 7 * * *"]);
  const stored = await readJsonSetting(f.db, CONFIG_KEY);
  assert.deepEqual([stored.tz, stored.lead_min, stored.max_stories, stored.catch_up_hours, stored.notify, stored.attach], [TZ, 15, 6, 4, true, []]);
  assert.equal((await rows(f.db, "SELECT COUNT(*) AS n FROM dashboard_settings WHERE key = ?", [CONFIG_KEY]))[0].n, 0, "not a synced global setting");
  assert.equal((await rows(f.db, "SELECT COUNT(*) AS n FROM dashboard_settings_overrides WHERE key = ?", [CONFIG_KEY]))[0].n, 1, "a per-instance value");
  for (const [input, code] of [[{ time: "25:00" }, "bad_time"], [{ time: "8" }, "bad_time"], [{ cron: "@daily" }, "bad_cron"], [{ cron: "0 8 * * * *" }, "bad_cron"], [{ tz: "Mars/Olympus" }, "bad_tz"], [{ attach: [{ source_id: 424242 }] }, "bad_source"]]) {
    await assert.rejects(saveSchedule(f.db, input), { code }, JSON.stringify(input));
  }
  assert.equal((await readSchedule(f.db)).row.cron_expression, "30 7 * * *", "a refused change leaves the row alone");
  assert.equal(normalizeConfig({}).tz, hostTimeZone(), "the zone defaults to the host's, by name");
  assert.deepEqual(normalizeConfig({ tz: "nope", lead_min: 9999, max_stories: 0, catch_up_hours: -1, attach: [{ source_id: 3, days: [1, 1, 9, "2"], wait_hours: 99, title_prefix: "x".repeat(200) }, { source_id: 3 }, { source_id: "x" }], junk: 1 }),
    { tz: hostTimeZone(), lead_min: 120, max_stories: 1, catch_up_hours: 0, attach: [{ source_id: 3, days: [1, 2], title_prefix: "x".repeat(80), wait_hours: 12 }], notify: true, active_from: null });
});

test("only an enabled show with audio can follow the briefing", async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const site = await seedSource(f.db, { name: "Site", url: "https://site.example.invalid/rss" });
  const show = await seedSource(f.db, { name: "Show", url: "https://show.example.invalid/p.xml", type: "podcast" });
  const typedRss = await seedSource(f.db, { name: "Show typed as a site feed", url: "https://show2.example.invalid/p.xml" });
  await seedArticle(f.db, { source_id: typedRss, title: "Episode", pub_date: "2026-10-05T12:00:00.000Z", audio_url: "https://show2.example.invalid/e.mp3" });
  const offShow = await seedSource(f.db, { name: "Off", url: "https://off.example.invalid/p.xml", type: "podcast", enabled: 0 });
  await assert.rejects(saveSchedule(f.db, { attach: [{ source_id: site }] }), { code: "bad_source" });
  await assert.rejects(saveSchedule(f.db, { attach: [{ source_id: offShow }] }), { code: "bad_source" });
  const ok = await saveSchedule(f.db, { attach: [{ source_id: show, title_prefix: "Show 20" }, { source_id: typedRss, days: [6] }] });
  assert.deepEqual(ok.cfg.attach, [{ source_id: show, days: [1, 2, 3, 4, 5], title_prefix: "Show 20", wait_hours: 3.5 }, { source_id: typedRss, days: [6], title_prefix: "", wait_hours: 3.5 }]);
  // The Briefings tab saves the show without a prefix: a prefix set through the tool survives it.
  assert.equal((await saveSchedule(f.db, { attach: [{ source_id: show, days: [1, 2, 3, 4, 5] }] })).cfg.attach[0].title_prefix, "Show 20");
  assert.equal((await saveSchedule(f.db, { attach: [{ source_id: show, title_prefix: "" }] })).cfg.attach[0].title_prefix, "", "an explicit empty prefix clears it");
  assert.deepEqual((await saveSchedule(f.db, { attach: [] })).cfg.attach, []);
});

test("changing the time zone never makes up a morning that only became past because of the change", async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  await saveSchedule(f.db, { time: "08:00", tz: "UTC" }, { now: at("2026-10-05T05:00:00Z") });
  // At 10:00 Chicago time (15:00Z) the zone is switched from UTC to Chicago.
  const saved = await saveSchedule(f.db, { tz: TZ }, { now: at("2026-10-06T15:00:00Z") });
  assert.equal(saved.cfg.active_from, "2026-10-06T15:00:00.000Z");
  const r = await hush(() => runScheduleTick(f.db, { now: () => at("2026-10-06T15:01:00Z"), refresh: null, speech: { log: () => {} } }));
  assert.equal(r.claimed, null, "08:00 Chicago (13:00Z) is inside the catch-up window but before the change: not made");
  assert.equal((await briefings(f.db)).length, 0);
});

test("the gateway's own scheduler may advance the row as it likes: this module never reads last_run or next_run", async () => {
  const w = await world();
  await hush(async () => { const log = console.log; console.log = () => {}; try { await startScheduler(w.db); } finally { stopScheduler(); console.log = log; } });
  const afterBoot = (await rows(w.db, "SELECT cron_expression, enabled, next_run FROM schedules WHERE task = ?", [SCHEDULE_TASK]))[0];
  assert.equal(afterBoot.cron_expression, DEFAULT_CRON);
  assert.ok(afterBoot.next_run, "the gateway recomputed next_run at its start, as it does for every row");
  // What the gateway does at 08:00:30: marks the row run and moves next_run to tomorrow. The audit's lost race.
  await w.db.execute({ sql: "UPDATE schedules SET last_run = ?, next_run = ? WHERE task = ?", args: ["2026-10-06T13:00:30.000Z", "2026-10-07T13:00:00.000Z", SCHEDULE_TASK] });
  const r = await w.tick("2026-10-06T13:01:00Z");
  assert.ok(r.claimed > 0, "still claimed");
  assert.equal((await briefings(w.db))[0].scheduled_for, "2026-10-06T13:00:00.000Z");
});

test("a morning: nothing before the lead, made once at 7:45, announced once at 8:00, nothing after", async () => {
  const w = await world();
  assert.equal((await w.tick("2026-10-06T12:44:00Z")).claimed, null);
  assert.deepEqual(await briefings(w.db), []);
  const made = await w.tick("2026-10-06T12:45:00Z");
  assert.ok(made.claimed > 0);
  let [b] = await briefings(w.db);
  assert.deepEqual([b.kind, b.status, b.scheduled_for, b.attempts, b.audio, b.announced_at, b.ready_at], ["daily", "ready", "2026-10-06T13:00:00.000Z", 1, 1, null, "2026-10-06T12:45:00.000Z"]);
  assert.deepEqual(await notices(w.db), [], "made early, announced on time");
  for (const t of ["2026-10-06T12:46:00Z", "2026-10-06T12:59:00Z"]) assert.deepEqual([(await w.tick(t)).claimed, (await w.tick(t)).announced], [null, []]);
  assert.deepEqual((await w.tick("2026-10-06T13:00:00Z")).announced, [made.claimed]);
  for (const t of ["2026-10-06T13:01:00Z", "2026-10-06T16:59:00Z", "2026-10-06T23:00:00Z"]) { const r = await w.tick(t); assert.deepEqual([r.claimed, r.retried, r.announced], [null, null, []], t); }
  assert.equal((await briefings(w.db)).length, 1);
  assert.deepEqual(await notices(w.db), [{ title: "Your morning briefing is ready", body: "2 stories · 1 min", action_url: `/dashboard/media?play=briefing:${made.claimed}`, priority: "normal", source: "media:briefing" }]);
  const full = await getBriefing(w.db, made.claimed);
  assert.equal(full.title, "Morning briefing, Tuesday");
  assert.equal(full.script.split("\n\n")[0], "Good morning. It's Tuesday, October 6th. Here are 2 stories.", "dated for the occurrence, not for the minute it was written");
  assert.equal(full.late, false);
  const beat = await readJsonSetting(w.db, JOB_STATE_KEY);
  assert.deepEqual(beat, { tick_at: "2026-10-06T23:00:00.000Z", state: "on", error: null });
  // The next day is a new occurrence.
  assert.ok((await w.tick("2026-10-07T12:50:00Z")).claimed > made.claimed);
});

test("catch-up: down until 9:30 the briefing is made late and announced at once; down past the window the day is skipped; a new schedule never reaches back", async () => {
  const lateWorld = await world();
  const late = await lateWorld.tick("2026-10-06T14:30:00Z");
  assert.ok(late.claimed > 0);
  assert.deepEqual(late.announced, [late.claimed]);
  assert.equal((await getBriefing(lateWorld.db, late.claimed)).late, true);
  assert.equal((await getBriefing(lateWorld.db, late.claimed)).scheduled_for, "2026-10-06T13:00:00.000Z");

  const skipped = await world();
  assert.equal((await skipped.tick("2026-10-06T17:30:00Z")).claimed, null, "4.5 hours late is past the 4-hour window");
  assert.deepEqual(await briefings(skipped.db), []);

  const fresh = await world();
  await saveSchedule(fresh.db, { time: "08:00" }, { now: at("2026-10-06T15:00:00Z") });   // set at 10:00 local, unchanged: active_from stays the day before
  assert.ok((await fresh.tick("2026-10-06T15:01:00Z")).claimed > 0, "an unchanged save does not move active_from");
  const created = await world();
  await saveSchedule(created.db, { time: "08:05" }, { now: at("2026-10-06T15:00:00Z") }); // the time is changed at 10:00 local
  assert.equal((await created.tick("2026-10-06T15:01:00Z")).claimed, null, "this morning's 8:05 was before the change");
  assert.ok((await created.tick("2026-10-07T12:50:00Z")).claimed > 0, "tomorrow's is made");
});

test("off, unset and a row News cannot run: nothing is made, nothing throws, and the state is recorded", async () => {
  const w = await world();
  await saveSchedule(w.db, { enabled: false }, { now: SAVED });
  assert.deepEqual([(await w.tick("2026-10-06T12:50:00Z")).state, (await briefings(w.db)).length], ["off", 0]);
  await w.db.execute({ sql: "UPDATE schedules SET enabled = 1, cron_expression = '@daily' WHERE task = ?", args: [SCHEDULE_TASK] });   // as crow_update_schedule could write it
  const bad = await w.tick("2026-10-06T12:51:00Z");
  assert.deepEqual([bad.state, bad.error, bad.claimed], ["bad_cron", "bad_cron", null]);
  assert.equal((await readJsonSetting(w.db, JOB_STATE_KEY)).state, "bad_cron");
  assert.equal(scheduleView((await readSchedule(w.db)).row, normalizeConfig({ tz: TZ })).state, "bad_cron");
  await w.db.execute({ sql: "DELETE FROM schedules WHERE task = ?", args: [SCHEDULE_TASK] });
  assert.equal((await w.tick("2026-10-06T12:52:00Z")).state, "unset");
});

test("daylight saving: 8:00 local on both sides of both changes, including the spring day", async () => {
  const w = await world();
  await saveSchedule(w.db, { time: "08:00" }, { now: at("2026-10-01T00:00:00Z") });
  for (const [tickAt, occ] of [["2026-10-31T12:50:00Z", "2026-10-31T13:00:00.000Z"], ["2026-11-01T13:50:00Z", "2026-11-01T14:00:00.000Z"], ["2027-03-13T13:50:00Z", "2027-03-13T14:00:00.000Z"], ["2027-03-14T12:50:00Z", "2027-03-14T13:00:00.000Z"]]) {
    const r = await w.tick(tickAt);
    assert.ok(r.claimed > 0, tickAt);
    assert.equal((await getBriefing(w.db, r.claimed)).scheduled_for, occ);
  }
  assert.equal((await w.tick("2026-11-01T12:50:00Z")).claimed, null, "13:00Z on the day the clocks went back is 7:00 local: not an occurrence");
});

test("a restart at 7:50 changes nothing: the claim is in the database, and a fresh process sees it", { timeout: 90_000 }, async () => {
  const w = await world();
  const script = `
    const { createDbClient } = await import("./bundles/media/server/db.js");
    const { runScheduleTick } = await import("./bundles/media/server/schedule.js");
    const db = createDbClient(process.argv[1]);
    const r = await runScheduleTick(db, { now: () => Date.parse(process.argv[2]), refresh: null, audio: false });
    db.close();
    process.stdout.write(JSON.stringify(r));`;
  const child = async (iso) => JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script, w.dbPath, iso], { cwd: REPO, timeout: 30_000 })).stdout);
  const first = await child("2026-10-06T12:45:00Z");
  assert.ok(first.claimed > 0);
  const second = await child("2026-10-06T12:50:00Z");           // a new process: the gateway restarted
  assert.deepEqual([second.claimed, second.retried], [null, null]);
  const third = await child("2026-10-06T13:00:00Z");
  assert.deepEqual(third.announced, [first.claimed]);
  assert.deepEqual((await child("2026-10-06T13:01:00Z")).announced, []);
  assert.equal((await briefings(w.db)).length, 1);
  assert.equal((await notices(w.db)).length, 1);
  assert.equal((await notices(w.db))[0].title, "Your briefing is ready to read", "this run was text only");
});

test("two runners at the same minute make one briefing and send one notice", { timeout: 90_000 }, async () => {
  const w = await world();
  const startAt = Date.now() + 2000;
  const script = `
    const { createDbClient } = await import("./bundles/media/server/db.js");
    const { runScheduleTick } = await import("./bundles/media/server/schedule.js");
    const db = createDbClient(process.argv[1]);
    while (Date.now() < Number(process.argv[3])) {}
    const r = await runScheduleTick(db, { now: () => Date.parse(process.argv[2]), refresh: null, audio: false });
    db.close();
    process.stdout.write(JSON.stringify(r));`;
  const both = async (iso, start) => (await Promise.all([1, 2, 3].map(() => run(process.execPath, ["--input-type=module", "-e", script, w.dbPath, iso, String(start)], { cwd: REPO, timeout: 30_000 })))).map((r) => JSON.parse(r.stdout));
  const made = await both("2026-10-06T12:45:00Z", startAt);
  assert.equal(made.filter((r) => r.claimed !== null).length, 1, JSON.stringify(made));
  const told = await both("2026-10-06T13:00:00Z", Date.now() + 2000);
  assert.equal(told.filter((r) => r.announced.length === 1).length, 1, JSON.stringify(told));
  assert.equal((await briefings(w.db)).length, 1);
  assert.equal((await notices(w.db)).length, 1);
});

test("retry once: a failed attempt is tried again on the next minute; a second failure ends it with one plain notice", async () => {
  const w = await world();
  let calls = 0;
  const flaky = { refresh: async () => { calls++; if (calls === 1) throw new Error("feeds exploded"); return { fetched: 0, failed: 0, skipped: 0 }; } };
  const first = await w.tick("2026-10-06T12:45:00Z", flaky);
  assert.ok(first.claimed > 0);
  assert.deepEqual((await briefings(w.db)).map((b) => [b.status, b.attempts, b.error]), [["generating", 1, "feeds exploded"]]);
  const second = await w.tick("2026-10-06T12:46:00Z", flaky);
  assert.deepEqual([second.retried, second.claimed], [first.claimed, null]);
  assert.deepEqual((await briefings(w.db)).map((b) => [b.status, b.attempts, b.error, b.audio]), [["ready", 2, null, 1]]);

  const w2 = await world();
  const broken = { refresh: async () => { throw new Error("no network"); } };
  const a = await w2.tick("2026-10-06T12:45:00Z", broken);
  const b = await w2.tick("2026-10-06T12:46:00Z", broken);
  const c = await w2.tick("2026-10-06T12:47:00Z", broken);
  const d = await w2.tick("2026-10-06T12:48:00Z", broken);
  assert.deepEqual([b.retried, c.failed, d.retried, d.failed, d.claimed], [a.claimed, a.claimed, null, null, null], "one retry, then failed, then left alone");
  assert.deepEqual((await briefings(w2.db)).map((x) => [x.status, x.attempts, x.error]), [["failed", 2, "no network"]]);
  assert.deepEqual(await notices(w2.db), [], "not before the hour");
  await w2.tick("2026-10-06T13:00:00Z", broken);
  await w2.tick("2026-10-06T13:01:00Z", broken);
  assert.deepEqual(await notices(w2.db), [{ title: "Today's briefing could not be made", body: "something went wrong (no network).", action_url: "/dashboard/media?tab=briefings", priority: "normal", source: "media:briefing" }]);
});

test("a claim that never finishes (the runner died) is retried after 20 minutes, once, then failed", async () => {
  const w = await world();
  const created = at("2026-10-06T12:45:00Z");
  await w.db.execute({ sql: "INSERT INTO media_briefings (kind, status, scheduled_for, attempts, lang, created_at) VALUES ('daily', 'generating', ?, 1, 'en', '2026-10-06 12:45:00')", args: [new Date(OCC).toISOString()] });
  const stay = await w.tick(new Date(created + STUCK_MS - 60_000).toISOString());
  assert.deepEqual([stay.retried, stay.failed], [null, null], "19 minutes: someone may still be working");
  // The retry itself dies too (the voice hangs past this tick's patience): simulate by claiming the retry without finishing it.
  await w.db.execute("UPDATE media_briefings SET attempts = 2");
  const stay2 = await w.tick(new Date(created + 2 * STUCK_MS - 60_000).toISOString());
  assert.deepEqual([stay2.retried, stay2.failed], [null, null]);
  const dead = await w.tick(new Date(created + 2 * STUCK_MS + 60_000).toISOString());
  assert.ok(dead.failed > 0);
  assert.deepEqual((await briefings(w.db)).map((b) => [b.status, b.error]), [["failed", "stuck"]]);
  assert.equal((await notices(w.db))[0].body, "it did not finish.");
  // And the one-retry path from a clean stuck row.
  const w2 = await world();
  await w2.db.execute({ sql: "INSERT INTO media_briefings (kind, status, scheduled_for, attempts, lang, created_at) VALUES ('daily', 'generating', ?, 1, 'en', '2026-10-06 12:45:00')", args: [new Date(OCC).toISOString()] });
  const retried = await w2.tick(new Date(created + STUCK_MS + 60_000).toISOString());
  assert.ok(retried.retried > 0);
  assert.deepEqual((await briefings(w2.db)).map((b) => [b.status, b.attempts, b.audio]), [["ready", 2, 1]]);
});

test("no local voice at 7:45: the briefing is announced as ready to read, with the reason; notify off sends nothing", async () => {
  const w = await world({ voice: false });
  const made = await w.tick("2026-10-06T12:45:00Z");
  await w.tick("2026-10-06T13:00:00Z");
  assert.equal(w.voice.requests.length, 0);
  assert.deepEqual(await notices(w.db), [{ title: "Your briefing is ready to read", body: "No audio: no local voice is set up.", action_url: `/dashboard/media?open=briefing:${made.claimed}`, priority: "normal", source: "media:briefing" }]);
  const down = await world();
  await down.voice.close();
  await down.tick("2026-10-06T12:45:00Z");
  await down.tick("2026-10-06T13:00:00Z");
  assert.equal((await notices(down.db))[0].body, "No audio: the local voice did not answer.");
  const silent = await world();
  await saveSchedule(silent.db, { notify: false }, { now: SAVED });
  await silent.tick("2026-10-06T12:45:00Z");
  assert.equal((await silent.tick("2026-10-06T13:00:00Z")).announced.length, 1);
  assert.deepEqual(await notices(silent.db), []);
  assert.ok((await briefings(silent.db))[0].announced_at);
});

test("a show follows on its days only: a weekday briefing waits for it and says so; a Saturday one does not mention it", async () => {
  const w = await world({ show: true });
  const tue = await w.tick("2026-10-06T12:45:00Z");
  const b = await getBriefing(w.db, tue.claimed);
  assert.deepEqual(b.attachments.map((a) => [a.key, a.title, a.status, a.expect, a.wait_until, a.url]), [[`show:${w.showId}`, "The Example Hour", "pending", "2026-10-06", "2026-10-06T16:30:00.000Z", null]]);
  assert.equal(b.script.split("\n\n").at(-1), "That's your briefing. Today's The Example Hour follows as soon as it is published.");
  const sat = await w.tick("2026-10-10T12:45:00Z");
  const s = await getBriefing(w.db, sat.claimed);
  assert.deepEqual(s.attachments, []);
  assert.equal(s.script.split("\n\n").at(-1), "That's your briefing.");
  assert.equal(s.title, "Morning briefing, Saturday");
});

test("a claim whose maker died (a restart between 7:45 and the finish) is retried on the next tick, not 20 minutes later", { timeout: 60_000 }, async () => {
  const w = await world();
  const gone = (await run(process.execPath, ["-e", "process.stdout.write(String(process.pid))"])).stdout;   // a pid that has exited
  const ins = await w.db.execute({
    sql: "INSERT INTO media_briefings (title, kind, status, scheduled_for, attempts, lang, created_at, owner) VALUES (NULL, 'daily', 'generating', ?, 1, 'en', '2026-10-06 12:45:00', ?)",
    args: ["2026-10-06T13:00:00.000Z", `${gone}:12345`],
  });
  const id = Number(ins.lastInsertRowid);
  const r = await w.tick("2026-10-06T12:47:00Z");
  assert.equal(r.retried, id, "retried at once: its owner is gone");
  const b = (await briefings(w.db))[0];
  assert.deepEqual([b.status, b.attempts, b.audio], ["ready", 2, 1]);
  // A live owner in another process is left alone until the 20-minute rule.
  const w2 = await world();
  await w2.db.execute({
    sql: "INSERT INTO media_briefings (title, kind, status, scheduled_for, attempts, lang, created_at, owner) VALUES (NULL, 'daily', 'generating', ?, 1, 'en', '2026-10-06 12:45:00', ?)",
    args: ["2026-10-06T13:00:00.000Z", "1:alive-elsewhere"],
  });
  const r2 = await w2.tick("2026-10-06T12:47:00Z", { ownerAlive: () => true });
  assert.deepEqual([r2.claimed, r2.retried], [null, null]);
});

test("owner identity: this process is alive; a gone pid or a recycled pid (other start time) is dead; unreadable owners are not judged", async () => {
  assert.match(OWNER, /^\d+:\S+$/);
  assert.equal(ownerAlive(OWNER), true);
  assert.equal(ownerAlive(`${process.pid}:not-my-start`, { startOf: () => "1234" }), false, "same pid, another start time: the pid was recycled");
  assert.equal(ownerAlive("4194303:1", { kill: () => { throw Object.assign(new Error("no"), { code: "ESRCH" }); } }), false);
  assert.equal(ownerAlive("1:1", { kill: () => { throw Object.assign(new Error("no"), { code: "EPERM" }); }, startOf: () => "1" }), true, "EPERM means the process exists");
  for (const odd of [null, "", "abc", "12"]) assert.equal(ownerAlive(odd), true, String(odd));
});

test("only the gateway's own copy runs background work; a bot's private copy of the add-on never does", () => {
  const addon = { env: { CROW_MEDIA_TASKS: "1" } };
  assert.equal(shouldRunBackgroundTasks(addonStdioEnv(addon, {})), true, "the gateway's child");
  assert.equal(shouldRunBackgroundTasks({ ...addon.env }), false, "the same add-on entry started by a bot (no gateway marker)");
  assert.equal(shouldRunBackgroundTasks(addonStdioEnv({ env: { CROW_MEDIA_TASKS: "0" } }, {})), false, "the add-on setting still applies");
  assert.equal(addonStdioEnv({ env: { CROW_ADDON_HOST: "elsewhere" } }, {}).CROW_ADDON_HOST, "gateway", "an add-on entry cannot drop or fake the marker");
  assert.equal(addonStdioEnv({ env: { A: "1" } }, { PATH: "/bin" }).PATH, "/bin");
});

test("the minute loop never overlaps itself and stops cleanly", async () => {
  let running = 0, max = 0, calls = 0;
  const stop = startScheduleLoop({}, { intervalMs: 10, firstDelayMs: 0, tick: async () => { calls++; running++; max = Math.max(max, running); await new Promise((ok) => setTimeout(ok, 45)); running--; } });
  await new Promise((ok) => setTimeout(ok, 200));
  stop();
  const seen = calls;
  await new Promise((ok) => setTimeout(ok, 80));
  assert.equal(max, 1, "a tick still running makes the next one wait");
  assert.ok(seen >= 2, `ticks: ${seen}`);
  assert.ok(calls <= seen + 1, "nothing starts after stop()");
});
