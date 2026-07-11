/**
 * Settings-scope coherence D6 — the auto-update TIMER re-reads
 * auto_update_enabled each tick (post-D1 the UI toggle lands in the global
 * row this module reads), so disable takes effect within one interval,
 * WITHOUT gating checkForUpdates() itself (the manual "Check now" button
 * calls it directly and must keep working when auto-update is disabled —
 * R1 MAJOR-1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tickCheck, _setDbForTest } from "../servers/gateway/auto-update.js";

function stubDb(enabledValue) {
  return {
    execute: async () => ({
      rows: enabledValue === undefined ? [] : [{ key: "auto_update_enabled", value: enabledValue }],
    }),
  };
}

test("tick gate: disabled → injected check NOT called, returns null", async () => {
  _setDbForTest(stubDb("false"));
  let called = 0;
  const out = await tickCheck(async () => { called++; return { ran: true }; });
  assert.equal(called, 0, "tick must skip when disabled");
  assert.equal(out, null);
  _setDbForTest(null);
});

test("tick gate: enabled → injected check called", async () => {
  _setDbForTest(stubDb("true"));
  let called = 0;
  await tickCheck(async () => { called++; return { ran: true }; });
  assert.equal(called, 1);
  _setDbForTest(null);
});

test("tick gate: DB error → getSettings returns defaults (enabled) → proceeds (fail-open, spec D6)", async () => {
  _setDbForTest({ execute: async () => { throw new Error("db down"); } });
  let called = 0;
  await tickCheck(async () => { called++; });
  assert.equal(called, 1, "defaults have auto_update_enabled:'true' → tick proceeds");
  _setDbForTest(null);
});

test("tick gate: no rows at all (fresh install) → defaults → proceeds", async () => {
  _setDbForTest(stubDb(undefined));
  let called = 0;
  await tickCheck(async () => { called++; });
  assert.equal(called, 1);
  _setDbForTest(null);
});
