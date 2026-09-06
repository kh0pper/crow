import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeGeohash, haversineMeters, withinRange, saltedLanId } from "../bundles/ramble/server/anchors.js";

test("geohash is stable + prefix-consistent", () => {
  const g = encodeGeohash(30.2672, -97.7431, 7); // Austin
  assert.equal(typeof g, "string");
  assert.equal(g.length, 7);
  assert.equal(encodeGeohash(30.2672, -97.7431, 5), g.slice(0, 5));
});

test("haversine ~ known distance", () => {
  const d = haversineMeters({ lat: 30.2672, lon: -97.7431 }, { lat: 30.2700, lon: -97.7431 });
  assert.ok(d > 280 && d < 340, `got ${d}`); // ~311 m
});

test("withinRange respects accuracy for geo, exact for lan", () => {
  const anchor = { anchor_kind: "geo", lat: 30.2672, lon: -97.7431, accuracy_m: 75 };
  assert.equal(withinRange(anchor, { lat: 30.2673, lon: -97.7431 }), true);
  assert.equal(withinRange(anchor, { lat: 30.2700, lon: -97.7431 }), false);
  const lan = { anchor_kind: "lan", anchor_ref: "abc" };
  assert.equal(withinRange(lan, { ref: "abc" }), true);
  assert.equal(withinRange(lan, { ref: "xyz" }), false);
});

test("saltedLanId is deterministic and hides the bssid", () => {
  const id = saltedLanId("aa:bb:cc:dd:ee:ff", "s1");
  assert.equal(id, saltedLanId("aa:bb:cc:dd:ee:ff", "s1"));
  assert.notEqual(id, "aa:bb:cc:dd:ee:ff");
});
