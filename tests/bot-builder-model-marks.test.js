// tests/bot-builder-model-marks.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModelOptions } from "../servers/gateway/dashboard/panels/bot-builder/data-queries.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const db = {
  execute: async () => ({ rows: [
    { id: "crow-chat", base_url: "http://x/llm/p/crow-chat/v1", models: JSON.stringify([{ id: "qwen3.6-35b-a3b" }]), disabled: 0 },
    { id: "Qwen Cloud", base_url: "https://y/v1", models: JSON.stringify([{ id: "qwen3.8-max" }]), disabled: 0 },
  ] }),
};

test("each option carries piKnown from pi's models.json (no spawn)", async () => {
  const { opts } = await loadModelOptions(db, { piKeysFn: () => new Set(["crow-chat/qwen3.6-35b-a3b"]) });
  const by = Object.fromEntries(opts.map((o) => [o.key, o.piKnown]));
  assert.equal(by["crow-chat/qwen3.6-35b-a3b"], true);
  assert.equal(by["Qwen Cloud/qwen3.8-max"], false);
});

test("an unreadable models.json leaves piKnown null (no false warnings)", async () => {
  const { opts } = await loadModelOptions(db, { piKeysFn: () => null });
  assert.ok(opts.every((o) => o.piKnown === null));
});

test("the mark string exists in en and es", () => {
  assert.equal(t("botbuilder.modelNotInEngine", "en"), "not available to the bot engine");
  assert.equal(t("botbuilder.modelNotInEngine", "es"), "no disponible para el motor de bots");
});

// Task 17 fix round 1: the marks follow the bridge's own mapping (pi_provider_id.mjs).
test("a consented cloud row is available through its crow-c-* door entry; a bare keyed built-in is not", async () => {
  const cdb = { execute: async () => ({ rows: [
    { id: "cloud-a", base_url: "https://api.example.com/v1", models: JSON.stringify([{ id: "c1" }]), disabled: 0 },
    { id: "openai", base_url: "https://api.openai.com/v1", models: JSON.stringify([{ id: "gpt-x" }]), disabled: 0 },
    { id: "OpenAI", base_url: "https://api.openai.com/v1", models: JSON.stringify([{ id: "gpt-y" }]), disabled: 0 },
  ] }) };
  const json = { providers: { "crow-c-cloud-a": { models: [{ id: "c1" }] } } };
  const keys = new Set(["crow-c-cloud-a/c1"]);
  const env = { HOME: "/home/u", CROW_HOME: "/home/u/.crow" };
  const { opts } = await loadModelOptions(cdb, { piKeysFn: () => keys, piModelsJsonFn: () => json, env });
  const by = Object.fromEntries(opts.map((o) => [o.key, o]));
  assert.equal(by["cloud-a/c1"].piKnown, true);
  assert.equal(by["cloud-a/c1"].provider, "cloud-a", "the option still names the row");
  assert.equal(by["openai/gpt-x"].piKnown, false);
  assert.equal(by["openai/gpt-x"].piReason, 'model "openai/gpt-x" is not available to the bot engine');
  assert.equal(by["OpenAI/gpt-y"].piKnown, false, "a case variant of a built-in too");
  // a co-hosted instance never maps onto the primary's door entries
  const r4 = await loadModelOptions(cdb, { piKeysFn: () => keys, piModelsJsonFn: () => json, env: { ...env, CROW_HOME: "/home/u/.crow-r4" } });
  assert.equal(r4.opts.find((o) => o.key === "cloud-a/c1").piKnown, false);
});

test("a bare built-in is refused even when models.json is unreadable", async () => {
  const cdb = { execute: async () => ({ rows: [{ id: "openai", base_url: "https://api.openai.com/v1", models: JSON.stringify([{ id: "gpt-x" }]), disabled: 0 }] }) };
  const { opts } = await loadModelOptions(cdb, { piKeysFn: () => null, piModelsJsonFn: () => null, env: { HOME: "/home/u", CROW_HOME: "/home/u/.crow" } });
  assert.equal(opts[0].piKnown, false);
});
