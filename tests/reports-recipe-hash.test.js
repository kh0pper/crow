// The recipe hashes a report saves with: recipeHash names one exact recipe (canonical JSON, so key
// order does not matter and block order does), and sourcesHash names only the blocks the block
// registry calls source-bearing, failing closed on an unknown type and on no registry at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  MODEL_BLOCK_TYPES, canonicalJson, recipeCallsModel, recipeHash, sourcesHash,
} from "../servers/gateway/reports/recipe-hash.js";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function recipe(...blocks) {
  return { blocks };
}

/** A registry shaped the way a later PR's block registry will be. */
const REGISTRY = Object.freeze({
  mail_list: { sourceBearing: true },
  calendar: { sourceBearing: true },
  custom_step: { sourceBearing: true },
  ai_commentary: { sourceBearing: true },
  columns: { sourceBearing: false },
  sort: { sourceBearing: false },
  filter: { sourceBearing: false },
});

test("canonical JSON is key-sorted, whitespace-free and keeps array order", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: 2, b: 1 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson([2, 1]), "[2,1]");
  assert.equal(canonicalJson({ a: { d: 4, c: 3 }, b: [{ f: 6, e: 5 }] }),
    '{"a":{"c":3,"d":4},"b":[{"e":5,"f":6}]}');
  assert.equal(canonicalJson("a b"), '"a b"');
  assert.equal(canonicalJson(null), "null");
  assert.equal(canonicalJson(true), "true");
  assert.equal(canonicalJson(0), "0");
  assert.doesNotMatch(canonicalJson({ a: 1, b: [1, 2] }), /\s/);
});

test("canonical JSON refuses what JSON cannot carry faithfully", () => {
  for (const value of [undefined, () => {}, Symbol("s"), 1n, Number.NaN, Number.POSITIVE_INFINITY,
    { a: undefined }, [Number.NEGATIVE_INFINITY]]) {
    assert.throws(() => canonicalJson(value), { code: "bad_json" });
  }
});

test("the recipe hash ignores key order and follows block order", () => {
  const one = recipe({ type: "mail_list", settings: { account: "ma-1", label: "Inbox", sinceDays: 7 } });
  const reorderedKeys = recipe({
    settings: { sinceDays: 7, label: "Inbox", account: "ma-1" }, type: "mail_list",
  });
  assert.equal(recipeHash(one), recipeHash(reorderedKeys));
  assert.match(recipeHash(one), /^[0-9a-f]{64}$/);
  assert.equal(recipeHash(one), sha(canonicalJson(one)));

  const twoBlocks = recipe(
    { type: "mail_list", settings: { label: "Inbox" } },
    { type: "calendar", settings: { calendar: "primary" } },
  );
  const swapped = recipe(
    { type: "calendar", settings: { calendar: "primary" } },
    { type: "mail_list", settings: { label: "Inbox" } },
  );
  assert.notEqual(recipeHash(twoBlocks), recipeHash(swapped), "the recipe is an ordered list");
  assert.notEqual(sourcesHash(twoBlocks, REGISTRY), sourcesHash(swapped, REGISTRY),
    "and so is the source hash");
});

test("sourcesHash fails closed when there is no registry", () => {
  const r = recipe(
    { type: "mail_list", settings: { label: "Inbox" } },
    { type: "columns", settings: { columns: ["subject"] } },
  );
  const all = sha(canonicalJson(r.blocks));
  for (const registry of [undefined, null, {}]) {
    assert.equal(sourcesHash(r, registry), all, "every block counts with no registry to ask");
  }
  assert.equal(sourcesHash(recipe(), undefined), sha("[]"), "no blocks, one empty hash");
});

