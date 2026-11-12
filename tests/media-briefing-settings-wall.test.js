/**
 * The daily briefing inside the add-on wall: the media server's own settings read
 * (bundles/media/server/settings.js) and the schedule tick (schedule.js) against a
 * child that cannot read `<data dir>/instance-id`.
 *
 * The wall is simulated the way it behaves: the path EXISTS and readFileSync()
 * throws (a directory named instance-id gives EISDIR, as the masked /dev/null
 * device gives EACCES), and the gateway's own id arrives in
 * CROW_LOCAL_INSTANCE_ID. Before the fix the child minted a random id per call,
 * matched no dashboard_settings_overrides row, normalized `attach` to [] and made
 * the briefing with no shows — and the tick still claimed the occurrence.
 *
 * Real core+media tables per test (helpers/media-fixtures.js, the db client the
 * media tests use); every instance path is a scratch temp dir.
 */
import "./helpers/media-isolate.js";   // first: this file's own home, data dir and database
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshMediaDb, seedSource, seedArticle } from "./helpers/media-fixtures.js";
import { readSetting, writeSetting } from "../servers/gateway/dashboard/settings/registry.js";
import { readLocalSetting, readJsonSetting, CONFIG_KEY } from "../bundles/media/server/settings.js";
import { readSchedule, runScheduleTick, saveSchedule } from "../bundles/media/server/schedule.js";
import { resetWatcherState } from "../bundles/media/server/attachments.js";

/** The gateway's own instance id (32 hex). */
const REAL_ID = "0123456789abcdef0123456789abcdef";
const TZ = "America/Chicago";
const OCC = "2026-10-06T13:00:00.000Z";      // Tuesday 08:00 in Chicago
const LEAD_TICK = "2026-10-06T12:45:00Z";    // 15 minutes early: the claim
const SAVED = "2026-10-05T20:00:00Z";        // the schedule was set the afternoon before
const at = (s) => Date.parse(s);

const SAVED_ENV = {
  CROW_HOME: process.env.CROW_HOME,
  CROW_DATA_DIR: process.env.CROW_DATA_DIR,
  CROW_LOCAL_INSTANCE_ID: process.env.CROW_LOCAL_INSTANCE_ID,
};
const cleanups = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
afterEach(() => resetWatcherState());

function setEnvId(id) {
  if (id === undefined) delete process.env.CROW_LOCAL_INSTANCE_ID;
  else process.env.CROW_LOCAL_INSTANCE_ID = id;
}

/** A scratch data dir whose instance-id is readable (`fileId`) or masked (`unreadable`). */
function instance({ fileId = REAL_ID, unreadable = false, envId = undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crow-media-wall-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  if (unreadable) mkdirSync(join(dir, "instance-id"));
  else if (fileId !== null) writeFileSync(join(dir, "instance-id"), fileId);
  process.env.CROW_HOME = join(dir, "home");
  process.env.CROW_DATA_DIR = dir;
  setEnvId(envId);
  return dir;
}

/** The wall arriving mid-run: the id file becomes masked (present, unreadable). */
function maskInstanceId(dir) {
  const path = join(dir, "instance-id");
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path);
}

/** The gateway readable again: a plain id file. */
function unmaskInstanceId(dir, id = REAL_ID) {
  const path = join(dir, "instance-id");
  rmSync(path, { recursive: true, force: true });
  writeFileSync(path, id);
}

/** Run `fn` with console.error captured; → { result, lines }. */
async function capture(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try { return { result: await fn(), lines }; } finally { console.error = original; }
}

const briefings = async (db) => (await db.execute(
  "SELECT id, status, scheduled_for, attachments, error FROM media_briefings ORDER BY id",
)).rows.map((r) => ({ ...r }));

/** One minute tick with the seams the existing schedule tests use (no voice, no refresh). */
const tick = async (db, iso) => (await capture(() => runScheduleTick(db, {
  now: () => at(iso), refresh: null, audio: false, speech: { log: () => {} }, notify: async () => {},
}))).result;

/** The real config the walled child must find: one show attached on weekdays. */
const WALLED_CONFIG = {
  tz: TZ, lead_min: 15, max_stories: 8, catch_up_hours: 4, notify: true, active_from: null,
  attach: [{ source_id: 26, days: [1, 2, 3, 4, 5], title_prefix: "Morning Show", wait_hours: 3.5 }],
};

test("walled child with the gateway's id: the real config comes back, attachment and all", async () => {
  instance({ unreadable: true, envId: REAL_ID });
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  await writeSetting(f.db, CONFIG_KEY, JSON.stringify(WALLED_CONFIG), { scope: "local" });
  // It landed under the gateway's id, not one minted here.
  const rows = (await f.db.execute({ sql: "SELECT instance_id FROM dashboard_settings_overrides WHERE key = ?", args: [CONFIG_KEY] })).rows;
  assert.deepEqual(rows.map((r) => r.instance_id), [REAL_ID]);

  assert.equal(await readSetting(f.db, CONFIG_KEY), JSON.stringify(WALLED_CONFIG));
  assert.deepEqual(await readJsonSetting(f.db, CONFIG_KEY), WALLED_CONFIG);
  assert.equal((await readLocalSetting(f.db, CONFIG_KEY)).includes('"source_id":26'), true);
});

