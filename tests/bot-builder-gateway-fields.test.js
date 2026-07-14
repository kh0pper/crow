/**
 * Item 5 PR1 (spec §D3): the gateway-fields extraction is a pure refactor —
 * these parity tests pin the exact record shapes the pre-extraction
 * save_gateways branches produced and the field names/values the Gateways
 * tab rendered, for the five simple types (gmail/discord/telegram/slack/
 * none). The previously-named guard (bot-builder-gateway-draft.test.js)
 * only covers companion+glasses save and does NOT protect this refactor
 * (spec round-1 M2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SIMPLE_GATEWAY_TYPES, GATEWAY_REQUIRED_FIELDS,
  renderGatewayFields, normalizeGatewayFields, missingGatewayFields,
  buildCrowMessagesGatewayConfig,
} from "../servers/gateway/dashboard/panels/bot-builder/gateway-fields.js";

// ---- normalize parity: exact record shapes from the pre-extraction code ----

test("normalize: gmail record parity", () => {
  const out = normalizeGatewayFields("gmail", {
    gw_address: "  me+bot@example.com ",
    gw_allowlist: "a@x.com\n\n b@y.com \n",
  });
  assert.deepEqual(out, [{
    type: "gmail",
    address: "me+bot@example.com",
    allowlist: ["a@x.com", "b@y.com"],
  }]);
});

test("normalize: discord record parity (guild_id empty → undefined key)", () => {
  const out = normalizeGatewayFields("discord", {
    gw_token: " tok ",
    gw_guild_id: "",
    gw_channel_ids: "123\n456",
    gw_allowlist: "u1",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "discord");
  assert.equal(out[0].token, "tok");
  assert.equal(out[0].guild_id, undefined);
  assert.deepEqual(out[0].channel_ids, ["123", "456"]);
  assert.deepEqual(out[0].allowlist, ["u1"]);
});

test("normalize: telegram record parity", () => {
  const out = normalizeGatewayFields("telegram", {
    gw_token: "t",
    gw_allowlist: "111\n222",
    gw_chat_ids: "333",
  });
  assert.deepEqual(out, [{
    type: "telegram", token: "t", allowlist: ["111", "222"], chat_ids: ["333"],
  }]);
});

test("normalize: slack record parity", () => {
  const out = normalizeGatewayFields("slack", {
    gw_bot_token: "xoxb-1", gw_app_token: "xapp-1",
    gw_allowlist: "", gw_channel_ids: "C1",
  });
  assert.deepEqual(out, [{
    type: "slack", bot_token: "xoxb-1", app_token: "xapp-1",
    allowlist: [], channel_ids: ["C1"],
  }]);
});

test("normalize: none → empty gateways; non-simple types → null", () => {
  assert.deepEqual(normalizeGatewayFields("none", {}), []);
  for (const tpe of ["glasses", "companion", "crow-messages", "signal", "unknown"]) {
    assert.equal(normalizeGatewayFields(tpe, {}), null, tpe + " must fall through to bespoke handling");
  }
});

// ---- render parity: per-type field names present, saved values re-emitted ----

const FIELD_NAMES = {
  gmail: ["gw_address", "gw_allowlist"],
  discord: ["gw_token", "gw_guild_id", "gw_channel_ids", "gw_allowlist"],
  telegram: ["gw_token", "gw_allowlist", "gw_chat_ids"],
  slack: ["gw_bot_token", "gw_app_token", "gw_allowlist", "gw_channel_ids"],
  none: [],
};

test("render: every simple type renders exactly its field names, en and es", () => {
  for (const tpe of SIMPLE_GATEWAY_TYPES) {
    for (const lang of ["en", "es"]) {
      const r = renderGatewayFields(tpe, {}, lang);
      assert.ok(r && typeof r.fields === "string" && typeof r.hint === "string", `${tpe}/${lang} shape`);
      for (const name of FIELD_NAMES[tpe]) {
        assert.ok(r.fields.includes(`name="${name}"`), `${tpe}/${lang} must render ${name}`);
      }
      // No other type's exclusive fields bleed in.
      const others = Object.entries(FIELD_NAMES).filter(([k]) => k !== tpe).flatMap(([, v]) => v)
        .filter((n) => !FIELD_NAMES[tpe].includes(n));
      for (const name of others) {
        assert.ok(!r.fields.includes(`name="${name}"`), `${tpe}/${lang} must NOT render ${name}`);
      }
      assert.ok(!r.fields.includes("botbuilder."), `${tpe}/${lang} must not leak bare i18n keys`);
    }
  }
  assert.equal(renderGatewayFields("glasses", {}, "en"), null, "device-bound types are not extracted");
});

test("render: saved values round-trip into the form (save → re-render lossless)", () => {
  const gw = normalizeGatewayFields("discord", {
    gw_token: "sekret", gw_guild_id: "g1", gw_channel_ids: "c1\nc2", gw_allowlist: "u1\nu2",
  })[0];
  const r = renderGatewayFields("discord", gw, "en");
  assert.ok(r.fields.includes('value="sekret"'), "token re-emitted");
  assert.ok(r.fields.includes("c1\nc2"), "channel ids re-emitted as lines");
  assert.ok(r.fields.includes("u1\nu2"), "allowlist re-emitted as lines");
});

// ---- required fields (spec §D4 honesty asymmetry) ----

test("required fields: gmail fail-closed needs address+allowlist; others token-only", () => {
  assert.deepEqual(GATEWAY_REQUIRED_FIELDS.gmail, ["address", "allowlist"]);
  assert.deepEqual(GATEWAY_REQUIRED_FIELDS.discord, ["token"]);
  assert.deepEqual(GATEWAY_REQUIRED_FIELDS.telegram, ["token"]);
  assert.deepEqual(GATEWAY_REQUIRED_FIELDS.slack, ["bot_token", "app_token"]);
  assert.deepEqual(GATEWAY_REQUIRED_FIELDS["crow-messages"], []);
  assert.deepEqual(GATEWAY_REQUIRED_FIELDS.none, []);
});

test("missingGatewayFields: gmail with empty allowlist is incomplete (deaf-bot guard)", () => {
  assert.deepEqual(
    missingGatewayFields({ type: "gmail", address: "a@b.com", allowlist: [] }),
    ["allowlist"]);
  assert.deepEqual(
    missingGatewayFields({ type: "gmail", address: "", allowlist: ["x@y.com"] }),
    ["address"]);
  assert.deepEqual(
    missingGatewayFields({ type: "gmail", address: "a@b.com", allowlist: ["x@y.com"] }),
    []);
  // discord's allowlist fails OPEN — token alone is complete.
  assert.deepEqual(missingGatewayFields({ type: "discord", token: "t", allowlist: [] }), []);
  assert.deepEqual(missingGatewayFields({ type: "discord", token: "" }), ["token"]);
  // unknown types: no claims.
  assert.deepEqual(missingGatewayFields({ type: "signal" }), []);
  assert.deepEqual(missingGatewayFields(null), []);
});

// ---- crow-messages normalize moved here; api-handlers re-export intact ----

test("buildCrowMessagesGatewayConfig lives here and stays re-exported from api-handlers", async () => {
  const gw = buildCrowMessagesGatewayConfig({ gw_allow_paired_instances: "on", gw_description: " hi " });
  assert.deepEqual(gw, { type: "crow-messages", allow_paired_instances: true, description: "hi" });
  const api = await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js");
  assert.equal(api.buildCrowMessagesGatewayConfig, buildCrowMessagesGatewayConfig, "re-export must be the same function");
});
