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
