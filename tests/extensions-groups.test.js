import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DISPLAY_GROUPS, groupForCategory, groupAddons } from "../servers/gateway/dashboard/panels/extensions/groups.js";

const REGISTRY = JSON.parse(
  readFileSync(new URL("../registry/add-ons.json", import.meta.url), "utf8"),
);

test("every category present in the real registry maps to a group", () => {
  const cats = new Set(REGISTRY["add-ons"].map((a) => a.category || "other"));
  const groupIds = new Set(DISPLAY_GROUPS.map((g) => g.id));
  for (const cat of cats) {
    const g = groupForCategory(cat);
    assert.ok(groupIds.has(g), `category '${cat}' mapped to unknown group '${g}'`);
  }
});

test("unknown / missing categories fall into 'more' (forward-compatible, never dropped)", () => {
  assert.equal(groupForCategory("quantum-teleportation"), "more");
  assert.equal(groupForCategory(undefined), "more");
  assert.equal(groupForCategory(""), "more");
});

test("no category is claimed by two groups", () => {
  const seen = new Map();
  for (const g of DISPLAY_GROUPS) {
    for (const c of g.categories) {
      assert.ok(!seen.has(c), `category '${c}' claimed by both '${seen.get(c)}' and '${g.id}'`);
      seen.set(c, g.id);
    }
  }
});

test("groupAddons buckets by group, preserves order, omits empty groups", () => {
  const addons = [
    { id: "a", category: "ai" },
    { id: "b", category: "media" },
    { id: "c", category: "ai" },
    { id: "d", category: "totally-made-up" },
  ];
  const grouped = groupAddons(addons);
  assert.deepEqual(grouped.get("ai").map((a) => a.id), ["a", "c"]);
  assert.deepEqual(grouped.get("media").map((a) => a.id), ["b"]);
  assert.deepEqual(grouped.get("more").map((a) => a.id), ["d"]);
  assert.equal(grouped.has("home-hardware"), false, "empty groups are omitted");
});

test("every group has an i18n label key", () => {
  for (const g of DISPLAY_GROUPS) {
    assert.match(g.labelKey, /^extensions\.group[A-Za-z]+$/, `bad labelKey on ${g.id}`);
  }
});
