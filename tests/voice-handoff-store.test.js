// The hand-off log store (servers/gateway/voice/handoff-store.js): CAS transitions with the TTL inside
// the CAS, the one-open-phone-row-per-device index, and the sweep (expiry, stuck-start recovery, stop
// retries, the `asked` scrub). Every time comes from a fake clock injected as `now`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { VOICE_HANDOFFS_DDL } from "../scripts/migrations/0018-voice-handoffs.mjs";

const { createDbClient } = await import("../servers/db.js");
const { createHandoffStore, findHandoffCard } = await import("../servers/gateway/voice/handoff-store.js");
const C = await import("../servers/gateway/voice/handoff-constants.js");
const { HANDOFF_PROPOSAL_TTL_MS: PENDING_TTL } = await import("../servers/gateway/voice/pending.js");

const dirs = [];
const clients = [];
after(() => {
  for (const c of clients) { try { c.close(); } catch {} }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "vh-store-"));
  dirs.push(dir);
  const path = join(dir, "crow.db");
  const raw = new Database(path);
  raw.exec(VOICE_HANDOFFS_DDL);
  raw.exec(`CREATE TABLE project_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL,
    actor_type TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, target TEXT, payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  raw.close();
  const db = createDbClient(path);
  clients.push(db);
  return db;
}

function clock(start = 1_800_000_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

const base = (over = {}) => ({
  kind: "handoff", surface: "dashboard", device_id: "dev-1", device_name: "Desk", bot_id: "writer",
  task: "draft the newsletter", asked: "could writer draft the newsletter", status: "proposed",
  model_key: null, start_now: 1, lang: "en", ...over,
});

test("the constants are the plan's exact values, and pending.js re-exports the proposal TTL", () => {
  assert.equal(C.HANDOFF_PROPOSAL_TTL_MS, 120_000);
  assert.equal(PENDING_TTL, C.HANDOFF_PROPOSAL_TTL_MS);
  assert.equal(C.HANDOFF_PHONE_TTL_MS, 30 * 60_000);
  assert.equal(C.HANDOFF_SUMMARY_MAX_CHARS, 160);
  assert.equal(C.HANDOFF_MAX_CANDIDATES, 8);
  assert.equal(C.HANDOFF_TASK_MAX_CHARS, 300);
  assert.equal(C.HANDOFF_ASKED_MAX_CHARS, 1000);
  assert.equal(C.HANDOFF_START_BUDGET_MS, 3000);
  assert.equal(C.HANDOFF_STARTING_STUCK_MS, 10 * 60_000);
  assert.equal(C.HANDOFF_STOP_STUCK_MS, 5 * 60_000);
  assert.equal(C.HANDOFF_QUIET_AFTER_MS, 30 * 60_000);
  assert.equal(C.HANDOFF_ASKED_RETAIN_MS, 7 * 24 * 3600_000);
  assert.deepEqual([...C.HANDOFF_KINDS], ["handoff", "stop"]);
  assert.deepEqual([...C.HANDOFF_STATUSES], ["proposed", "awaiting_phone", "starting", "started", "queued",
    "declined", "expired", "failed", "done", "stopped", "quiet"]);
  assert.ok(!C.HANDOFF_STATUSES.includes("partial"));
  assert.deepEqual([...C.HANDOFF_OPEN], ["starting", "started", "queued", "quiet"]);
});

test("insert stamps the id, the clock times and the TTL by status, and stores lang", async () => {
  const db = freshDb();
  const now = clock();
  const s = createHandoffStore({ now });
  const a = await s.insert(db, base());
  assert.match(a, /^vh-[0-9a-f]{16}$/);
  const ra = await s.get(db, a);
  assert.equal(ra.created_at, now());
  assert.equal(ra.updated_at, now());
  assert.equal(ra.expires_at, now() + C.HANDOFF_PROPOSAL_TTL_MS);
  assert.equal(ra.lang, "en");
  assert.equal(ra.start_now, 1);
  const b = await s.insert(db, base({ surface: "kiosk", status: "awaiting_phone", lang: "es", start_now: 0 }));
  const rb = await s.get(db, b);
  assert.equal(rb.expires_at, now() + C.HANDOFF_PHONE_TTL_MS);
  assert.equal(rb.lang, "es");
  assert.equal(rb.start_now, 0);
  const c = await s.insert(db, base({ device_id: "dev-2", status: "starting" }));
  const rc = await s.get(db, c);
  assert.equal(rc.expires_at, null);
  assert.equal(rc.decided_at, now());
});

test("an unknown status throws", async () => {
  const db = freshDb();
  const s = createHandoffStore({ now: clock() });
  await assert.rejects(s.insert(db, base({ status: "partial" })), /unknown status/);
  await assert.rejects(s.insert(db, base({ kind: "other" })), /unknown kind/);
  await assert.rejects(s.insert(db, base({ lang: "fr" })), /unknown lang/);
  const id = await s.insert(db, base());
  await assert.rejects(s.transition(db, id, ["proposed"], "partial"), /unknown status/);
  await assert.rejects(s.transition(db, id, ["bogus"], "declined"), /unknown status/);
  await assert.rejects(s.transition(db, id, ["proposed"], "declined", { status: "done" }), /cannot write/);
  assert.equal((await s.get(db, id)).status, "proposed");
});

test("asked and task are capped", async () => {
  const db = freshDb();
  const s = createHandoffStore({ now: clock() });
  const id = await s.insert(db, base({ task: "t".repeat(500), asked: "a".repeat(2000) }));
  const r = await s.get(db, id);
  assert.equal(r.task.length, C.HANDOFF_TASK_MAX_CHARS);
  assert.equal(r.asked.length, C.HANDOFF_ASKED_MAX_CHARS);
});

test("transition is compare-and-set", async () => {
  const db = freshDb();
  const now = clock();
  const s = createHandoffStore({ now });
  const id = await s.insert(db, base());
  const results = await Promise.all([
    s.transition(db, id, ["proposed"], "starting", {}, { live: true }),
    s.transition(db, id, ["proposed"], "declined", {}, { live: true }),
  ]);
  assert.deepEqual(results.filter(Boolean).length, 1);
  const r = await s.get(db, id);
  assert.equal(r.status, results[0] ? "starting" : "declined");
  assert.equal(r.decided_at, now());
  now.advance(5);
  assert.equal(await s.transition(db, id, [r.status], "done", { detail: "x" }), true);
  const done = await s.get(db, id);
  assert.equal(done.ended_at, now());
  assert.equal(done.updated_at, now());
  assert.equal(done.detail, "x");
});

test("a live transition refuses an expired row", async () => {
  const db = freshDb();
  const now = clock();
  const s = createHandoffStore({ now });
  const id = await s.insert(db, base({ surface: "kiosk", status: "awaiting_phone" }));
  now.advance(C.HANDOFF_PHONE_TTL_MS + 1);
  assert.equal(await s.transition(db, id, ["awaiting_phone"], "starting", {}, { live: true }), false);
  assert.equal((await s.get(db, id)).status, "awaiting_phone");
  // Exactly at expires_at is already too late.
  const id2 = await s.insert(db, base({ device_id: "dev-2" }));
  now.advance(C.HANDOFF_PROPOSAL_TTL_MS);
  assert.equal(await s.transition(db, id2, ["proposed"], "starting", {}, { live: true }), false);
  // A non-live transition still moves it (the sweep's expiry path).
  assert.equal(await s.transition(db, id2, ["proposed"], "expired"), true);
});

test("a second awaiting_phone row for the same device and kind is refused by the index", async () => {
  const db = freshDb();
  const now = clock();
  const s = createHandoffStore({ now });
  const first = await s.insert(db, base({ surface: "kiosk", status: "awaiting_phone" }));
  await assert.rejects(s.insert(db, base({ surface: "kiosk", status: "awaiting_phone" })), (err) => err.code === "phone_open");
  // A different kind, or a different device, is not blocked.
  await s.insert(db, base({ surface: "kiosk", status: "awaiting_phone", kind: "stop", target_id: first }));
  await s.insert(db, base({ surface: "kiosk", status: "awaiting_phone", device_id: "dev-2" }));
  assert.equal((await s.openPhone(db, "dev-1", "handoff")).id, first);
  // Once the open row expires, openPhone moves it out and a new one may be inserted.
  now.advance(C.HANDOFF_PHONE_TTL_MS);
  assert.equal(await s.openPhone(db, "dev-1", "handoff"), null);
  assert.equal((await s.get(db, first)).status, "expired");
  const next = await s.insert(db, base({ surface: "kiosk", status: "awaiting_phone" }));
  assert.equal((await s.openPhone(db, "dev-1", "handoff")).id, next);
});

test("the open lists count exactly starting, started, queued and quiet", async () => {
  const db = freshDb();
  const now = clock();
  const s = createHandoffStore({ now });
  const ids = {};
  for (const st of C.HANDOFF_STATUSES) {
    if (st === "awaiting_phone") continue;
    now.advance(1);
    ids[st] = await s.insert(db, base({ status: st, task: st }));
  }
  now.advance(1);
  const kioskOpen = await s.insert(db, base({ surface: "kiosk", device_id: "kiosk-1", status: "started", task: "k" }));
  const dev = (await s.openForDevice(db, "dev-1")).map((r) => r.status).sort();
  assert.deepEqual(dev, ["queued", "quiet", "started", "starting"]);
  const personal = await s.openPersonal(db);
  assert.equal(personal.length, 4);
  assert.ok(!personal.some((r) => r.id === kioskOpen));
  assert.deepEqual((await s.openForDevice(db, "kiosk-1")).map((r) => r.id), [kioskOpen]);
  const recent = await s.recent(db, 3);
  assert.equal(recent.length, 3);
  assert.equal(recent[0].id, kioskOpen, "newest first");
});

test("byCard returns the newest row for a card, and setFields writes on any status", async () => {
  const db = freshDb();
  const now = clock();
  const s = createHandoffStore({ now });
  const a = await s.insert(db, base({ status: "starting" }));
  await s.setFields(db, a, { card_id: 42 });
  now.advance(10);
  const b = await s.insert(db, base({ status: "stopped" }));
  assert.equal(await s.setFields(db, b, { card_id: 42, session_id: "ses-1", thread_id: "thr-1", detail: "stop_pending" }), true);
  const rb = await s.get(db, b);
  assert.equal(rb.status, "stopped");
  assert.equal(rb.session_id, "ses-1");
  assert.equal(rb.thread_id, "thr-1");
  assert.equal((await s.byCard(db, 42)).id, b);
  await assert.rejects(s.setFields(db, b, { status: "started" }), /cannot write/);
});

test("the sweep expires stale rows and skips in-flight starting rows", async () => {
  const db = freshDb();
  const now = clock();
  const s = createHandoffStore({ now });
  const proposed = await s.insert(db, base());
  const phone = await s.insert(db, base({ surface: "kiosk", device_id: "kiosk-1", status: "awaiting_phone" }));
  const fresh = await s.insert(db, base({ device_id: "dev-3" }));
  const busy = await s.insert(db, base({ device_id: "dev-4" }));
  assert.equal(await s.transition(db, busy, ["proposed"], "starting", {}, { live: true }), true);
  now.advance(C.HANDOFF_PROPOSAL_TTL_MS);
  const later = await s.insert(db, base({ device_id: "dev-5" }));
  now.advance(C.HANDOFF_PHONE_TTL_MS + C.HANDOFF_STARTING_STUCK_MS);
  // Every row above is now past its expires_at; only a proposal made now is still live.
  const live = await s.insert(db, base({ device_id: "dev-6" }));
  let asked = 0;
  const r = await s.sweep(db, { inFlight: new Set([busy]), findCard: async () => { asked++; return 7; } });
  assert.equal(r.expired, 4);
  for (const id of [proposed, phone, fresh, later]) assert.equal((await s.get(db, id)).status, "expired");
  assert.equal((await s.get(db, live)).status, "proposed");
  assert.equal((await s.get(db, busy)).status, "starting", "an in-flight confirm is left alone");
  assert.equal(asked, 0, "findCard is never asked about an in-flight row");
  assert.equal(r.requeued + r.failed, 0);
});

test("a starting row confirmed late in its phone window is not stuck", async () => {
  const db = freshDb();
  const now = clock();
  const s = createHandoffStore({ now });
  const id = await s.insert(db, base({ surface: "kiosk", status: "awaiting_phone" }));
  now.advance(25 * 60_000);
  assert.equal(await s.transition(db, id, ["awaiting_phone"], "starting", {}, { live: true }), true);
  const r = await s.sweep(db, { findCard: async () => null });
  assert.equal(r.failed, 0);
  assert.equal((await s.get(db, id)).status, "starting");
  now.advance(C.HANDOFF_STARTING_STUCK_MS - 1);
  await s.sweep(db, { findCard: async () => null });
  assert.equal((await s.get(db, id)).status, "starting", "still inside the stuck window from decided_at");
  now.advance(1);
  assert.equal((await s.sweep(db, { findCard: async () => null })).failed, 1);
});

test("the sweep requeues a stuck starting row whose card exists, else fails it interrupted", async () => {
  const db = freshDb();
  const now = clock();
  const s = createHandoffStore({ now });
  const withCard = await s.insert(db, base({ status: "starting" }));
  const noCard = await s.insert(db, base({ device_id: "dev-2", status: "starting" }));
  const ownCard = await s.insert(db, base({ device_id: "dev-3", status: "starting" }));
  await s.setFields(db, ownCard, { card_id: 11 });
  // The card_given audit row a voice give writes (give-service giveAudit), plus noise.
  await db.execute({ sql: "INSERT INTO project_audit_log (project_id, actor_type, action, target, payload) VALUES (1,'local','card_given','card:99',?)",
    args: [JSON.stringify({ bot_id: "writer", via: "voice", handoff_id: withCard, created: true })] });
  await db.execute({ sql: "INSERT INTO project_audit_log (project_id, actor_type, action, target, payload) VALUES (1,'local','card_given','card:5','not json')", args: [] });
  await db.execute({ sql: "INSERT INTO project_audit_log (project_id, actor_type, action, target, payload) VALUES (1,'local','card_moved','card:6',?)",
    args: [JSON.stringify({ handoff_id: noCard })] });
  assert.equal(await findHandoffCard(db, withCard), 99);
  assert.equal(await findHandoffCard(db, noCard), null, "only card_given rows count");
  now.advance(C.HANDOFF_STARTING_STUCK_MS);
  const asked = [];
  const r = await s.sweep(db, { findCard: async (d, id) => { asked.push(id); return findHandoffCard(d, id); } });
  assert.equal(r.requeued, 2);
  assert.equal(r.failed, 1);
  const a = await s.get(db, withCard);
  assert.equal(a.status, "queued");
  assert.equal(a.card_id, 99);
  assert.equal(a.detail, "recovered");
  const c = await s.get(db, ownCard);
  assert.equal(c.status, "queued");
  assert.equal(c.card_id, 11);
  assert.ok(!asked.includes(ownCard), "a row that already has its card_id needs no lookup");
  const b = await s.get(db, noCard);
  assert.equal(b.status, "failed");
  assert.equal(b.detail, "interrupted");
  assert.equal(b.ended_at, now());
});

test("stop rows left starting fail after 5 minutes, and only hand-off rows are recovered to a card", async () => {
  const db = freshDb();
  const now = clock();
  const s = createHandoffStore({ now });
  const stop = await s.insert(db, base({ kind: "stop", status: "starting", target_id: "vh-target" }));
  now.advance(C.HANDOFF_STOP_STUCK_MS - 1);
  assert.equal((await s.sweep(db, { findCard: async () => 3 })).failed, 0);
  now.advance(1);
  let asked = 0;
  const r = await s.sweep(db, { findCard: async () => { asked++; return 3; } });
  assert.equal(r.failed, 1);
  assert.equal(r.requeued, 0);
  assert.equal(asked, 0, "a stop row never looks for a card");
  const row = await s.get(db, stop);
  assert.equal(row.status, "failed");
  assert.equal(row.detail, "interrupted");
});

test("the sweep retries a pending engine stop and clears the detail on success", async () => {
  const db = freshDb();
  const now = clock();
  const s = createHandoffStore({ now });
  const ok = await s.insert(db, base({ status: "stopped" }));
  const gone = await s.insert(db, base({ device_id: "dev-2", status: "stopped" }));
  const bad = await s.insert(db, base({ device_id: "dev-3", status: "stopped" }));
  const noSession = await s.insert(db, base({ device_id: "dev-4", status: "stopped" }));
  await s.setFields(db, ok, { session_id: "ses-ok", detail: "stop_pending" });
  await s.setFields(db, gone, { session_id: "ses-gone", detail: "stop_pending" });
  await s.setFields(db, bad, { session_id: "ses-bad", detail: "stop_pending" });
  await s.setFields(db, noSession, { detail: "stop_pending" });
  const calls = [];
  const retryStop = async (sid) => {
    calls.push(sid);
    if (sid === "ses-gone") throw Object.assign(new Error("gone"), { code: "no_such_session" });
    if (sid === "ses-bad") throw new Error("engine busy");
  };
  const origError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  let r;
  try { r = await s.sweep(db, { retryStop }); } finally { console.error = origError; }
  assert.deepEqual(calls.sort(), ["ses-bad", "ses-gone", "ses-ok"]);
  assert.equal(r.retried, 2);
  assert.equal((await s.get(db, ok)).detail, null);
  assert.equal((await s.get(db, gone)).detail, null, "a session already gone counts as stopped");
  assert.equal((await s.get(db, bad)).detail, "stop_pending", "a failed retry stays pending for the next sweep");
  assert.equal((await s.get(db, noSession)).detail, "stop_pending");
  assert.ok(logged.some((l) => l.includes("engine busy")));
  for (const id of [ok, gone, bad]) assert.equal((await s.get(db, id)).status, "stopped");
});

test("the sweep scrubs asked on old declined and expired rows and keeps the task", async () => {
  const db = freshDb();
  const now = clock();
  const s = createHandoffStore({ now });
  const declined = await s.insert(db, base());
  await s.transition(db, declined, ["proposed"], "declined");
  const expired = await s.insert(db, base({ device_id: "dev-2" }));
  const done = await s.insert(db, base({ device_id: "dev-3", status: "done" }));
  now.advance(C.HANDOFF_ASKED_RETAIN_MS - 1);
  const young = await s.insert(db, base({ device_id: "dev-4", status: "declined" }));
  let r = await s.sweep(db);
  assert.equal(r.expired, 1);
  assert.equal(r.scrubbed, 0, "not yet seven days");
  now.advance(1);
  r = await s.sweep(db);
  assert.equal(r.scrubbed, 2);
  for (const id of [declined, expired]) {
    const row = await s.get(db, id);
    assert.equal(row.asked, null);
    assert.equal(row.task, "draft the newsletter");
  }
  assert.equal((await s.get(db, done)).asked, "could writer draft the newsletter", "only declined and expired rows are scrubbed");
  assert.equal((await s.get(db, young)).asked, "could writer draft the newsletter");
  assert.equal((await s.sweep(db)).scrubbed, 0, "a second pass finds nothing");
});
