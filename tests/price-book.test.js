import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRule } from "../servers/shared/price-book.js";

test("validateRule accepts a well-formed rule and normalizes it", () => {
  const v = validateRule({ provider_id: "crow-chat", provider_type: "", model_id: "", input: "0", output: "0" });
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.normalized, { provider_id: "crow-chat", provider_type: null, model_id: "*", input: 0, output: 0 });
});

test("validateRule rejects a negative rate", () => {
  const v = validateRule({ provider_type: "together", model_id: "x", input: "-1", output: "1" });
  assert.equal(v.ok, false);
  assert.equal(v.normalized, null);
  assert.ok(v.errors.some((e) => /input rate/i.test(e)));
});

test("validateRule rejects a non-numeric rate", () => {
  const v = validateRule({ provider_type: "together", model_id: "x", input: "abc", output: "1" });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /input rate/i.test(e)));
});

test("validateRule requires at least one of provider_id / provider_type", () => {
  const v = validateRule({ provider_id: "", provider_type: "", model_id: "x", input: "1", output: "1" });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /provider/i.test(e)));
});

test("validateRule defaults an empty model_id to '*'", () => {
  const v = validateRule({ provider_type: "together", model_id: "  ", input: "0.18", output: "0.18" });
  assert.equal(v.ok, true);
  assert.equal(v.normalized.model_id, "*");
  assert.equal(v.normalized.provider_id, null);
  assert.equal(v.normalized.input, 0.18);
});
