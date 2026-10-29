// Satellite status poller (SAT-5, spec §8, §9.1, §11.1, §14): every 60 s (injectable), a signed
// GET status + the unsigned /health time; last_status_json / last_seen_at updated; 10 min with
// no answer → status unreachable + ONE notification; PSI > 10 % → one notification per episode;
// a tool hash ≠ the pin → tools disabled + one notification with a +/−/~ diff (same version
// flagged suspicious); a status entry with no sha256 is "tools unavailable", never a mismatch.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME = mkdtempSync(join(tmpdir(), "satpoll-home-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "satpoll-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
const dirs = [HOME, process.env.CROW_DATA_DIR];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const { createDbClient } = await import("../servers/db.js");
const { SATELLITE_DDL } = await import("../servers/shared/satellite-schema.js");
const store = await import("../servers/gateway/satellites/store.js");
const { createSatellitePoller, UNREACHABLE_AFTER_MS, PSI_ALERT_PCT, POLL_INTERVAL_MS } = await import("../servers/gateway/satellites/poller.js");
const T = await import("../servers/gateway/satellites/tools-pin.js");
const { createMgmtFake, makeSatelliteRow, demoTools, toolsHash } = await import("./helpers/fake-satellite-mgmt.js");

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "satpoll-db-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(SATELLITE_DDL);
  return db;
}

function setup(db, fake, clock) {
  const notes = [];
  const poller = createSatellitePoller({
    dbFactory: () => db, closeDb: false, fetchImpl: fake.fetchImpl, now: () => clock.t,
    notify: async (_db, n) => { notes.push(n); return 1; },
  });
  return { poller, notes };
}

test("constants are the spec's", () => {
  assert.equal(POLL_INTERVAL_MS, 60000);
  assert.equal(UNREACHABLE_AFTER_MS, 10 * 60000);
  assert.equal(PSI_ALERT_PCT, 10);
});

test("tools-pin: hash, diff (+ − ~), caps and prefix", () => {
  const a = demoTools();
  const b = [{ ...a[0], description: "changed" }, { name: "demo_new", description: "n", inputSchema: { type: "object" } }];
  assert.equal(T.toolsSha(a), toolsHash(a));
  assert.deepEqual(T.diffTools(a, b), { added: ["demo_new"], removed: ["demo_create"], changed: ["demo_list"] });
  assert.equal(T.formatDiff(T.diffTools(a, b)), "+ demo_new, − demo_create, ~ demo_list");
  assert.deepEqual(T.checkToolList("demo", a).problems, []);
  const bad = T.checkToolList("my-app", [{ name: "other_x" }, { name: "my_app_ok", description: "x".repeat(301) }]);
  assert.deepEqual(bad.allowed, []);
  assert.equal(bad.problems.length, 2);
  assert.equal(T.checkToolList("demo", Array.from({ length: 65 }, (_, i) => ({ name: `demo_t${i}` }))).tooMany, true);
});

test("a good poll stores the status, skew, last_seen_at; tools state ok against the pin", async () => {
  const db = await freshDb();
  const clock = { t: Date.parse("2026-11-01T10:00:00Z") };
  const fake = createMgmtFake({ clock: () => clock.t });
  await makeSatelliteRow(db, fake, { now: clock.t });
  await store.putToolPin(db, { satellite_id: fake.satId, bundle: "demo", version: "1.0.0", tools_sha256: toolsHash(demoTools()), tools_json: JSON.stringify(demoTools()), approved_at: "x" });
  fake.state.healthTime = clock.t + 90000; // the satellite's clock runs 90 s ahead
  const { poller, notes } = setup(db, fake, clock);
  clock.t += 5000;
  await poller.tick();
  const sat = await store.getSatellite(db, fake.satId);
  const rec = JSON.parse(sat.last_status_json);
  assert.equal(rec.status.satellite_id, fake.satId);
  assert.ok(Math.abs(rec.skew_ms - 85000) < 50, `skew ${rec.skew_ms}`);
  assert.equal(sat.last_seen_at, new Date(clock.t).toISOString());
  assert.equal(sat.status, "active");
  const pin = await store.getToolPin(db, fake.satId, "demo");
  assert.equal(T.toolsState(sat, "demo", pin).state, "ok");
  assert.equal(notes.length, 0);
  // Every request this poll sent was signed as the owner on crow.
  for (const r of fake.state.requests.filter((x) => x.path.startsWith("/satellite/"))) assert.equal(r.headers["X-Crow-Sat-Caller"], "owner-local");
});

test("unreachable: nothing for 10 min, then status unreachable and ONE notification; back → active", async () => {
  const db = await freshDb();
  const clock = { t: Date.parse("2026-11-01T10:00:00Z") };
  const fake = createMgmtFake({ clock: () => clock.t });
  await makeSatelliteRow(db, fake, { now: clock.t });
  const { poller, notes } = setup(db, fake, clock);
  fake.state.unreachable = true;
  for (let i = 0; i < 10; i++) { clock.t += 60000; await poller.tick(); }
  let sat = await store.getSatellite(db, fake.satId);
  assert.equal(sat.status, "active", "9 min of silence is not yet unreachable");
  assert.ok(sat.unreachable_since);
  assert.equal(notes.length, 0);
  clock.t += 60000; await poller.tick();
  clock.t += 60000; await poller.tick();
  clock.t += 60000; await poller.tick();
  sat = await store.getSatellite(db, fake.satId);
  assert.equal(sat.status, "unreachable");
  assert.equal(notes.length, 1, "one notification, not one per poll");
  assert.match(notes[0].title, /unreachable/);
  assert.equal(T.toolsState(sat, "demo", { tools_sha256: "x" }).state, "unreachable");
  fake.state.unreachable = false;
  clock.t += 60000; await poller.tick();
  sat = await store.getSatellite(db, fake.satId);
  assert.equal(sat.status, "active");
  assert.equal(sat.unreachable_since, null);
});

