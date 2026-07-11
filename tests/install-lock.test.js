import { test } from "node:test";
import assert from "node:assert/strict";
import { beginInstallSet, endInstallSet, isInstallSetRunning, _resetForTest } from "../servers/gateway/install-lock.js";
import { tickCheck } from "../servers/gateway/auto-update.js";

test("begin → running; end → not running", () => {
  _resetForTest();
  assert.equal(isInstallSetRunning(), false);
  beginInstallSet("home-server");
  assert.equal(isInstallSetRunning(), true);
  endInstallSet();
  assert.equal(isInstallSetRunning(), false);
});

test("a second begin while busy throws (the route turns this into a 409)", () => {
  _resetForTest();
  beginInstallSet("home-server");
  assert.throws(() => beginInstallSet("research"), /in progress/i);
  endInstallSet();
});

test("a leaked lock expires after the max-age backstop", () => {
  _resetForTest();
  beginInstallSet("home-server", { startedAt: Date.now() - 3 * 60 * 60 * 1000 }); // 3h ago
  assert.equal(isInstallSetRunning(), false, "a 3h-old lock must not wedge installs forever");
  _resetForTest();
});

test("the auto-update tick skips while a collection install is running", async () => {
  _resetForTest();
  beginInstallSet("home-server");
  let checked = false;
  const result = await tickCheck(async () => { checked = true; return { updated: true }; });
  assert.equal(checked, false, "auto-update must not pull+restart mid-collection-install");
  assert.equal(result, null);
  endInstallSet();
});
