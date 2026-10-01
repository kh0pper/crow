import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { initPhoneTables } from "../bundles/phone/server/init-tables.js";
import * as store from "../bundles/phone/server/store.js";
import { validatePlan } from "../bundles/phone/server/plan.js";
// I4 (spec 2026-10-01): every approval names the plan_hash the owner was shown.
async function approveFresh(d, id, o = {}) {
  return store.approveCall(d, id, { expectedHash: (await store.getCall(d, id)).plan_hash, ...o });
}


let db;
const plan = () => validatePlan({ business_name: "Smile Dental", number: "512-555-0101", goal: "Book a cleaning", language: "en",
  limits: { days_of_week: ["tue"], time_window: { start: "15:00", end: "18:00", tz: "America/Chicago" } }, shareable: { name: "Kevin" } });
const bot = { kind: "bot", id: "bobby", thread: "discord:42", gateway: "discord" };

beforeEach(async () => {
  db = createDbClient(join(mkdtempSync(join(tmpdir(), "phone-store-")), "crow.db"));
  await initPhoneTables(db);
  await initPhoneTables(db); // idempotent
});

test("createPlan stores awaiting_approval with actor + deliver_to", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, { kind: "gateway", gateway_type: "discord", gateway_thread_id: "discord:42" });
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "awaiting_approval");
  assert.equal(c.created_by.id, "bobby");
  assert.equal(c.deliver_to.gateway_thread_id, "discord:42");
  assert.equal(c.token_hash, null);
});

test("per-bot rate limit: 5 pending max", async () => {
  for (let i = 0; i < 5; i++) await store.createPlan(db, plan(), bot, null);
  await assert.rejects(store.createPlan(db, plan(), bot, null), (e) => e.code === "rate_limited");
});

test("approve is compare-and-set: two concurrent approvals yield one token", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  const results = await Promise.allSettled([
    approveFresh(db, call_id, { session: "s1", allowCloud: false }),
    approveFresh(db, call_id, { session: "s1", allowCloud: false }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "not_pending");
});

test("token is single-use and bound to the call", async () => {
  const a = await store.createPlan(db, plan(), bot, null);
  const b = await store.createPlan(db, plan(), bot, null);
  const { token } = await approveFresh(db, a.call_id, { session: "s", allowCloud: true });
  assert.equal(await store.consumeToken(db, b.call_id, token), false);
  assert.equal(await store.consumeToken(db, a.call_id, token), true);
  assert.equal(await store.consumeToken(db, a.call_id, token), false);
});

test("edit after approval invalidates the token and re-pends", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  const { token } = await approveFresh(db, call_id, { session: "s", allowCloud: false });
  await store.editCall(db, call_id, { goal: "Book two cleanings" });
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "awaiting_approval");
  assert.equal(c.goal, "Book two cleanings");
  assert.equal(await store.consumeToken(db, call_id, token), false);
});

test("claimNextDue: one live call at a time, respects run_after", async () => {
  const a = await store.createPlan(db, plan(), bot, null);
  const b = await store.createPlan(db, plan(), bot, null);
  await approveFresh(db, a.call_id, { session: "s", allowCloud: false, runAfter: new Date(Date.now() + 3600e3).toISOString() });
  await approveFresh(db, b.call_id, { session: "s", allowCloud: false });
  const first = await store.claimNextDue(db);
  assert.equal(first.id, b.call_id);
  assert.equal(await store.claimNextDue(db), null); // b is starting → nothing else runs
});

test("expirePlans expires unapproved plans older than 24h", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  await db.execute({ sql: "UPDATE phone_calls SET created_at = datetime('now','-25 hours') WHERE id = ?", args: [call_id] });
  assert.equal(await store.expirePlans(db), 1);
  assert.equal((await store.getCall(db, call_id)).status, "expired");
});

test("appendEvents is idempotent by seq and finalizeCall fires once", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  await store.appendEvents(db, call_id, [{ seq: 1, type: "farend", data: { text: "Hello" } }, { seq: 2, type: "agent", data: { text: "Hi" } }]);
  await store.appendEvents(db, call_id, [{ seq: 2, type: "agent", data: { text: "Hi" } }, { seq: 3, type: "farend", data: { text: "Sure" } }]);
  const c = await store.getCall(db, call_id);
  assert.equal(c.event_seq, 3);
  assert.equal(c.transcript.length, 3);
  await db.execute({ sql: "UPDATE phone_calls SET status='live' WHERE id=?", args: [call_id] }); // only running calls finalize
  assert.equal(await store.finalizeCall(db, call_id, { outcome: "info_gathered", booking: null, summary: "ok" }), true);
  assert.equal(await store.finalizeCall(db, call_id, { outcome: "failed", booking: null, summary: "dup" }), false);
});

