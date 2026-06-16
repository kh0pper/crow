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
