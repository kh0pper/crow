import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { initPhoneTables } from "../bundles/phone/server/init-tables.js";
import * as store from "../bundles/phone/server/store.js";
import { validatePlan } from "../bundles/phone/server/plan.js";
import { createDispatcher } from "../bundles/phone/server/dispatcher.js";
// I4 (spec 2026-10-01): every approval names the plan_hash the owner was shown.
async function approveFresh(d, id, o = {}) {
  return store.approveCall(d, id, { expectedHash: (await store.getCall(d, id)).plan_hash, ...o });
}


async function setup({ runner, settings } = {}) {
  const db = createDbClient(join(mkdtempSync(join(tmpdir(), "phone-disp-")), "crow.db"));
  await initPhoneTables(db);
  const plan = validatePlan({ business_name: "Smile", number: "512-555-0101", goal: "Book", language: "en" });
  const { call_id } = await store.createPlan(db, plan, { kind: "bot", id: "bobby" }, null);
  const { token } = await approveFresh(db, call_id, { session: "s", allowCloud: false });
  const delivered = [];
  const d = createDispatcher({ db, runner, deps: { notify: async () => {}, deliver: async (_db, c) => { delivered.push(c.id); return { via: "notify_only" }; } },
    settings: settings || (() => ({ ownerName: "Kevin", ownerNumber: "+15129372366", dailyCap: 10, line: "fake", model: () => ({ base_url: "http://m", api_key: "k", model: "x", label: "local" }) })) });
  return { db, call_id, token, d, delivered };
}

test("claims, starts the runner with a fresh single-use token, pulls events, finalizes once", async () => {
  const started = []; let pulls = 0;
  const runner = {
    start: async (call, token) => { started.push({ id: call.id, token }); return { ok: true }; },
    events: async (_id, since) => { pulls++; return since < 2
      ? { events: [{ seq: 1, type: "farend", data: { text: "Hi" } }, { seq: 2, type: "result", data: { outcome: "info_gathered", booking: null, summary: "ok" } }], done: true }
      : { events: [], done: true }; },
    stop: async () => {},
  };
  const { db, call_id, d, delivered } = await setup({ runner });
  await d.tick(); // claim + start
  assert.equal(started.length, 1);
  assert.ok(started[0].token && started[0].token.length >= 32);
  await d.tick(); // pull → finalize → deliver
  await d.tick(); // idempotent
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "done"); assert.equal(c.outcome, "info_gathered");
  assert.deepEqual(delivered, [call_id]);
});

test("number policy re-checked at dispatch (suppressed after approval → failed, never started)", async () => {
  const runner = { start: async () => { throw new Error("must not start"); }, events: async () => ({ events: [], done: false }), stop: async () => {} };
  const { db, call_id, d } = await setup({ runner });
  await store.addSuppression(db, "+15125550101", "asked");
  await d.tick();
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "done"); assert.equal(c.outcome, "failed"); assert.match(c.error, /suppressed/);
});

test("no admissible model → not_admissible, runner never started", async () => {
  const runner = { start: async () => { throw new Error("must not start"); }, events: async () => ({ events: [], done: false }), stop: async () => {} };
  const { db, call_id, d } = await setup({ runner, settings: () => ({ ownerName: "K", ownerNumber: null, dailyCap: 10, line: "fake", model: () => null }) });
  await d.tick();
  assert.equal((await store.getCall(db, call_id)).outcome, "not_admissible");
});

test("gateway restart mid-call: a new dispatcher resumes from event_seq without duplicates", async () => {
  let n = 0;
  const runner = { start: async () => ({ ok: true }), stop: async () => {},
    events: async (_id, since) => { n++; const all = [{ seq: 1, type: "farend", data: { text: "A" } }, { seq: 2, type: "agent", data: { text: "B" } }];
      return { events: all.filter((e) => e.seq > since), done: false }; } };
  const { db, call_id, d } = await setup({ runner });
  await d.tick(); await d.tick();
  const d2 = createDispatcher({ db, runner, deps: { notify: async () => {}, deliver: async () => ({}) }, settings: () => ({ ownerName: "K", dailyCap: 10, line: "fake", model: () => ({}) }) });
  await d2.tick();
  assert.equal((await store.getCall(db, call_id)).transcript.length, 2);
});

