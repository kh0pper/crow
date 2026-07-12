// tests/bot-directory-cache.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { getPeerAdvertisedBots, _setFetchImpl, _resetCache } from "../servers/gateway/dashboard/advertised-bots-cache.js";

const PK = "a".repeat(64);
function withBody(body) {
  _resetCache();
  _setFetchImpl(async () => ({ ok: true, body }));
}

test("validated advertised bot carries a sanitized description", async () => {
  withBody({ bots: [{ bot_id: "b1", display_name: "Helper", messaging_pubkey: "02" + PK, invite_code: "crow:a.b.c", description: "Schedules & reminders" }] });
  const r = await getPeerAdvertisedBots({}, "inst-1");
  assert.equal(r.status, "ok");
  assert.equal(r.bots[0].description, "Schedules & reminders");
  _setFetchImpl(null);
});

test("description is null when absent and capped when overlong", async () => {
  withBody({ bots: [
    { bot_id: "b2", display_name: "Quiet", messaging_pubkey: "02" + PK, invite_code: "crow:a.b.c" },
    { bot_id: "b3", display_name: "Long", messaging_pubkey: "03" + PK, invite_code: "crow:a.b.c", description: "x".repeat(500) },
  ] });
  const r = await getPeerAdvertisedBots({}, "inst-2");
  assert.equal(r.bots[0].description, null, "absent → null");
  assert.equal(r.bots[1].description.length, 140, "capped at 140");
  _setFetchImpl(null);
});

// --- F1: completeness is a POSITIVE assertion, checked on the receiver too (spec §3 F1) ---

const okBot = (id, pk = PK) => ({ bot_id: id, display_name: id, messaging_pubkey: "02" + pk, invite_code: "crow:a.b.c" });

test("F1 receiver: a sender-asserted, fully-parsed payload is complete", async () => {
  withBody({ bots: [okBot("b1")], complete: true });
  const r = await getPeerAdvertisedBots({}, "c-inst-1");
  assert.equal(r.status, "ok");
  assert.equal(r.complete, true);
  _setFetchImpl(null);
});

test("F1 receiver: a validateBot drop downgrades complete to false (status stays ok)", async () => {
  withBody({ bots: [okBot("b1"), { bot_id: "bad", messaging_pubkey: "not-hex", invite_code: "crow:a.b.c" }], complete: true });
  const r = await getPeerAdvertisedBots({}, "c-inst-2");
  assert.equal(r.status, "ok", "a drop is not an outage");
  assert.equal(r.bots.length, 1, "the malformed entry is dropped");
  assert.equal(r.complete, false, "receiver could not parse a bot the sender sent → not complete");
  _setFetchImpl(null);
});

test("F1 receiver: a body that is not {bots:[...]} is unavailable, not ok-with-empty-bots", async () => {
  withBody({});
  const r1 = await getPeerAdvertisedBots({}, "c-inst-3");
  assert.equal(r1.status, "unavailable", "missing bots array is an outage, not 'advertises nothing'");
  assert.deepEqual(r1.bots, []);
  assert.equal(r1.complete, false);

  withBody({ bots: "nope" });
  const r2 = await getPeerAdvertisedBots({}, "c-inst-4");
  assert.equal(r2.status, "unavailable", "non-array bots is an outage");
  assert.equal(r2.complete, false);
  _setFetchImpl(null);
});

test("F1 receiver: ROLLING-DEPLOY GUARD — an old peer sending no complete key yields complete:false", async () => {
  withBody({ bots: [okBot("b1")] }); // old sender: 200, valid bots, NO complete key
  const r = await getPeerAdvertisedBots({}, "c-inst-5");
  assert.equal(r.status, "ok", "an old peer is still reachable");
  assert.equal(r.bots.length, 1);
  assert.equal(r.complete, false, "absence of a positive assertion must never read as complete");
  _setFetchImpl(null);
});

test("F1 receiver: a legitimately empty advertised list from a healthy peer IS complete", async () => {
  withBody({ bots: [], complete: true });
  const r = await getPeerAdvertisedBots({}, "c-inst-6");
  assert.equal(r.status, "ok");
  assert.deepEqual(r.bots, []);
  assert.equal(r.complete, true, "empty is not the same as broken");
  _setFetchImpl(null);
});

test("F1 receiver: unavailable sentinels all carry complete:false", async () => {
  _resetCache();
  _setFetchImpl(async () => ({ ok: false, error: "timeout" }));
  const fetchFailed = await getPeerAdvertisedBots({}, "c-inst-7");
  assert.equal(fetchFailed.status, "unavailable");
  assert.equal(fetchFailed.complete, false);

  _resetCache();
  _setFetchImpl(async () => { throw new Error("boom"); });
  const threw = await getPeerAdvertisedBots({}, "c-inst-8");
  assert.equal(threw.status, "unavailable");
  assert.equal(threw.complete, false);

  const noId = await getPeerAdvertisedBots({}, "");
  assert.equal(noId.status, "unavailable");
  assert.equal(noId.complete, false, "the no_id sentinel too");
  _setFetchImpl(null);
});
