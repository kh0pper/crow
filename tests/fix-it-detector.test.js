import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFriendlyName } from "../servers/gateway/fix-it/friendly-names.js";
import detector from "../servers/gateway/fix-it/detectors/remote-exposure.js";

test("friendly-name map: known id, addon fallback, raw fallback", () => {
  assert.equal(resolveFriendlyName("funkwhale"), "Music");
  assert.equal(resolveFriendlyName("crow-memory"), "Memory");
  assert.equal(resolveFriendlyName("some-addon", "Weather Station"), "Weather Station");
  assert.equal(resolveFriendlyName("some-addon"), "some-addon");
  assert.equal(resolveFriendlyName(null), "this feature");
});

function fakeStore() {
  const items = [];
  return { items, upsertItem: async (i) => { items.push(i); return { id: items.length, notify: true }; }, resolveByKey: async () => {} };
}

test("detector creates one card with friendly title + Allow remedy", async () => {
  const s = fakeStore();
  await detector.onEvent("peer-exposure:denied",
    { capability: "funkwhale", requestingInstance: "peer-1", requestingInstanceName: "Glasses", toolName: "fw_play" }, s);
  assert.equal(s.items.length, 1);
  const it = s.items[0];
  assert.equal(it.source, "remote-exposure");
  assert.equal(it.dedupKey, "expose:funkwhale:peer-1");
  assert.match(it.title, /Glasses/);
  assert.match(it.title, /Music/);
  assert.equal(it.severity, "warn");
  assert.deepEqual(it.remedies, [{ label: "Allow", actionId: "expose-capability", args: { capability: "funkwhale" }, kind: "instant" }]);
  assert.equal(it.context.toolName, "fw_play");
});

test("detector ignores a null-capability denial", async () => {
  const s = fakeStore();
  await detector.onEvent("peer-exposure:denied", { capability: null, requestingInstance: "peer-1" }, s);
  assert.equal(s.items.length, 0);
});

test("detector falls back to 'another device' when peer name absent", async () => {
  const s = fakeStore();
  await detector.onEvent("peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-1" }, s);
  assert.match(s.items[0].title, /another device/);
});
