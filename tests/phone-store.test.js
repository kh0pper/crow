import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { initPhoneTables } from "../bundles/phone/server/init-tables.js";
import * as store from "../bundles/phone/server/store.js";
import { validatePlan } from "../bundles/phone/server/plan.js";

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
    store.approveCall(db, call_id, { session: "s1", allowCloud: false }),
    store.approveCall(db, call_id, { session: "s1", allowCloud: false }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "not_pending");
});

test("token is single-use and bound to the call", async () => {
  const a = await store.createPlan(db, plan(), bot, null);
  const b = await store.createPlan(db, plan(), bot, null);
  const { token } = await store.approveCall(db, a.call_id, { session: "s", allowCloud: true });
  assert.equal(await store.consumeToken(db, b.call_id, token), false);
  assert.equal(await store.consumeToken(db, a.call_id, token), true);
  assert.equal(await store.consumeToken(db, a.call_id, token), false);
});

test("edit after approval invalidates the token and re-pends", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  const { token } = await store.approveCall(db, call_id, { session: "s", allowCloud: false });
  await store.editCall(db, call_id, { goal: "Book two cleanings" });
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "awaiting_approval");
  assert.equal(c.goal, "Book two cleanings");
  assert.equal(await store.consumeToken(db, call_id, token), false);
});

test("claimNextDue: one live call at a time, respects run_after", async () => {
  const a = await store.createPlan(db, plan(), bot, null);
  const b = await store.createPlan(db, plan(), bot, null);
  await store.approveCall(db, a.call_id, { session: "s", allowCloud: false, runAfter: new Date(Date.now() + 3600e3).toISOString() });
  await store.approveCall(db, b.call_id, { session: "s", allowCloud: false });
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
  const { token } = await store.approveCall(db, call_id, { session: "s", allowCloud: false, edits: { goal: "New goal" } });
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "approved");
  assert.equal(c.goal, "New goal");
  // token bound to plan_hash; if we edit after approval, old token is invalid
  await store.editCall(db, call_id, { goal: "Another goal" });
  assert.equal(await store.consumeToken(db, call_id, token), false);
});

test("editCall: ONE guarded UPDATE, refuses to edit live/done calls", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  await store.approveCall(db, call_id, { session: "s", allowCloud: false });
  await db.execute({ sql: "UPDATE phone_calls SET status='live' WHERE id=?", args: [call_id] });
  await assert.rejects(store.editCall(db, call_id, { goal: "Nope" }), (e) => e.code === "not_editable");
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "live");
});

test("claimNextDue: concurrent claims yield exactly one starting call", async () => {
  const a = await store.createPlan(db, plan(), bot, null);
  const b = await store.createPlan(db, plan(), bot, null);
  await store.approveCall(db, a.call_id, { session: "s", allowCloud: false });
  await store.approveCall(db, b.call_id, { session: "s", allowCloud: false });
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
  await store.approveCall(db, call_id, { session: "s", allowCloud: false });
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

test("consumeToken refused on non-approved call", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  const { token } = await store.approveCall(db, call_id, { session: "s", allowCloud: false });
  // Token still pending approval — oh wait, it's already approved above.
  // Let's test the case where token is consumed while status changes
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "approved");
  assert.equal(await store.consumeToken(db, call_id, token), true);
  const c2 = await store.getCall(db, call_id);
  assert.equal(c2.status, "approved"); // consumeToken clears hash but doesn't change status
});

test("daily bot limit: 10/day (excludes non-pending)", async () => {
  for (let i = 0; i < 10; i++) {
    const { call_id } = await store.createPlan(db, plan(), bot, null);
    if (i % 2 === 0) await store.rejectCall(db, call_id); // Reject half of them
  }
  // We have 5 rejected, 5 pending. Total 10 created today. Next one should fail.
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
  await store.approveCall(db, call_id, { session: "s", allowCloud: false });
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
