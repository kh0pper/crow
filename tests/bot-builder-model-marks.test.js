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
