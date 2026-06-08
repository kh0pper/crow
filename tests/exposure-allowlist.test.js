import { test } from "node:test";
import assert from "node:assert/strict";
import { getExposedCapabilities, EXPOSURE_SETTING_KEY } from "../servers/gateway/peer-exposure.js";

// Minimal db stub: returns whatever readSetting would read for the exposure key.
function dbReturning(value) {
  return {
    async execute({ sql }) {
      // readSetting checks overrides first, then dashboard_settings.
      // Return the value on the global-row query, empty on the override query.
      if (/dashboard_settings_overrides/.test(sql)) return { rows: [] };
      return { rows: value === undefined ? [] : [{ value }] };
    },
  };
}

test("parses a JSON array into a Set of canonical ids", async () => {
  const set = await getExposedCapabilities(dbReturning(JSON.stringify(["crow-memory", "texas-gov-data"])));
  assert.ok(set instanceof Set);
  assert.ok(set.has("crow-memory"));
  assert.ok(set.has("texas-gov-data"));
  assert.equal(set.size, 2);
});

test("absent setting → empty set (deny all)", async () => {
  const set = await getExposedCapabilities(dbReturning(undefined));
  assert.equal(set.size, 0);
});

test("malformed JSON → empty set (deny all)", async () => {
  const set = await getExposedCapabilities(dbReturning("{not json"));
  assert.equal(set.size, 0);
});

test("non-array JSON (object/string/number) → empty set", async () => {
  assert.equal((await getExposedCapabilities(dbReturning(JSON.stringify({ a: 1 })))).size, 0);
  assert.equal((await getExposedCapabilities(dbReturning(JSON.stringify("crow-memory")))).size, 0);
});

test("array with non-string / empty entries → only valid strings kept", async () => {
  const set = await getExposedCapabilities(dbReturning(JSON.stringify(["crow-memory", "", null, 5, "crow-blog"])));
  assert.deepEqual([...set].sort(), ["crow-blog", "crow-memory"]);
});

test("exposes the setting key constant", () => {
  assert.equal(EXPOSURE_SETTING_KEY, "remote_exposed_tools");
});
