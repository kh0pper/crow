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
