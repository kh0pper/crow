// tests/bot-directory-editor.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCrowMessagesGatewayConfig } from "../servers/gateway/dashboard/panels/bot-builder/api-handlers.js";

test("crow-messages save captures the tagline (trimmed, capped) when present", () => {
  const gw = buildCrowMessagesGatewayConfig({ gw_allow_paired_instances: "on", gw_description: "  Schedules & reminders  " });
  assert.equal(gw.type, "crow-messages");
  assert.equal(gw.allow_paired_instances, true);
  assert.equal(gw.description, "Schedules & reminders", "trimmed tagline saved");
});
test("crow-messages save omits description when blank", () => {
  const gw = buildCrowMessagesGatewayConfig({ gw_allow_paired_instances: "", gw_description: "   " });
  assert.equal(gw.allow_paired_instances, false);
  assert.equal("description" in gw, false, "no description key when blank");
});
test("crow-messages save caps the tagline at 140 chars", () => {
  const gw = buildCrowMessagesGatewayConfig({ gw_description: "x".repeat(300) });
  assert.equal(gw.description.length, 140);
});