test("PSI over 10 %: one notification per episode", async () => {
  const db = await freshDb();
  const clock = { t: Date.parse("2026-11-01T10:00:00Z") };
  const fake = createMgmtFake({ clock: () => clock.t });
  await makeSatelliteRow(db, fake, { now: clock.t });
  const { poller, notes } = setup(db, fake, clock);
  fake.state.psi = 12.5;
  await poller.tick(); await poller.tick();
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /memory/i);
  fake.state.psi = 2; await poller.tick();
  fake.state.psi = 30; await poller.tick();
  assert.equal(notes.length, 2, "a new episode notifies again");
});

test("tool hash ≠ pin: tools disabled, one notification with the diff; same version is suspicious; approval-shaped pin re-enables", async () => {
  const db = await freshDb();
  const clock = { t: Date.parse("2026-11-01T10:00:00Z") };
  const fake = createMgmtFake({ clock: () => clock.t });
  await makeSatelliteRow(db, fake, { now: clock.t });
  const old = demoTools();
  await store.putToolPin(db, { satellite_id: fake.satId, bundle: "demo", version: "1.0.0", tools_sha256: toolsHash(old), tools_json: JSON.stringify(old), approved_at: "x" });
  const changed = [{ ...old[0], description: "Now deletes things" }, { name: "demo_wipe", description: "wipe", inputSchema: { type: "object" } }];
  fake.state.tools.demo = changed; // same version 1.0.0
  const { poller, notes } = setup(db, fake, clock);
  await poller.tick(); await poller.tick();
  const sat = await store.getSatellite(db, fake.satId);
  const pin = await store.getToolPin(db, fake.satId, "demo");
  assert.equal(T.toolsState(sat, "demo", pin).state, "changed");
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /tools changed/);
  assert.match(notes[0].body, /\+ demo_wipe/);
  assert.match(notes[0].body, /− demo_create/);
  assert.match(notes[0].body, /~ demo_list/);
  assert.match(notes[0].body, /suspicious/i);
  await store.putToolPin(db, { ...pin, tools_sha256: toolsHash(changed), tools_json: JSON.stringify(changed) });
  assert.equal(T.toolsState(sat, "demo", await store.getToolPin(db, fake.satId, "demo")).state, "ok");
});

test("status tools entry with no sha256 (tools_too_large) is 'unavailable', not a pin mismatch", async () => {
  const db = await freshDb();
  const clock = { t: Date.parse("2026-11-01T10:00:00Z") };
  const fake = createMgmtFake({ clock: () => clock.t });
  await makeSatelliteRow(db, fake, { now: clock.t });
  await store.putToolPin(db, { satellite_id: fake.satId, bundle: "demo", version: "1.0.0", tools_sha256: toolsHash(demoTools()), tools_json: "[]", approved_at: "x" });
  fake.state.tools.demo = null;
  const { poller, notes } = setup(db, fake, clock);
  await poller.tick();
  const sat = await store.getSatellite(db, fake.satId);
  const st = T.toolsState(sat, "demo", await store.getToolPin(db, fake.satId, "demo"));
  assert.equal(st.state, "unavailable");
  assert.equal(st.error, "tools_too_large");
  assert.equal(notes.length, 0);
});

test("revoked satellites are not polled; no satellites → no network; start() is idempotent and stop() clears", async () => {
  const db = await freshDb();
  const clock = { t: Date.now() };
  const fake = createMgmtFake({ clock: () => clock.t });
  const timers = [];
  const poller = createSatellitePoller({
    dbFactory: () => db, closeDb: false, fetchImpl: fake.fetchImpl, now: () => clock.t, notify: async () => 1,
    setIntervalImpl: (fn, ms) => { const h = { fn, ms, unref() { return h; } }; timers.push(h); return h; },
    clearIntervalImpl: (h) => { h.cleared = true; },
  });
  await poller.tick();
  assert.equal(fake.state.requests.length, 0);
  await makeSatelliteRow(db, fake, { status: "revoked" });
  await poller.tick();
  assert.equal(fake.state.requests.length, 0);
  poller.start(); poller.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 60000);
  poller.stop();
  assert.equal(timers[0].cleared, true);
});

test("runtime: CROW_SATELLITE_TIMERS=0 starts nothing; otherwise one start, idempotent", async () => {
  const R = await import("../servers/gateway/satellites/runtime.js");
  R._resetSatelliteRuntimeForTest();
  assert.equal(R.startSatelliteTimers({ env: { CROW_SATELLITE_TIMERS: "0" }, log: () => {} }), false);
  assert.equal(R.getSatelliteRuntime().started, false);
  assert.equal(R.startSatelliteTimers({ env: {}, log: () => {} }), true);
  assert.equal(R.startSatelliteTimers({ env: {}, log: () => {} }), true);
  assert.equal(R.getSatelliteRuntime().started, true);
  R._resetSatelliteRuntimeForTest();
});