// ---- fix round 1 ----
const okResult = (extra = {}) => ({ events: [{ seq: 1, type: "result", data: { outcome: "info_gathered", booking: null, summary: "ok", ...extra } }], done: true });
const mkRunner = (over = {}) => ({ start: async () => ({ ok: true }), stop: async () => {}, events: async () => okResult(), ...over });

test("deliver throws once → retried and delivered exactly once on a later tick", async () => {
  let n = 0; const ok = [];
  const { db, call_id } = await setup({ runner: mkRunner() });
  const d = createDispatcher({ db, runner: mkRunner(), deps: { notify: async () => {}, deliver: async (_d, c) => { if (++n === 1) throw new Error("boom"); ok.push(c.id); return {}; } },
    settings: () => ({ ownerName: "K", dailyCap: 10, line: "fake", model: () => ({ label: "l" }) }) });
  await d.tick(); await d.tick(); await d.tick(); await d.tick();
  assert.deepEqual(ok, [call_id]);
  assert.equal((await store.getCall(db, call_id)).status, "done");
});

test("restart: a new dispatcher delivers a done+undelivered call", async () => {
  const { db, call_id } = await setup({ runner: mkRunner() });
  await db.execute({ sql: "UPDATE phone_calls SET status='done', outcome='failed', delivered=0, ended_at=datetime('now') WHERE id=?", args: [call_id] });
  const got = [];
  const d = createDispatcher({ db, runner: mkRunner(), deps: { notify: async () => {}, deliver: async (_d, c) => { got.push(c.id); return {}; } }, settings: () => ({ dailyCap: 10, model: () => null }) });
  await d.tick();
  assert.deepEqual(got, [call_id]);
});

test("deliver always throwing → stops after 5 attempts", async () => {
  let n = 0;
  const { db, call_id } = await setup({ runner: mkRunner() });
  await db.execute({ sql: "UPDATE phone_calls SET status='done', outcome='failed', ended_at=datetime('now') WHERE id=?", args: [call_id] });
  const d = createDispatcher({ db, runner: mkRunner(), deps: { notify: async () => {}, deliver: async () => { n++; throw new Error("x"); } }, settings: () => ({ dailyCap: 10, model: () => null }) });
  for (let i = 0; i < 9; i++) await d.tick();
  assert.equal(n, 5);
});

test("result finalizes first; a repeated result does not re-finalize or re-deliver", async () => {
  const delivered = [];
  const { db, call_id, d } = await setup({ runner: mkRunner() });
  await d.tick(); await d.tick(); await d.tick(); await d.tick();
  assert.equal((await store.getCall(db, call_id)).status, "done");
  assert.equal((await store.getCall(db, call_id)).event_seq, 1);
});

test("done:true without a result → failed 'runner ended without a result'", async () => {
  const { db, call_id, d } = await setup({ runner: mkRunner({ events: async () => ({ events: [], done: true }) }) });
  await d.tick(); await d.tick();
  const c = await store.getCall(db, call_id);
  assert.equal(c.outcome, "failed"); assert.match(c.error, /ended without a result/);
});

test("30 consecutive events() failures → stop + failed 'runner unreachable'", async () => {
  let stops = 0;
  const { db, call_id, d } = await setup({ runner: mkRunner({ events: async () => { throw new Error("down"); }, stop: async () => { stops++; } }) });
  await d.tick();
  for (let i = 0; i < 29; i++) await d.tick();
  assert.equal((await store.getCall(db, call_id)).status, "live");
  await d.tick();
  const c = await store.getCall(db, call_id);
  assert.equal(c.outcome, "failed"); assert.match(c.error, /runner unreachable/); assert.equal(stops, 1);
});

test("call older than 25 minutes → stop + failed 'maximum duration'", async () => {
  let stops = 0;
  const { db, call_id, d } = await setup({ runner: mkRunner({ events: async () => ({ events: [], done: false }), stop: async () => { stops++; } }) });
  await d.tick();
  await db.execute({ sql: "UPDATE phone_calls SET started_at=datetime('now','-26 minutes') WHERE id=?", args: [call_id] });
  await d.tick();
  const c = await store.getCall(db, call_id);
  assert.equal(c.outcome, "failed"); assert.match(c.error, /maximum duration/); assert.equal(stops, 1);
});

