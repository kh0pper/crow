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

async function setup({ runner, settings } = {}) {
  const db = createDbClient(join(mkdtempSync(join(tmpdir(), "phone-disp-")), "crow.db"));
  await initPhoneTables(db);
  const plan = validatePlan({ business_name: "Smile", number: "512-555-0101", goal: "Book", language: "en" });
  const { call_id } = await store.createPlan(db, plan, { kind: "bot", id: "bobby" }, null);
  const { token } = await store.approveCall(db, call_id, { session: "s", allowCloud: false });
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
