import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateCrowContext,
  generateCondensedContext,
  invalidateContextCache,
} from "../servers/memory/crow-context.js";

const SECTION_ROW = {
  id: 1, section_key: "identity", section_title: "Identity", content: "You are Crow.",
  enabled: 1, sort_order: 0, device_id: null, project_id: null,
};

function countingDb() {
  let calls = 0;
  return {
    get calls() { return calls; },
    async execute() { calls++; return { rows: [SECTION_ROW] }; },
  };
}

test("generateCrowContext caches within TTL and invalidates on demand", async () => {
  invalidateContextCache();
  const db = countingDb();
  await generateCrowContext(db, { includeDynamic: false, platform: "generic" });
  const after1 = db.calls;
  assert.ok(after1 > 0, "first call must hit the db");
  await generateCrowContext(db, { includeDynamic: false, platform: "generic" });
  assert.equal(db.calls, after1, "second call within TTL must not hit the db");
  invalidateContextCache();
  await generateCrowContext(db, { includeDynamic: false, platform: "generic" });
  assert.ok(db.calls > after1, "invalidation must force regeneration");
});

test("cache is keyed by options", async () => {
  invalidateContextCache();
  const db = countingDb();
  await generateCrowContext(db, { includeDynamic: false, platform: "generic" });
  const after1 = db.calls;
  await generateCrowContext(db, { includeDynamic: false, platform: "claude" });
  assert.ok(db.calls > after1, "different platform must not share a cache entry");
});

test("generateCondensedContext caches too, on its own keys", async () => {
  invalidateContextCache();
  const db = countingDb();
  await generateCondensedContext(db, { routerStyle: false });
  const after1 = db.calls;
  await generateCondensedContext(db, { routerStyle: false });
  assert.equal(db.calls, after1, "condensed: second call within TTL must not hit the db");
  await generateCondensedContext(db, { routerStyle: true });
  assert.ok(db.calls > after1, "condensed: routerStyle must key separately");
});