test("runner.start throws → runner.stop called and call failed", async () => {
  let stops = 0;
  const { db, call_id, d } = await setup({ runner: mkRunner({ start: async () => { throw new Error("nope"); }, stop: async () => { stops++; } }) });
  await d.tick();
  assert.equal(stops, 1);
  assert.equal((await store.getCall(db, call_id)).outcome, "failed");
});

test("markLive false after start → runner.stop called", async () => {
  let stops = 0;
  let dbRef;
  const runner = mkRunner({ start: async (c) => { await dbRef.execute({ sql: "UPDATE phone_calls SET status='cancelled' WHERE id=?", args: [c.id] }); return { ok: true }; }, stop: async () => { stops++; } });
  const s = await setup({ runner }); dbRef = s.db;
  await s.d.tick();
  assert.equal(stops, 1);
});

test("runner result is validated: bad outcome → failed; booking whitelisted", async () => {
  const a = await setup({ runner: mkRunner({ events: async () => okResult({ outcome: "pwned" }) }) });
  await a.d.tick(); await a.d.tick();
  const ca = await store.getCall(a.db, a.call_id);
  assert.equal(ca.outcome, "failed"); assert.match(ca.error, /invalid outcome from runner/);
  const long = "x".repeat(500);
  const b = await setup({ runner: mkRunner({ events: async () => okResult({ outcome: "booked", booking: { date: "2026-10-06", location: long, price: "abc", evil: "x", notes: "n" } }) }) });
  await b.d.tick(); await b.d.tick();
  const cb = await store.getCall(b.db, b.call_id);
  assert.equal(cb.outcome, "booked");
  assert.equal(cb.booking.evil, undefined); assert.equal(cb.booking.location.length, 200); assert.equal(cb.booking.price, null); assert.equal(cb.booking.notes, "n");
});

test("runner not running the call (active:false, done:false) → failed 'runner lost the call' after the start grace", async () => {
  let stops = 0;
  const { db, call_id, d } = await setup({ runner: mkRunner({ events: async () => ({ events: [], done: false, active: false }), stop: async () => { stops++; } }) });
  await d.tick(); // start → live
  await d.tick(); // inside the 15 s start grace: still live
  assert.equal((await store.getCall(db, call_id)).status, "live");
  await db.execute({ sql: "UPDATE phone_calls SET started_at=datetime('now','-20 seconds') WHERE id=?", args: [call_id] });
  await d.tick();
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "done"); assert.equal(c.outcome, "failed"); assert.equal(c.error, "runner lost the call"); assert.equal(stops, 1);
});

test("active:true or a runner without the active field keeps waiting", async () => {
  for (const extra of [{ active: true }, {}]) {
    const { db, call_id, d } = await setup({ runner: mkRunner({ events: async () => ({ events: [], done: false, ...extra }) }) });
    await d.tick();
    await db.execute({ sql: "UPDATE phone_calls SET started_at=datetime('now','-5 minutes') WHERE id=?", args: [call_id] });
    await d.tick();
    assert.equal((await store.getCall(db, call_id)).status, "live", JSON.stringify(extra));
  }
});

// ---- spec 2026-10-01 §4.2 / §4.6: card pushes ----
async function perchSetup(runner, log, { approve = true } = {}) {
  const db = createDbClient(join(mkdtempSync(join(tmpdir(), "phone-disp-card-")), "crow.db"));
  await initPhoneTables(db);
  const plan = validatePlan({ business_name: "Smile", number: "512-555-0101", goal: "Book", language: "en" });
  const { call_id } = await store.createPlan(db, plan, { kind: "bot", id: "hank" }, { kind: "perch", session_id: "perch-1" });
  if (approve) await approveFresh(db, call_id, { session: "s", allowCloud: false });
  const d = createDispatcher({ db, runner,
    deps: { notify: async () => {},
      deliver: async (_db, c) => { log.push(["deliver", c.id]); return { via: "perch" }; },
      notifyCard: async (sid, frame, opts) => { log.push(["card", sid, frame, opts]); return { delivered: true, botId: opts.botId }; } },
    settings: () => ({ ownerName: "K", ownerNumber: null, dailyCap: 10, line: "fake", model: () => ({ label: "l" }) }) });
  return { db, call_id, d };
}

