import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunnerClient } from "../bundles/phone/server/runner-client.js";

test("no secret → requests reject with a clear error, nothing is sent", async () => {
  let sent = 0;
  const c = createRunnerClient({ baseUrl: "http://x", fetchImpl: async () => { sent++; return { ok: true, json: async () => ({}) }; } });
  await assert.rejects(() => c.events("call_1", 0), /secret/i);
  assert.equal(sent, 0);
});

test("start body shape matches the runner's StartBody exactly", async () => {
  let req = null;
  const c = createRunnerClient({ baseUrl: "http://x", secret: "s".repeat(32),
    fetchImpl: async (url, init) => { req = { url, init }; return { ok: true, json: async () => ({ ok: true }) }; } });
  const call = { id: "call_1", business_name: "Smile", number_e164: "+15125550101", goal: "Book", limits: {}, shareable: { name: "Casey" },
    language: "en", notes: null, status: "starting", token_hash: "must-not-leak", created_by: { kind: "bot", id: "b" } };
  await c.start(call, "tok", { base_url: "http://m", api_key: "k", model: "x" }, "Casey", "interactive");
  assert.equal(req.url, "http://x/calls/call_1/start");
  assert.equal(req.init.method, "POST");
  assert.equal(req.init.headers.Authorization, "Bearer " + "s".repeat(32));
  const body = JSON.parse(req.init.body);
  assert.deepEqual(Object.keys(body).sort(), ["call_id", "line", "model", "owner_name", "plan", "token"]);
  assert.deepEqual(Object.keys(body.plan).sort(), ["business_name", "goal", "language", "limits", "notes", "number_e164", "shareable"]);
  assert.equal(body.call_id, "call_1"); assert.equal(body.token, "tok"); assert.equal(body.owner_name, "Casey"); assert.equal(body.line, "interactive");
});
