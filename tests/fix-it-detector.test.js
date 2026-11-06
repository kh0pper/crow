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

function fakeStore(items = []) {
  const created = [];
  const dupes = [];
  const suppressed = [];
  return {
    items, created, dupes, suppressed,
    listBySource: async () => items,
    upsertItem: async (i) => { created.push(i); return { id: created.length, notify: true }; },
    recordDuplicate: async (id) => { dupes.push(id); },
    recordSuppressed: async (info) => { suppressed.push(info); },
    resolveByKey: async () => {},
  };
}

test("detector creates one card scoped to the requesting peer, with the three durations", async () => {
  const s = fakeStore();
  await detector.onEvent("peer-exposure:denied",
    { capability: "funkwhale", requestingInstance: "peer-1", requestingInstanceName: "Glasses", toolName: "fw_play" }, s);
  assert.equal(s.created.length, 1);
  const it = s.created[0];
  assert.equal(it.source, "remote-exposure");
  assert.equal(it.dedupKey, "expose:funkwhale:peer-1");
  assert.match(it.title, /Glasses/);
  assert.match(it.title, /Music/);
  assert.equal(it.severity, "warn");
  // N1b-8: no more one-click "expose to everyone". Every remedy names the ONE
  // peer (its verified id) and a duration; 30 days is the default (first), and
  // each duration has its own actionId so the button the operator clicks is the
  // duration that is granted (the POST carries only action_id).
  assert.deepEqual(it.remedies.map((r) => r.label), [
    "Allow for 30 days", "Allow for 7 days", "Allow until I remove it",
  ]);
  assert.deepEqual(it.remedies.map((r) => r.actionId), [
    "expose-capability-30d", "expose-capability-7d", "expose-capability-forever",
  ]);
  assert.ok(it.remedies.every((r) => r.kind === "instant"));
  assert.ok(it.remedies.every((r) => r.args.capability === "funkwhale" && r.args.requestingInstance === "peer-1"));
  assert.deepEqual(it.remedies.map((r) => r.args.days), [30, 7, undefined]);
  assert.equal(it.remedies[2].args.untilRemoved, true);
  assert.equal(it.context.toolName, "fw_play");
  assert.equal(it.context.requestingInstance, "peer-1");
});

test("detector ignores a null-capability denial", async () => {
  const s = fakeStore();
  await detector.onEvent("peer-exposure:denied", { capability: null, requestingInstance: "peer-1" }, s);
  assert.equal(s.created.length, 0);
});

test("detector falls back to 'another device' when peer name absent", async () => {
  const s = fakeStore();
  await detector.onEvent("peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-1" }, s);
  assert.match(s.created[0].title, /another device/);
});

test("detector refuses a card for an identity that is not a verified peer id", async () => {
  for (const requestingInstance of [undefined, null, "", "My Glasses", "../../etc", "a b", { id: "peer-1" }, 42]) {
    const s = fakeStore();
    await detector.onEvent("peer-exposure:denied", { capability: "funkwhale", requestingInstance }, s);
    assert.equal(s.created.length, 0, `no card for ${JSON.stringify(requestingInstance)}`);
  }
});