test("without the id the read is null and loud (never the value), strict rethrows, and no junk row is written", async () => {
  instance({ unreadable: true });
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  setEnvId(REAL_ID);
  await writeSetting(f.db, CONFIG_KEY, JSON.stringify(WALLED_CONFIG), { scope: "local" });
  setEnvId(undefined);   // the child was started without CROW_LOCAL_INSTANCE_ID

  const { lines } = await capture(async () => {
    assert.equal(await readLocalSetting(f.db, CONFIG_KEY), null);
    assert.equal(await readJsonSetting(f.db, CONFIG_KEY), null);
    await assert.rejects(readLocalSetting(f.db, CONFIG_KEY, { strict: true }), { code: "INSTANCE_ID_UNREADABLE" });
  });
  assert.ok(lines.length > 0, "a failed read is logged");
  for (const line of lines) {
    assert.ok(line.includes(CONFIG_KEY), `the key is named: ${line}`);
    assert.ok(line.includes("instance id cannot be read"), `the reason is named: ${line}`);
    assert.equal(line.includes("source_id"), false, "never the value");
    assert.equal(line.includes("Morning Show"), false, "never the value");
  }
  // The regression's other half: no junk override row under a random id.
  const { rows } = await f.db.execute({ sql: "SELECT instance_id FROM dashboard_settings_overrides WHERE key = ?", args: [CONFIG_KEY] });
  assert.deepEqual(rows.map((r) => r.instance_id), [REAL_ID]);
});

test("readSchedule strict: a failed read throws; a schedule row with no usable config is config_unreadable", async () => {
  const dir = instance();
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  await saveSchedule(f.db, { tz: TZ, time: "08:00" }, { now: at(SAVED) });

  // (1) the store cannot be reached at all
  maskInstanceId(dir);
  setEnvId(undefined);
  await assert.rejects(readSchedule(f.db, { strict: true }), { code: "INSTANCE_ID_UNREADABLE" });

  // (2) the schedule row is there, the stored settings are not
  setEnvId(REAL_ID);   // the walled child's own case: the id comes from the env
  await f.db.execute({ sql: "DELETE FROM dashboard_settings_overrides WHERE key = ?", args: [CONFIG_KEY] });
  await assert.rejects(readSchedule(f.db, { strict: true }), (err) => {
    assert.equal(err.code, "config_unreadable");
    assert.match(err.message, /config could not be read/);
    return true;
  });
  // Non-strict still renders for the tabs and the tools: the row, and an empty attach.
  const loose = await readSchedule(f.db);
  assert.equal(loose.row.cron_expression, "0 8 * * *");
  assert.deepEqual(loose.cfg.attach, []);
});

test("runScheduleTick: an unreadable config claims nothing and the next tick retries; a readable one claims with its show", async () => {
  // --- unreadable: the occurrence is due and the config cannot be read
  {
    const dir = instance();
    const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
    await saveSchedule(f.db, { tz: TZ, time: "08:00" }, { now: at(SAVED) });
    maskInstanceId(dir);          // the wall: present, unreadable
    setEnvId(undefined);
    const r = await tick(f.db, LEAD_TICK);
    assert.deepEqual([r.claimed, r.retried, r.failed], [null, null, null]);
    assert.equal(r.error, "INSTANCE_ID_UNREADABLE");
    assert.deepEqual(await briefings(f.db), [], "no briefing row was created or claimed");
    // Nothing was consumed: with the id readable again the same occurrence is made.
    unmaskInstanceId(dir);
    const retry = await tick(f.db, LEAD_TICK);
    assert.ok(retry.claimed > 0, "the next tick retries");
    assert.equal((await briefings(f.db)).length, 1);
  }

  // --- schedule row present, stored config gone: same outcome, its own code
  {
    instance();
    const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
    await saveSchedule(f.db, { tz: TZ, time: "08:00" }, { now: at(SAVED) });
    await f.db.execute({ sql: "DELETE FROM dashboard_settings_overrides WHERE key = ?", args: [CONFIG_KEY] });
    const r = await tick(f.db, LEAD_TICK);
    assert.deepEqual([r.claimed, r.error], [null, "config_unreadable"]);
    assert.deepEqual(await briefings(f.db), []);
  }

  // --- readable: exactly as before, and the show is planned onto the briefing
  {
    instance();
    const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
    const wire = await seedSource(f.db, { name: "Example Wire", url: "https://wire.example.invalid/feed" });
    await seedArticle(f.db, { source_id: wire, title: "Story one", summary: "Text of story one.", pub_date: "2026-10-06T09:00:00.000Z" });
    const showId = await seedSource(f.db, { name: "The Example Hour", url: "http://127.0.0.1:9/unused.xml", type: "podcast" });
    await saveSchedule(f.db, { tz: TZ, time: "08:00", attach: [{ source_id: showId }] }, { now: at(SAVED) });
    const r = await tick(f.db, LEAD_TICK);
    assert.ok(r.claimed > 0, "the occurrence was claimed");
    assert.equal(r.error, null);
    const [b] = await briefings(f.db);
    assert.equal(b.id, r.claimed);
    assert.equal(b.scheduled_for, OCC);
    const attachments = JSON.parse(b.attachments);
    assert.deepEqual(attachments.map((a) => [a.key, a.source_id, a.status]), [[`show:${showId}`, showId, "pending"]], "planAttachments got the show");
  }
});