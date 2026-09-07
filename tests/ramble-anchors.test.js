import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeGeohash, decodeGeohash, haversineMeters, withinRange, saltedLanId } from "../bundles/ramble/server/anchors.js";

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

test("an explicit 0 m accuracy is honoured, not replaced by the 75 m default", () => {
  // `|| 75` would treat 0 as "unset" and open a 75 m radius on an anchor whose
  // author asked for an exact point.
  const anchor = { anchor_kind: "geo", lat: 30.2672, lon: -97.7431, accuracy_m: 0 };
  assert.equal(withinRange(anchor, { lat: 30.2672, lon: -97.7431 }), true, "the exact point is in range");
  // ~1 m north (1e-5 deg latitude is ~1.11 m).
  assert.equal(withinRange(anchor, { lat: 30.26721, lon: -97.7431 }), false, "1 m away must be out of range");
});

test("saltedLanId is deterministic and hides the bssid", () => {
  const id = saltedLanId("aa:bb:cc:dd:ee:ff", "s1");
  assert.equal(id, saltedLanId("aa:bb:cc:dd:ee:ff", "s1"));
  assert.notEqual(id, "aa:bb:cc:dd:ee:ff");
});

test("withinRange fails closed on malformed anchors", () => {
  assert.equal(withinRange(null, { lat: 30, lon: -97 }), false);
  assert.equal(withinRange(undefined, { lat: 30, lon: -97 }), false);
  assert.equal(withinRange({}, { lat: 30, lon: -97 }), false);
  assert.equal(withinRange({ anchor_kind: "invalid" }, { lat: 30, lon: -97 }), false);
  assert.equal(withinRange({ anchor_kind: "beacon", anchor_ref: "" }, { ref: "abc" }), false);
  assert.equal(withinRange({ anchor_kind: "lan", anchor_ref: "abc" }, { ref: undefined }), false);
});

test("decodeGeohash returns the cell centre, close to the encoded point", () => {
  const g = encodeGeohash(30.2672, -97.7431, 7); // Austin
  const { lat, lon, latErr, lonErr } = decodeGeohash(g);
  assert.ok(Math.abs(lat - 30.2672) < 0.001, `lat off by ${Math.abs(lat - 30.2672)}`);
  assert.ok(Math.abs(lon - -97.7431) < 0.001, `lon off by ${Math.abs(lon - -97.7431)}`);
  // The true point must lie inside the decoded cell.
  assert.ok(Math.abs(lat - 30.2672) <= latErr);
  assert.ok(Math.abs(lon - -97.7431) <= lonErr);
});

test("decodeGeohash reports the cell half-size (a 5-char cell is ~0.022 deg tall)", () => {
  const { latErr, lonErr } = decodeGeohash(encodeGeohash(30.2672, -97.7431, 5));
  assert.ok(Math.abs(latErr - 0.022) < 0.001, `latErr ${latErr}`);
  assert.ok(Math.abs(lonErr - 0.022) < 0.001, `lonErr ${lonErr}`);
  // Coarser cells are strictly larger than finer ones.
  assert.ok(decodeGeohash(encodeGeohash(30.2672, -97.7431, 7)).latErr < latErr);
});

test("decodeGeohash rejects junk instead of guessing", () => {
  assert.throws(() => decodeGeohash(""), /non-empty/);
  assert.throws(() => decodeGeohash(null), /non-empty/);
  assert.throws(() => decodeGeohash("9v6a!"), /invalid geohash character/);
  // 'a', 'i', 'l', 'o' are not in the geohash base32 alphabet.
  assert.throws(() => decodeGeohash("9v6i2"), /invalid geohash character/);
});
