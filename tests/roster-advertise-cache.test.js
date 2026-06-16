// tests/roster-advertise-cache.test.js
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getPeerAdvertisedBots, _setFetchImpl, _resetCache,
} from "../servers/gateway/dashboard/advertised-bots-cache.js";

const PK = "a".repeat(64);
beforeEach(() => { _resetCache(); _setFetchImpl(null); });

test("ok response is validated and returned", async () => {
  _setFetchImpl(async () => ({ ok: true, body: { bots: [
    { bot_id: "b1", display_name: "Bot One", instance_label: "Laptop", messaging_pubkey: PK, invite_code: "crow:x.y.z" },
    { bot_id: "bad", messaging_pubkey: "nothex", invite_code: "crow:1.2.3" }, // dropped
  ] } }));
  const r = await getPeerAdvertisedBots({}, "inst1");
  assert.equal(r.status, "ok");
  assert.equal(r.bots.length, 1);
  assert.equal(r.bots[0].bot_id, "b1");
  assert.equal(r.bots[0].instance_id, "inst1");
  assert.equal(r.bots[0].messaging_pubkey, PK);
});

test("fetch failure yields an unavailable sentinel (never throws)", async () => {
  _setFetchImpl(async () => ({ ok: false, error: "timeout" }));
  const r = await getPeerAdvertisedBots({}, "inst2");
  assert.equal(r.status, "unavailable");
  assert.deepEqual(r.bots, []);
});

test("second call within TTL does not re-fetch", async () => {
  let calls = 0;
  _setFetchImpl(async () => { calls++; return { ok: true, body: { bots: [] } }; });
  await getPeerAdvertisedBots({}, "inst3");
  await getPeerAdvertisedBots({}, "inst3");
  assert.equal(calls, 1, "cached on second call");
});
