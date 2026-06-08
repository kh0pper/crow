import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
// NOTE: botRuntimeActive -> readSetting -> getOrCreateLocalInstanceId() touches
// the host's instance registry on import; that's fine here (tests run on a
// configured Crow host with ~/.crow). The db stub below intercepts the actual
// settings query.
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

// Always restore a clean env after each test, even if an assertion throws.
afterEach(() => {
  delete process.env.CROW_HOME;
  delete process.env.CROW_DATA_DIR;
});

test("explicit bot_runtime:true wins regardless of host", async () => {
  assert.equal(await botRuntimeActive(dbWith(JSON.stringify({ bot_runtime: true }))), true);
});

test("explicit bot_runtime:false wins", async () => {
  process.env.CROW_DATA_DIR = "/home/kh0pp/.crow-mpa/data"; // would otherwise be true
  assert.equal(await botRuntimeActive(dbWith(JSON.stringify({ bot_runtime: false }))), false);
});

test("no flag -> defaults to MPA host detection (general instance = false)", async () => {
  assert.equal(await botRuntimeActive(dbWith(null)), false);
});

test("no flag -> MPA host = true", async () => {
  process.env.CROW_HOME = "/home/kh0pp/.crow-mpa";
  assert.equal(await botRuntimeActive(dbWith(null)), true);
});
