import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { initPhoneTables } from "../bundles/phone/server/init-tables.js";
import * as store from "../bundles/phone/server/store.js";
import { validatePlan } from "../bundles/phone/server/plan.js";
import { cardFrame, pushCallCard } from "../bundles/phone/server/card.js";

async function fresh() {
  const db = createDbClient(join(mkdtempSync(join(tmpdir(), "phone-card-")), "crow.db"));
  await initPhoneTables(db);
  return db;
}
const plan = () => validatePlan({ business_name: "Smile", number: "512-555-0101", goal: "Book", language: "en", shareable: { name: "Kevin" } });
const audits = async (db, id) => (await db.execute({ sql: "SELECT event, detail_json FROM phone_audit WHERE call_id=? AND event='card_target_mismatch'", args: [id] })).rows;

test("I2: the frame is a pointer — exactly type, call_id, status, event_seq", async () => {
  const db = await fresh();
  const { call_id } = await store.createPlan(db, plan(), { kind: "bot", id: "hank" }, { kind: "perch", session_id: "p1" });
  const f = cardFrame(await store.getCall(db, call_id));
  assert.deepEqual(f, { type: "phone_call", call_id, status: "awaiting_approval", event_seq: 0 });
});

test("pushes to the requesting session with the creating bot named (I3)", async () => {
  const db = await fresh();
  const { call_id } = await store.createPlan(db, plan(), { kind: "bot", id: "hank" }, { kind: "perch", session_id: "p1" });
  const seen = [];
  const r = await pushCallCard(db, await store.getCall(db, call_id), async (sid, frame, opts) => { seen.push([sid, frame, opts]); return { delivered: true, botId: "hank" }; });
  assert.equal(r.delivered, true);
  assert.deepEqual(seen, [["p1", { type: "phone_call", call_id, status: "awaiting_approval", event_seq: 0 }, { botId: "hank" }]]);
});

test("non-perch, owner-made, or hook-less calls never push", async () => {
  const db = await fresh();
  let calls = 0; const hook = async () => { calls++; return { delivered: true }; };
  const a = (await store.createPlan(db, plan(), { kind: "bot", id: "hank" }, { kind: "gateway", gateway_type: "discord", gateway_thread_id: "d1" })).call_id;
  const b = (await store.createPlan(db, plan(), null, { kind: "perch", session_id: "p1" })).call_id;
  const c = (await store.createPlan(db, plan(), { kind: "bot", id: "hank" }, null)).call_id;
  assert.equal((await pushCallCard(db, await store.getCall(db, a), hook)).reason, "not_perch");
  assert.equal((await pushCallCard(db, await store.getCall(db, b), hook)).reason, "no_bot");
  assert.equal((await pushCallCard(db, await store.getCall(db, c), hook)).reason, "not_perch");
  assert.equal((await pushCallCard(db, await store.getCall(db, a), null)).reason, "no_hook");
  assert.equal(calls, 0);
});

test("I3: a mismatched target is audited ONCE per call, however many pushes follow", async () => {
  const db = await fresh();
  const { call_id } = await store.createPlan(db, plan(), { kind: "bot", id: "mallory" }, { kind: "perch", session_id: "hanks-session" });
  const engine = async () => ({ delivered: false, botId: "hank", reason: "bot_mismatch" });
  for (let i = 0; i < 3; i++) assert.equal((await pushCallCard(db, await store.getCall(db, call_id), engine)).delivered, false);
  const rows = await audits(db, call_id);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].detail_json), { session_id: "hanks-session", expected_bot: "mallory", session_bot: "hank" });
});

test("backlog P10: concurrent mismatched pushes still audit once (one INSERT ... WHERE NOT EXISTS)", async () => {
  const db = await fresh();
  const { call_id } = await store.createPlan(db, plan(), { kind: "bot", id: "mallory" }, { kind: "perch", session_id: "hanks-session" });
  const call = await store.getCall(db, call_id);
  const engine = async () => ({ delivered: false, botId: "hank", reason: "bot_mismatch" });
  await Promise.all(Array.from({ length: 8 }, () => pushCallCard(db, call, engine)));
  assert.equal((await audits(db, call_id)).length, 1);
  const actor = (await db.execute({ sql: "SELECT actor FROM phone_audit WHERE call_id=? AND event='card_target_mismatch'", args: [call_id] })).rows[0].actor;
  assert.equal(actor, "service");
});

test("a missing session is not audited; a throwing hook never throws out", async () => {
  const db = await fresh();
  const { call_id } = await store.createPlan(db, plan(), { kind: "bot", id: "hank" }, { kind: "perch", session_id: "gone" });
  const c = await store.getCall(db, call_id);
  assert.equal((await pushCallCard(db, c, async () => ({ delivered: false, botId: null, reason: "no_session" }))).delivered, false);
  assert.equal((await pushCallCard(db, c, async () => { throw new Error("engine down"); })).reason, "error");
  assert.equal((await audits(db, call_id)).length, 0);
});