test("sourcesHash leaves out a block the registry says is not source-bearing", () => {
  const source = { type: "mail_list", settings: { label: "Inbox", sinceDays: 7 } };
  const present = { type: "columns", settings: { columns: ["subject", "date"] } };
  const r = recipe(source, present);
  assert.equal(sourcesHash(r, REGISTRY), sha(canonicalJson([source])),
    "only the source block is hashed");
  // A free change to the present block does not move the source hash, but does move the recipe hash.
  const changedPresent = recipe(source, { type: "columns", settings: { columns: ["subject"] } });
  assert.equal(sourcesHash(changedPresent, REGISTRY), sourcesHash(r, REGISTRY));
  assert.notEqual(recipeHash(changedPresent), recipeHash(r));
  // A change to the source block's own settings does move it.
  const changedSource = recipe({ ...source, settings: { label: "Archive", sinceDays: 7 } }, present);
  assert.notEqual(sourcesHash(changedSource, REGISTRY), sourcesHash(r, REGISTRY));
});

test("a block type the registry does not know counts as source-bearing", () => {
  const known = { type: "mail_list", settings: { label: "Inbox" } };
  const unknown = { type: "something_new", settings: { url: "https://api.example.test/x" } };
  const r = recipe(known, unknown);
  assert.equal(sourcesHash(r, REGISTRY), sha(canonicalJson([known, unknown])));
  // An entry that says nothing about sourceBearing is not an approval to leave the block out.
  assert.equal(
    sourcesHash(r, { ...REGISTRY, something_new: {} }),
    sha(canonicalJson([known])),
    "only an explicit sourceBearing: true makes a block free",
  );
  // A block whose type is an Object.prototype key borrows nothing.
  const proto = recipe({ type: "constructor", settings: {} });
  assert.equal(sourcesHash(proto, REGISTRY), sha(canonicalJson(proto.blocks)));
});

test("a model-calling block is source-bearing in the registry", () => {
  for (const type of MODEL_BLOCK_TYPES) {
    const r = recipe({ type, settings: { prompt: "say something" } });
    assert.equal(sourcesHash(r, REGISTRY), sha(canonicalJson(r.blocks)),
      `${type} is source-bearing, settings included`);
  }
  assert.deepEqual([...MODEL_BLOCK_TYPES], ["ai_commentary", "annotate"]);
  assert.ok(Object.isFrozen(MODEL_BLOCK_TYPES));
});

test("a recipe that is not a recipe throws bad_recipe", () => {
  for (const bad of [null, undefined, [], "recipe", 42, {}, { blocks: null }, { blocks: {} },
    { blocks: "[]" }, { blocks: [null] }, { blocks: [[]] }, { blocks: [{ settings: {} }] },
    { blocks: [{ type: "" }] }, { blocks: [{ type: 7 }] }, { blocks: [{ type: "ok" }, { type: null }] }]) {
    assert.throws(() => recipeHash(bad), { code: "bad_recipe" });
    assert.throws(() => sourcesHash(bad, REGISTRY), { code: "bad_recipe" });
    assert.throws(() => recipeCallsModel(bad, 0), { code: "bad_recipe" });
  }
});

test("recipeCallsModel follows the switch and the block types", () => {
  const plain = recipe({ type: "mail_list", settings: { label: "Inbox" } });
  assert.equal(recipeCallsModel(plain, 0), false);
  assert.equal(recipeCallsModel(plain, undefined), false);
  assert.equal(recipeCallsModel(plain, null), false);
  assert.equal(recipeCallsModel(plain, false), false);
  assert.equal(recipeCallsModel(plain, 1), true, "the AI switch alone calls a model");
  assert.equal(recipeCallsModel(plain, true), true);
  assert.equal(recipeCallsModel(recipe({ type: "ai_commentary", settings: {} }), 0), true);
  assert.equal(recipeCallsModel(recipe({ type: "annotate", settings: {} }), 0), true);
  assert.equal(recipeCallsModel(recipe({ type: "columns", settings: {} }), 0), false);
  assert.equal(recipeCallsModel(recipe(), 0), false);
});