test("one pointer frame per changed call per tick: live, transcript, terminal — terminal BEFORE delivery", async () => {
  const log = []; let step = 0;
  const runner = { start: async () => ({ ok: true }), stop: async () => {},
    events: async (_id, since) => {
      step++;
      if (step === 1) return { events: [{ seq: 1, type: "state", data: { state: "answered" } }], done: false, active: true };
      if (step === 2) return { events: [], done: false, active: true };
      return { events: [{ seq: 2, type: "result", data: { outcome: "info_gathered", booking: null, summary: "ok" } }].filter((e) => e.seq > since), done: true };
    } };
  const { call_id, d } = await perchSetup(runner, log);
  await d.tick(); // claim + start -> live
  await d.tick(); // seq 1
  await d.tick(); // nothing new -> no frame
  await d.tick(); // result -> done
  const cards = log.filter((x) => x[0] === "card");
  assert.deepEqual(cards.map((x) => [x[2].status, x[2].event_seq]), [["live", 0], ["live", 1], ["done", 2]]);
  for (const c of cards) {
    assert.equal(c[1], "perch-1");
    assert.deepEqual(Object.keys(c[2]).sort(), ["call_id", "event_seq", "status", "type"]);
    assert.equal(c[2].type, "phone_call"); assert.equal(c[2].call_id, call_id);
    assert.deepEqual(c[3], { botId: "hank" });
  }
  const iDone = log.findIndex((x) => x[0] === "card" && x[2].status === "done");
  const iDeliver = log.findIndex((x) => x[0] === "deliver");
  assert.ok(iDone > -1 && iDeliver > iDone, "the owner sees the outcome before the bot hears about it");
});

test("a failed start pushes the terminal frame too", async () => {
  const log = [];
  const runner = { start: async () => { throw new Error("down"); }, stop: async () => {}, events: async () => ({ events: [], done: false }) };
  const { d } = await perchSetup(runner, log);
  await d.tick();
  assert.deepEqual(log.filter((x) => x[0] === "card").map((x) => x[2].status), ["done"]);
});

test("a plan that expires (24 h) pushes its expired state to the chat card", async () => {
  const log = [];
  const runner = { start: async () => ({ ok: true }), stop: async () => {}, events: async () => ({ events: [], done: false }) };
  const { db, call_id, d } = await perchSetup(runner, log, { approve: false });
  await db.execute({ sql: "UPDATE phone_calls SET created_at=datetime('now','-25 hours') WHERE id=?", args: [call_id] });
  await d.tick();
  assert.deepEqual(log.filter((x) => x[0] === "card").map((x) => [x[2].call_id, x[2].status]), [[call_id, "expired"]]);
  await d.tick();
  assert.equal(log.filter((x) => x[0] === "card").length, 1, "expired once, pushed once");
});

// ---- spec 2026-10-01 §4.6 / C2: transient delivery failures ----
async function doneCallForPerch() {
  const db = createDbClient(join(mkdtempSync(join(tmpdir(), "phone-disp-busy-")), "crow.db"));
  await initPhoneTables(db);
  await db.executeMultiple(`CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, gateway_type TEXT, gateway_thread_id TEXT, kind TEXT);
    INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, kind) VALUES ('hank','perch','perch-1','perch-live');`);
  const plan = validatePlan({ business_name: "Smile", number: "512-555-0101", goal: "Book", language: "en" });
  const { call_id } = await store.createPlan(db, plan, { kind: "bot", id: "hank" }, { kind: "perch", session_id: "perch-1" });
  await db.execute({ sql: "UPDATE phone_calls SET status='done', outcome='info_gathered', ended_at=datetime('now') WHERE id=?", args: [call_id] });
  return { db, call_id };
}
const idleRunner = { start: async () => ({ ok: true }), stop: async () => {}, events: async () => ({ events: [], done: false }) };
const coded = (code) => Object.assign(new Error(code), { code });

