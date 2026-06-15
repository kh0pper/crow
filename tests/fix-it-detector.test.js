import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFriendlyName } from "../servers/gateway/fix-it/friendly-names.js";

test("friendly-name map: known id, addon fallback, raw fallback", () => {
  assert.equal(resolveFriendlyName("funkwhale"), "Music");
  assert.equal(resolveFriendlyName("crow-memory"), "Memory");
  assert.equal(resolveFriendlyName("some-addon", "Weather Station"), "Weather Station");
  assert.equal(resolveFriendlyName("some-addon"), "some-addon");
  assert.equal(resolveFriendlyName(null), "this feature");
});
