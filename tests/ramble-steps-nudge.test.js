/**
 * Spec 2026-10-04 §9: one gentle evening nudge, at most once a day, only to a
 * player who walks with Ramble, only from their "steps home" instance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { applyRambleWallet } from "../servers/sharing/instance-sync.js";
import { localDay, startOfLocalDay } from "../bundles/ramble/server/eggs.js";
import * as steps from "../bundles/ramble/server/steps.js";
import { startRambleNudge, NUDGE_TICK_MS } from "../servers/gateway/boot/ramble-nudge.js";

const { nudgeDecision, markNudged, nudgeText, NUDGE_TEXT, touchHome, recordWalkCheckin, HOME_WINDOW_MS } = steps;
const H = 3_600_000;
// A local Wednesday and the Saturday after it, whatever the test machine's timezone.
function localDayOf(weekday) {
  let t = startOfLocalDay(Date.UTC(2026, 9, 7, 12));
  while (new Date(t).getDay() !== weekday) t = startOfLocalDay(t + 26 * H);
  return t;
}
const WED = localDayOf(3);
const SAT = localDayOf(6);
const at = (day, h, m = 0) => day + h * H + m * 60_000;

async function engagedDb(day = WED) {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  // Walked yesterday (engaged), opened the pet page this morning (home), nothing yet today.
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('steps', ?, 4000, ?)",
    args: [`${localDay(day - 12 * H)}:aaaaaaaa-0000-0000-0000-000000000001`, day - 12 * H],
  });
  await touchHome(db, { now: at(day, 8) });
  return db;
}
const set = (db, key, value) => db.execute({ sql: "INSERT INTO ramble_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [key, String(value)] });

test("due at 18:00 on a weekday for an engaged player at home who has not walked", async () => {
  const db = await engagedDb();
  assert.deepEqual(await nudgeDecision(db, { now: at(WED, 18, 5) }), { send: true, reason: "due", day: localDay(at(WED, 18)), variant: "low" });
});

test("a counter player whose last reading is hours old gets the 'show me' nudge, never 'you haven't walked'", async () => {
  const db = await engagedDb();
  await db.execute({
    sql: "INSERT INTO ramble_step_devices (device_id, boot_count, last_counter, last_read_at, created_at) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 1, 100, ?, ?)",
    args: [at(WED, 12), at(WED, 12)],
  });
  assert.equal((await nudgeDecision(db, { now: at(WED, 18, 5) })).variant, "unseen", "6 h since the last reading");
  await db.execute({ sql: "UPDATE ramble_step_devices SET last_read_at = ?", args: [at(WED, 17)] });
  assert.equal((await nudgeDecision(db, { now: at(WED, 18, 5) })).variant, "low", "a fresh reading: the count is real");
});

test("each condition blocks on its own", async () => {
  let db = await engagedDb();
  assert.equal((await nudgeDecision(db, { now: at(WED, 17, 59) })).reason, "hour");
  assert.equal((await nudgeDecision(db, { now: at(WED, 21, 0) })).reason, "hour", "a gateway booting late stays quiet");
  await set(db, "steps.nudge", "0");
  assert.equal((await nudgeDecision(db, { now: at(WED, 18, 5) })).reason, "off");

  db = await engagedDb(SAT);
  assert.equal((await nudgeDecision(db, { now: at(SAT, 18, 5) })).send, true, "weekends on by default");
  await set(db, "steps.nudge.weekends", "0");
  assert.equal((await nudgeDecision(db, { now: at(SAT, 18, 5) })).reason, "weekend");

  db = await engagedDb();
  await set(db, steps.HOME_KEY, String(at(WED, 18) - HOME_WINDOW_MS - 1));
  assert.equal((await nudgeDecision(db, { now: at(WED, 18, 5) })).reason, "not-home");

  db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  await touchHome(db, { now: at(WED, 8) });
  assert.equal((await nudgeDecision(db, { now: at(WED, 18, 5) })).reason, "not-engaged");

  db = await engagedDb();
  await recordWalkCheckin(db, { now: at(WED, 12) });
  assert.equal((await nudgeDecision(db, { now: at(WED, 18, 5) })).reason, "walked");

  db = await engagedDb();
  await db.execute({ sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('steps', ?, 3000, ?)", args: [`${localDay(at(WED, 12))}:aaaaaaaa-0000-0000-0000-000000000001`, at(WED, 12)] });
  assert.equal((await nudgeDecision(db, { now: at(WED, 18, 5) })).reason, "on-track", "half the goal is on track");
});

test("markNudged is at-most-once, and a nudge row arriving by sync silences this instance", async () => {
  const A = await engagedDb(), B = await engagedDb();
  const ops = [];
  const day = localDay(at(WED, 18));
  assert.equal(await markNudged(A, day, { now: at(WED, 18, 1), emit: async (t, o, r) => ops.push({ t, o, r }) }), true);
  assert.equal(await markNudged(A, day, { now: at(WED, 18, 2) }), false);
  assert.equal((await nudgeDecision(A, { now: at(WED, 18, 15) })).reason, "already");
  for (const { o, r } of ops) await applyRambleWallet(B, o, r, 5000);
  assert.equal((await nudgeDecision(B, { now: at(WED, 18, 15) })).reason, "already");
});

test("nudgeText: en and es, both variants, no numbers, unknowns fall back", () => {
  assert.deepEqual(Object.keys(NUDGE_TEXT).sort(), ["en", "es"]);
  for (const lang of ["en", "es"]) {
    for (const variant of ["low", "unseen"]) {
      const t = nudgeText(lang, variant);
      assert.ok(t.title.length > 0 && t.body.length > 0);
      assert.ok(!/\d/.test(t.title + t.body), "lock screens are public: no counts");
    }
    assert.notEqual(nudgeText(lang, "unseen").body, nudgeText(lang, "low").body);
  }
  assert.notEqual(nudgeText("es").title, nudgeText("en").title);
  assert.deepEqual(nudgeText("fr"), nudgeText("en", "low"));
  assert.deepEqual(nudgeText("__proto__"), nudgeText("en"));
  assert.deepEqual(nudgeText("en", "constructor"), nudgeText("en", "low"));
});

test("startRambleNudge: sends once across repeated ticks, in the dashboard language, as a reminder", async () => {
  const db = await engagedDb();
  const sent = [];
  let now = at(WED, 18, 5);
  const n = startRambleNudge({
    db, serverDir: "unused", autoStart: false, clock: () => now,
    load: async () => steps,
    notify: async (d, opts) => { sent.push(opts); return { id: 1 }; },
    readLang: async () => "es",
  });
  assert.deepEqual(await n.tick(), { sent: true, reason: "due" });
  now += 10 * 60_000;
  assert.deepEqual(await n.tick(), { sent: false, reason: "already" });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    title: nudgeText("es").title, body: nudgeText("es").body, type: "reminder", source: "ramble:steps",
    priority: "normal", action_url: "/dashboard/ramble", expires_in_minutes: 360,
  });
  n.stop();
});

test("startRambleNudge: never throws out of a tick — a missing bundle module, a failing notify, a busy tick", async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const missing = startRambleNudge({ db: null, serverDir: "/nope", autoStart: false, load: async () => { throw new Error("no module"); }, notify: async () => {} });
    assert.deepEqual(await missing.tick(), { sent: false, reason: "no-module" });
    assert.deepEqual(await missing.tick(), { sent: false, reason: "no-module" }, "and keeps saying so quietly");
    const db = await engagedDb();
    const failing = startRambleNudge({ db, serverDir: "x", autoStart: false, clock: () => at(WED, 18, 5), load: async () => steps, notify: async () => { throw new Error("push down"); } });
    assert.deepEqual(await failing.tick(), { sent: false, reason: "error" });
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = startRambleNudge({ db: await engagedDb(), serverDir: "x", autoStart: false, clock: () => at(WED, 18, 5), load: async () => { await gate; return steps; }, notify: async () => {} });
    const first = slow.tick();
    assert.deepEqual(await slow.tick(), { sent: false, reason: "busy" });
    release();
    assert.deepEqual(await first, { sent: true, reason: "due" });
  } finally { console.warn = warn; }
  assert.equal(NUDGE_TICK_MS, 600_000);
});

test("multi-instance: a nudge row marked on A and synced to B makes B decline, and the row dedupes on merge", async () => {
  const A = await engagedDb(), B = await engagedDb();
  const ops = [];
  const day = localDay(at(WED, 18));
  assert.equal((await nudgeDecision(B, { now: at(WED, 18, 5) })).send, true, "B would nudge on its own");
  assert.equal(await markNudged(A, day, { now: at(WED, 18, 1), emit: async (t, o, r) => ops.push({ t, o, r: { ...r } }) }), true);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].t, "ramble_wallet");
  await applyRambleWallet(B, ops[0].o, ops[0].r, 6000);
  assert.deepEqual(await nudgeDecision(B, { now: at(WED, 18, 5) }), { send: false, reason: "already" });
  // Applying the same row again (a replay, or B's own claim racing) leaves one row.
  await applyRambleWallet(B, ops[0].o, ops[0].r, 6001);
  const { rows } = await B.execute({ sql: "SELECT COUNT(*) AS n, MAX(delta) AS d FROM ramble_wallet WHERE kind = 'nudge' AND key = ?", args: [day] });
  assert.equal(Number(rows[0].n), 1);
  assert.equal(Number(rows[0].d), 1);
  assert.equal(await markNudged(B, day, { now: at(WED, 18, 6) }), false, "B cannot claim a day A already nudged");
});