test("a bot mid-turn keeps the result pending with backoff, notifies the owner ONCE, then delivers", async () => {
  const { db, call_id } = await doneCallForPerch();
  const notes = []; const sent = []; let busy = 2;
  const d = createDispatcher({ db, runner: idleRunner,
    deps: { notify: async (_db, n) => { notes.push(n); }, perchMessage: async (sid) => { if (busy-- > 0) throw coded("turn_in_progress"); sent.push(sid); } },
    settings: () => ({ dailyCap: 10, model: () => null }) });
  await d.tick();
  let c = await store.getCall(db, call_id);
  assert.equal(c.delivered, 0); assert.equal(c.delivery_attempts, 0); assert.equal(c.delivery_busy, 1);
  const wait = (await db.execute({ sql: "SELECT (julianday(delivery_retry_at) - julianday('now')) * 86400 AS s FROM phone_calls WHERE id=?", args: [call_id] })).rows[0].s;
  assert.ok(wait > 3 && wait <= 6, "first backoff is ~5 s, got " + wait);
  await d.tick(); // backoff not elapsed -> not retried
  assert.equal((await store.getCall(db, call_id)).delivery_busy, 1);
  for (let i = 0; i < 2; i++) {
    await db.execute({ sql: "UPDATE phone_calls SET delivery_retry_at=datetime('now','-1 second') WHERE id=?", args: [call_id] });
    await d.tick();
  }
  c = await store.getCall(db, call_id);
  assert.equal(c.delivered, 1);
  assert.deepEqual(sent, ["perch-1"]);
  assert.equal(notes.length, 1, "the owner is notified once, not once per transient retry");
});

for (const code of ["turn_in_progress", "cycle_busy", "interactive_capacity", "pi_capacity", "no_engine"]) {
  test(`C2: ${code} is transient — deferred with backoff, never counted as a failed attempt`, async () => {
    const { db, call_id } = await doneCallForPerch();
    const d = createDispatcher({ db, runner: idleRunner,
      deps: { notify: async () => {}, perchMessage: async () => { throw coded(code); } },
      settings: () => ({ dailyCap: 10, model: () => null }) });
    for (let i = 0; i < 6; i++) {
      await db.execute({ sql: "UPDATE phone_calls SET delivery_retry_at=NULL WHERE id=?", args: [call_id] });
      await d.tick();
    }
    const c = await store.getCall(db, call_id);
    assert.equal(c.delivered, 0);
    assert.equal(c.delivery_attempts, 0, "6 transient failures, still deliverable");
    assert.equal(c.delivery_busy, 6);
  });
}

test("a plain error still burns the 5-attempt budget (not transient)", async () => {
  const { db, call_id } = await doneCallForPerch();
  let n = 0;
  const d = createDispatcher({ db, runner: idleRunner,
    deps: { notify: async () => {}, perchMessage: async () => { n++; throw new Error("session_stopped-ish"); } },
    settings: () => ({ dailyCap: 10, model: () => null }) });
  for (let i = 0; i < 7; i++) await d.tick();
  assert.equal(n, 5);
  assert.equal((await store.getCall(db, call_id)).delivery_busy, 0);
});

test("transient for 10 minutes: delivery gives up (audited), the result stays in Phone", async () => {
  const { db, call_id } = await doneCallForPerch();
  await db.execute({ sql: "UPDATE phone_calls SET ended_at=datetime('now','-11 minutes') WHERE id=?", args: [call_id] });
  let tries = 0;
  const d = createDispatcher({ db, runner: idleRunner,
    deps: { notify: async () => {}, perchMessage: async () => { tries++; throw coded("no_engine"); } },
    settings: () => ({ dailyCap: 10, model: () => null }) });
  await d.tick(); await d.tick();
  const c = await store.getCall(db, call_id);
  assert.equal(c.delivered, 0); assert.equal(c.delivery_attempts, 5); assert.equal(tries, 1);
  const ev = (await db.execute({ sql: "SELECT event FROM phone_audit WHERE call_id=? AND event='delivery_gave_up'", args: [call_id] })).rows;
  assert.equal(ev.length, 1);
});