test("suppression set", async () => {
  await store.addSuppression(db, "+15125550101", "asked");
  assert.ok((await store.suppressedSet(db)).has("+15125550101"));
});

test("approval with edits: ONE UPDATE, token bound to plan_hash", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  const { token } = await approveFresh(db, call_id, { session: "s", allowCloud: false, edits: { goal: "New goal" } });
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "approved");
  assert.equal(c.goal, "New goal");
  // token bound to plan_hash; if we edit after approval, old token is invalid
  await store.editCall(db, call_id, { goal: "Another goal" });
  assert.equal(await store.consumeToken(db, call_id, token), false);
});

test("editCall: ONE guarded UPDATE, refuses to edit live/done calls", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  await approveFresh(db, call_id, { session: "s", allowCloud: false });
  await db.execute({ sql: "UPDATE phone_calls SET status='live' WHERE id=?", args: [call_id] });
  await assert.rejects(store.editCall(db, call_id, { goal: "Nope" }), (e) => e.code === "not_editable");
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "live");
});

test("claimNextDue: concurrent claims yield exactly one starting call", async () => {
  const a = await store.createPlan(db, plan(), bot, null);
  const b = await store.createPlan(db, plan(), bot, null);
  await approveFresh(db, a.call_id, { session: "s", allowCloud: false });
  await approveFresh(db, b.call_id, { session: "s", allowCloud: false });
  const results = await Promise.allSettled([
    store.claimNextDue(db),
    store.claimNextDue(db),
  ]);
  const claimed = results.map((r) => r.status === "fulfilled" ? r.value : null).filter((r) => r !== null);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].status, "starting");
});

test("markLive: status guard, returns boolean", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  await approveFresh(db, call_id, { session: "s", allowCloud: false });
  const first = await store.claimNextDue(db);
  assert.equal(first.status, "starting");
  const res = await store.markLive(db, call_id);
  assert.equal(res, true);
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "live");
  // Try to mark a done call as live
  await store.finalizeCall(db, call_id, { outcome: "ok", booking: null, summary: "done" });
  const res2 = await store.markLive(db, call_id);
  assert.equal(res2, false);
  const c2 = await store.getCall(db, call_id);
  assert.equal(c2.status, "done");
});

test("consumeToken refused on unapproved or plan-changed call", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  assert.equal(await store.consumeToken(db, call_id, "any-token"), false);
  const { token } = await approveFresh(db, call_id, { session: "s", allowCloud: false });
  await store.editCall(db, call_id, { goal: "New goal" });
  assert.equal(await store.consumeToken(db, call_id, token), false);
});

test("per-bot daily limit: 10 plans per day regardless of pending", async () => {
  const callIds = [];
  // Control: Create 5, approve 5; create 4 more (total 9, pend=4); create 10th (succeeds); approve all 4
  for (let i = 0; i < 5; i++) {
    const { call_id } = await store.createPlan(db, plan(), bot, null);
    callIds.push(call_id);
  }
  for (let i = 0; i < 5; i++) {
    await approveFresh(db, callIds[i], { session: "s", allowCloud: false });
  }
  for (let i = 0; i < 4; i++) {
    const { call_id } = await store.createPlan(db, plan(), bot, null);
    callIds.push(call_id);
  }
  let pend = (await db.execute({ sql: "SELECT COUNT(*) n FROM phone_calls WHERE status='awaiting_approval' AND json_extract(created_by,'$.id')=?", args: [bot.id] })).rows[0].n;
  assert(pend <= 4);
  const res9 = await store.createPlan(db, plan(), bot, null);
  assert(res9.call_id);
  callIds.push(res9.call_id);
  // Approve the 4 new awaiting plans (indices 5-8)
  for (let i = 5; i < 9; i++) {
    await approveFresh(db, callIds[i], { session: "s", allowCloud: false });
  }
  // Boundary: now day=10, pend=1 (the 10th plan). Approve it then 11th fails
  await approveFresh(db, callIds[9], { session: "s", allowCloud: false });
  pend = (await db.execute({ sql: "SELECT COUNT(*) n FROM phone_calls WHERE status='awaiting_approval' AND json_extract(created_by,'$.id')=?", args: [bot.id] })).rows[0].n;
  assert.equal(pend, 0);
  await assert.rejects(store.createPlan(db, plan(), bot, null), (e) => e.code === "rate_limited");
});

