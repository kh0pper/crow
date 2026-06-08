import { test } from "node:test";
import assert from "node:assert/strict";
import { botRuntimeActive } from "../servers/gateway/dashboard/panels/bot-runtime-flag.js";

// Minimal db stub: readSetting() does SELECT ... FROM dashboard_settings_overrides
// then dashboard_settings. Return our feature_flags value for both lookups.
function dbWith(flagsValue) {
  return {
    async execute({ sql }) {
      if (/dashboard_settings_overrides/.test(sql)) return { rows: [] };
      if (/dashboard_settings/.test(sql)) {
        return { rows: flagsValue == null ? [] : [{ value: flagsValue }] };
      }
      return { rows: [] };
    },
  };
}

test("explicit bot_runtime:true wins regardless of host", async () => {
  delete process.env.CROW_HOME; delete process.env.CROW_DATA_DIR;
  assert.equal(await botRuntimeActive(dbWith(JSON.stringify({ bot_runtime: true }))), true);
});

test("explicit bot_runtime:false wins", async () => {
  process.env.CROW_DATA_DIR = "/home/kh0pp/.crow-mpa/data"; // would otherwise be true
  assert.equal(await botRuntimeActive(dbWith(JSON.stringify({ bot_runtime: false }))), false);
  delete process.env.CROW_DATA_DIR;
});

test("no flag -> defaults to MPA host detection (general instance = false)", async () => {
  delete process.env.CROW_HOME; delete process.env.CROW_DATA_DIR;
  assert.equal(await botRuntimeActive(dbWith(null)), false);
});

test("no flag -> MPA host = true", async () => {
  process.env.CROW_HOME = "/home/kh0pp/.crow-mpa";
  assert.equal(await botRuntimeActive(dbWith(null)), true);
  delete process.env.CROW_HOME;
});
