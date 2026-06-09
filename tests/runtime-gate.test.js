import { test } from "node:test";
import assert from "node:assert/strict";
import { botRuntimeEnabledSync, runtimeGate } from "../scripts/pi-bots/runtime-gate.mjs";

// Sync db stub mirroring readSetting's override-then-global resolution.
function dbWith(featureFlagsValue) {
  return {
    prepare(sql) {
      return {
        get() {
          if (/dashboard_settings_overrides/.test(sql)) return undefined;
          if (/FROM dashboard_settings\b/.test(sql)) return featureFlagsValue === undefined ? undefined : { value: featureFlagsValue };
          return undefined;
        },
      };
    },
  };
}

test("botRuntimeEnabledSync: explicit true/false wins", () => {
  assert.equal(botRuntimeEnabledSync(dbWith(JSON.stringify({ bot_runtime: true }))), true);
  assert.equal(botRuntimeEnabledSync(dbWith(JSON.stringify({ bot_runtime: false }))), false);
});

test("botRuntimeEnabledSync: malformed/absent → falls back to isMpaHost (env-driven)", () => {
  // No CROW_HOME/CROW_DATA_DIR pointing at .crow-mpa in the test env → false.
  assert.equal(botRuntimeEnabledSync(dbWith("not json")), false);
  assert.equal(botRuntimeEnabledSync(dbWith(undefined)), false);
});

test("botRuntimeEnabledSync: never throws on a broken db", () => {
  assert.equal(botRuntimeEnabledSync({ prepare() { throw new Error("boom"); } }), false);
});

test("runtimeGate: start() called when active at boot; stop() on active→inactive; start() on inactive→active", async () => {
  let active = true;
  const db = { /* unused: we inject the reader */ };
  const calls = [];
  const handle = runtimeGate(db, {
    start: () => calls.push("start"),
    stop: () => calls.push("stop"),
    pollMs: 10,
    _isActive: () => active, // test hook overrides botRuntimeEnabledSync
  });
  await new Promise((r) => setTimeout(r, 25)); // boot + at least one poll
  assert.deepEqual(calls, ["start"], "start once at boot, no churn while active");
  active = false;
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(calls, ["start", "stop"], "stop on active→inactive");
  active = true;
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(calls, ["start", "stop", "start"], "start again on inactive→active");
  handle.dispose();
});

test("runtimeGate: a throwing start() does not crash the gate (retries next poll)", async () => {
  let active = true, n = 0;
  const handle = runtimeGate({}, {
    start: () => { n++; if (n === 1) throw new Error("first fails"); },
    stop: () => {},
    pollMs: 10,
    _isActive: () => active,
  });
  await new Promise((r) => setTimeout(r, 35)); // boot (throws) + retries
  assert.ok(n >= 2, "start retried after throwing");
  handle.dispose();
});
