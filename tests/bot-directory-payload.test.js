// tests/bot-directory-payload.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAdvertisementPayload } from "../servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js";

function fakeDb(defs) {
  return { async execute(q) { return { rows: defs }; } };
}
const ident = { secp256k1Pubkey: "02" + "a".repeat(64) };
const seams = {
  instanceId: "inst-1", instanceLabel: "Phone",
  _identityFor: () => ident,
  _buildInviteCode: async () => "crow:bot.payload.sig",
};

test("advertisement carries the tagline (description) from the gateway config", async () => {
  const db = fakeDb([{ bot_id: "b1", display_name: "Helper",
    definition: JSON.stringify({ gateways: [{ type: "crow-messages", allow_paired_instances: true, description: "Schedules & reminders" }] }) }]);
  const { bots } = await buildAdvertisementPayload(db, seams);
  assert.equal(bots.length, 1);
  assert.equal(bots[0].description, "Schedules & reminders", "tagline advertised");
});

test("advertisement omits description when the tagline is unset", async () => {
  const db = fakeDb([{ bot_id: "b2", display_name: "Quiet",
    definition: JSON.stringify({ gateways: [{ type: "crow-messages", allow_paired_instances: true }] }) }]);
  const { bots } = await buildAdvertisementPayload(db, seams);
  assert.equal(bots.length, 1);
  assert.equal("description" in bots[0], false, "no description field when unset");
});

// --- F1: completeness is a POSITIVE assertion (spec §3 F1) ---

const advertised = (botId) => ({
  bot_id: botId, display_name: botId,
  definition: JSON.stringify({ gateways: [{ type: "crow-messages", allow_paired_instances: true }] }),
});

test("F1 sender: a clean payload asserts complete:true", async () => {
  const db = fakeDb([advertised("b1"), advertised("b2")]);
  const payload = await buildAdvertisementPayload(db, seams);
  assert.equal(payload.bots.length, 2);
  assert.equal(payload.complete, true, "zero bots skipped → positive completeness assertion");
});

test("F1 sender: a bot whose identity throws omits the complete key entirely", async () => {
  const db = fakeDb([advertised("good"), advertised("broken")]);
  const payload = await buildAdvertisementPayload(db, {
    ...seams,
    _identityFor: (botId) => {
      if (botId === "broken") throw new Error("database is locked");
      return ident;
    },
  });
  assert.ok(!("complete" in payload), "a skipped bot must NOT assert completeness (no negative flag either)");
  assert.equal(payload.bots.length, 1, "the other bots are still returned (still a 200-shaped payload)");
  assert.equal(payload.bots[0].bot_id, "good");
});

test("F1 sender: an empty advertised list is still a complete payload", async () => {
  const db = fakeDb([]);
  const payload = await buildAdvertisementPayload(db, seams);
  assert.deepEqual(payload.bots, []);
  assert.equal(payload.complete, true, "nothing advertised, nothing skipped → complete");
});
