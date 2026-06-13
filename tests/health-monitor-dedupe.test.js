/**
 * health-monitor-dedupe.test.js
 *
 * Tests for the pure shouldNotify() dedupe function.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldNotify, pruneResolved } from "../servers/gateway/dashboard/panels/nest/health-signals.js";

const ONE_HOUR = 60 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * ONE_HOUR;

test("shouldNotify: issue not in lastMap → true (first time)", () => {
  assert.equal(shouldNotify({}, "disk", Date.now()), true);
});

test("shouldNotify: issue notified < 24h ago → false", () => {
  const now = 1_000_000_000;
  const lastMap = { disk: now - TWENTY_FOUR_HOURS + ONE_HOUR }; // 23h ago
  assert.equal(shouldNotify(lastMap, "disk", now), false);
});

test("shouldNotify: issue notified exactly 24h ago → true", () => {
  const now = 1_000_000_000;
  const lastMap = { disk: now - TWENTY_FOUR_HOURS };
  assert.equal(shouldNotify(lastMap, "disk", now), true);
});

test("shouldNotify: issue notified > 24h ago → true", () => {
  const now = 1_000_000_000;
  const lastMap = { disk: now - TWENTY_FOUR_HOURS - ONE_HOUR }; // 25h ago
  assert.equal(shouldNotify(lastMap, "disk", now), true);
});

test("shouldNotify: different issueId is independent", () => {
  const now = 1_000_000_000;
  const lastMap = { disk: now - ONE_HOUR }; // disk notified 1h ago
  assert.equal(shouldNotify(lastMap, "disk", now), false);
  assert.equal(shouldNotify(lastMap, "backup", now), true);
});

test("shouldNotify: empty lastMap, multiple issues → all true", () => {
  const now = Date.now();
  for (const id of ["disk", "storage", "agents", "peers", "updates", "backup"]) {
    assert.equal(shouldNotify({}, id, now), true, `${id} should be notifiable on empty map`);
  }
});

test("shouldNotify: custom windowMs overrides the 24h default", () => {
  const now = 1_000_000_000;
  const lastMap = { logins: now - 5000 };
  assert.equal(shouldNotify(lastMap, "logins", now, 10_000), false, "within custom window");
  assert.equal(shouldNotify(lastMap, "logins", now, 1000), true, "past custom window");
});

test("pruneResolved: a resolved issue's marker is dropped so recurrence re-notifies", () => {
  const lastMap = { backup: 100, disk: 200 };
  // backup resolved (not in active list), disk still active
  const pruned = pruneResolved(lastMap, ["disk"]);
  assert.deepEqual(pruned, { disk: 200 });
  // a recurring backup warn is now notifiable again
  assert.equal(shouldNotify(pruned, "backup", 999_999_999), true);
});

test("pruneResolved: warn→info downgrade keeps the marker (same incident)", () => {
  const lastMap = { logins: 500 };
  // logins still present (now info) → still active → marker kept
  const pruned = pruneResolved(lastMap, ["logins"]);
  assert.deepEqual(pruned, { logins: 500 });
});