test("cancelCall: bot ownership enforced", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  const other = { kind: "bot", id: "other-bot" };
  await assert.rejects(store.cancelCall(db, call_id, other), (e) => e.code === "forbidden");
});

test("cancelCall: success case", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  await store.cancelCall(db, call_id, bot);
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "cancelled");
});

test("rejectCall", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  await store.rejectCall(db, call_id);
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "rejected");
});

test("markDelivered: idempotent single-use", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  const res1 = await store.markDelivered(db, call_id);
  assert.equal(res1, true);
  const res2 = await store.markDelivered(db, call_id);
  assert.equal(res2, false);
});

test("issueStartToken: generates token for starting calls only", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  await approveFresh(db, call_id, { session: "s", allowCloud: false });
  // Call is approved, not starting
  const token1 = await store.issueStartToken(db, call_id);
  assert.equal(token1, null);
  // Claim it
  const claimed = await store.claimNextDue(db);
  assert.equal(claimed.status, "starting");
  // Now issue a token
  const token2 = await store.issueStartToken(db, call_id);
  assert(token2);
  // Consume it
  assert.equal(await store.consumeToken(db, call_id, token2), true);
});

// ---- spec 2026-10-01 I4: approve exactly what was shown ----
test("approveCall requires the shown plan_hash (I4)", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  await assert.rejects(store.approveCall(db, call_id, { session: "s", allowCloud: false }), (e) => e.code === "plan_hash_required");
  await assert.rejects(store.approveCall(db, call_id, { session: "s", allowCloud: false, expectedHash: "0".repeat(64) }), (e) => e.code === "plan_changed");
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "awaiting_approval");
  assert.equal(c.token_hash, null);
});

test("an edit between render and approve is never approved blind (plan_changed)", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  const shown = (await store.getCall(db, call_id)).plan_hash;
  await store.editCall(db, call_id, { goal: "Book two cleanings" });
  await assert.rejects(store.approveCall(db, call_id, { session: "s", allowCloud: false, expectedHash: shown }), (e) => e.code === "plan_changed");
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "awaiting_approval"); assert.equal(c.token_hash, null); assert.equal(c.goal, "Book two cleanings");
});

test("owner edits check the SHOWN hash, then store the edited plan's hash", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  const shown = (await store.getCall(db, call_id)).plan_hash;
  const { token } = await store.approveCall(db, call_id, { session: "s", allowCloud: false, expectedHash: shown, edits: { shareable: { name: "" } } });
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "approved");
  assert.notEqual(c.plan_hash, shown);
  assert.deepEqual(c.shareable, {});
  assert.equal(await store.consumeToken(db, call_id, token), true);
});

test("the approve CAS itself carries plan_hash (an edit landing between read and UPDATE loses)", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  const shown = (await store.getCall(db, call_id)).plan_hash;
  let raced = false;
  const racy = {
    execute: async (q) => {
      if (!raced && typeof q === "object" && /SET status='approved'/.test(q.sql)) {
        raced = true;
        await db.execute({ sql: "UPDATE phone_calls SET plan_hash='edited-elsewhere' WHERE id=?", args: [call_id] });
      }
      return db.execute(q);
    },
  };
  await assert.rejects(store.approveCall(racy, call_id, { session: "s", allowCloud: false, expectedHash: shown }), (e) => e.code === "plan_changed");
  assert.equal(raced, true);
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "awaiting_approval"); assert.equal(c.token_hash, null);
});

test("approve: 'now' (null) clears a proposed run_after; absent keeps it; a time sets it", async () => {
  const proposed = () => validatePlan({ business_name: "Smile Dental", number: "512-555-0101", goal: "Book", language: "en", run_after: "2030-01-01T15:00:00Z" });
  const mk = async () => (await store.createPlan(db, proposed(), bot, null)).call_id;
  const a = await mk(), b = await mk(), c = await mk();
  await approveFresh(db, a, { session: "s", allowCloud: false, runAfter: null });
  await approveFresh(db, b, { session: "s", allowCloud: false });
  await approveFresh(db, c, { session: "s", allowCloud: false, runAfter: "2031-02-03T04:05:00.000Z" });
  assert.equal((await store.getCall(db, a)).run_after, null, "Approve now means now");
  assert.equal((await store.getCall(db, b)).run_after, "2030-01-01T15:00:00.000Z", "absent keeps the stored time");
  assert.equal((await store.getCall(db, c)).run_after, "2031-02-03T04:05:00.000Z");
});

