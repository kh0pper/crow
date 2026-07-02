/**
 * health-monitor-noauth-skip.test.js
 *
 * QW1 (Crow Messages usability arc, Phase 0): a gateway started with
 * --no-auth must never run the W2 health monitor — it's never the primary
 * dashboard (e.g. grackle's loopback companion MCP bridge), so it shouldn't
 * evaluate its own --no-auth flag as an exposure warn and push "the password
 * requirement is turned off" notifications.
 *
 * Tests the pure decision function `shouldRunHealthMonitor({ env, noAuth })`
 * exported from servers/gateway/boot/post-listen.js.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldRunHealthMonitor } from "../servers/gateway/boot/post-listen.js";

test("shouldRunHealthMonitor: normal auth gateway, monitor not disabled → true", () => {
  assert.equal(shouldRunHealthMonitor({ env: {}, noAuth: false }), true);
});

test("shouldRunHealthMonitor: CROW_DISABLE_HEALTH_MONITOR=1 → false", () => {
  assert.equal(
    shouldRunHealthMonitor({ env: { CROW_DISABLE_HEALTH_MONITOR: "1" }, noAuth: false }),
    false
  );
});

test("shouldRunHealthMonitor: --no-auth gateway → false, even with monitor not disabled", () => {
  assert.equal(shouldRunHealthMonitor({ env: {}, noAuth: true }), false);
});

test("shouldRunHealthMonitor: --no-auth AND disabled → false", () => {
  assert.equal(
    shouldRunHealthMonitor({ env: { CROW_DISABLE_HEALTH_MONITOR: "1" }, noAuth: true }),
    false
  );
});
