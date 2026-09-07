import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeGeohash, decodeGeohash, haversineMeters, withinRange, saltedLanId, cellStepDegrees, cellsCoveringBbox } from "../bundles/ramble/server/anchors.js";
import { cellsInBbox, CELL7_LAT_STEP, CELL7_LON_STEP } from "../bundles/ramble/server/nests.js";

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

test("cellStepDegrees: 5 bits per char, longitude takes the odd bit (precision 7 matches nests.js)", () => {
  assert.deepEqual(cellStepDegrees(7), { latStep: CELL7_LAT_STEP, lonStep: CELL7_LON_STEP });
  const p6 = cellStepDegrees(6);
  assert.ok(Math.abs(p6.latStep - 180 / 2 ** 15) < 1e-12);
  assert.ok(Math.abs(p6.lonStep - 360 / 2 ** 15) < 1e-12);
  const p5 = cellStepDegrees(5);
  assert.ok(Math.abs(p5.latStep - 180 / 2 ** 12) < 1e-12);
  assert.ok(Math.abs(p5.lonStep - 360 / 2 ** 13) < 1e-12);
  assert.throws(() => cellStepDegrees(0));
  assert.throws(() => cellStepDegrees(13));
});

test("cellsCoveringBbox: precision 7 agrees with nests.js cellsInBbox; a ~1 km box is a handful of 5-char cells; too wide is null", () => {
  const bbox = { south: 30.4555, west: -98.0852, north: 30.4645, east: -98.0748 }; // ~1 km around 30.46/-98.08
  assert.deepEqual(cellsCoveringBbox(bbox, 7, { max: 8192 }), cellsInBbox(bbox));
  const five = cellsCoveringBbox(bbox, 5);
  assert.ok(five.includes("9v6m2"), "the point's own 5-char cell is in the cover");
  assert.ok(five.length >= 1 && five.length <= 4, `a 1 km box spans at most 2x2 5-char cells, got ${five.length}`);
  for (const c of five) assert.equal(c.length, 5);
  assert.equal(cellsCoveringBbox({ south: 0, west: 0, north: 10, east: 10 }, 7, { max: 64 }), null);
  assert.throws(() => cellsCoveringBbox({ south: 1, west: 0, north: 0, east: 1 }, 5));
  assert.throws(() => cellsCoveringBbox({ south: "a" }, 5));
});