// ---- spec 2026-10-01 I5: per-session scoping ----
test("listPerchCalls: only this Perch session's calls from this session's bot, newest first, max 20 (I5)", async () => {
  const mk = async (actor, deliverTo) => (await store.createPlan(db, plan(), actor, deliverTo)).call_id;
  const mine = await mk({ kind: "bot", id: "hank" }, { kind: "perch", session_id: "perch-A" });
  await mk({ kind: "bot", id: "hank" }, { kind: "perch", session_id: "perch-B" });                                   // another session
  await mk({ kind: "bot", id: "mallory" }, { kind: "perch", session_id: "perch-A" });                                // forged thread only, other bot
  await mk({ kind: "bot", id: "hank" }, { kind: "gateway", gateway_type: "discord", gateway_thread_id: "perch-A" });  // not a perch target
  await mk(null, { kind: "perch", session_id: "perch-A" });                                                          // no bot
  assert.deepEqual((await store.listPerchCalls(db, "perch-A", "hank")).map((c) => c.id), [mine]);
  assert.deepEqual(await store.listPerchCalls(db, "perch-A", "nobody"), []);
  for (let i = 0; i < 22; i++) {
    await db.execute({ sql: "INSERT INTO phone_calls (id, created_by, deliver_to, business_name, number_e164, goal, plan_hash, created_at) VALUES (?,?,?,?,?,?,?, datetime('now', ?))",
      args: ["call_bulk_" + i, JSON.stringify({ kind: "bot", id: "hank" }), JSON.stringify({ kind: "perch", session_id: "perch-C" }), "B", "+15125550101", "g", "h", `+${i} seconds`] });
  }
  const bulk = await store.listPerchCalls(db, "perch-C", "hank", 50);
  assert.equal(bulk.length, 20, "never more than 20");
  assert.equal(bulk[0].id, "call_bulk_21", "newest first");
});

test("expirePlanIds returns exactly the plans it expired; expirePlans still returns a count", async () => {
  const a = (await store.createPlan(db, plan(), bot, null)).call_id;
  const b = (await store.createPlan(db, plan(), bot, null)).call_id;
  await db.execute({ sql: "UPDATE phone_calls SET created_at = datetime('now','-25 hours') WHERE id = ?", args: [a] });
  assert.deepEqual(await store.expirePlanIds(db), [a]);
  assert.deepEqual(await store.expirePlanIds(db), []);
  await db.execute({ sql: "UPDATE phone_calls SET created_at = datetime('now','-25 hours') WHERE id = ?", args: [b] });
  assert.equal(await store.expirePlans(db), 1);
});

// ---- spec 2026-10-01 §4.6: delivery backoff columns ----
test("initPhoneTables adds the delivery backoff columns to an existing table, idempotently", async () => {
  const old = createDbClient(join(mkdtempSync(join(tmpdir(), "phone-store-old-")), "crow.db"));
  await old.execute({ sql: "CREATE TABLE phone_calls (id TEXT PRIMARY KEY, status TEXT, number_e164 TEXT, started_at TEXT)", args: [] });
  await initPhoneTables(old);
  await initPhoneTables(old);
  const cols = (await old.execute("PRAGMA table_info(phone_calls)")).rows.map((r) => r.name);
  assert.ok(cols.includes("delivery_busy"));
  assert.ok(cols.includes("delivery_retry_at"));
});

test("initPhoneTables: a concurrent init's duplicate-column ALTER is ignored; any other ALTER error is not", async () => {
  const base = createDbClient(join(mkdtempSync(join(tmpdir(), "phone-store-dup-")), "crow.db"));
  await base.execute({ sql: "CREATE TABLE phone_calls (id TEXT PRIMARY KEY, status TEXT, number_e164 TEXT, started_at TEXT)", args: [] });
  // The other process won the race: our PRAGMA saw no column, our ALTER now fails.
  const racing = (message) => ({
    execute: (q) => (typeof q === "string" && q.startsWith("ALTER TABLE")) ? Promise.reject(new Error(message)) : base.execute(q),
    executeMultiple: (sql) => base.executeMultiple(sql),
  });
  await initPhoneTables(racing("SQLITE_ERROR: duplicate column name: delivery_busy"));
  await assert.rejects(initPhoneTables(racing("SQLITE_IOERR: disk I/O error")), /disk I\/O error/);
});
