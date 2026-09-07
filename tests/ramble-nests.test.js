import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { encodeGeohash, decodeGeohash } from "../bundles/ramble/server/anchors.js";
import {
  nestFor, cellsInBbox, nestsInCells,
  NEST_SALT, NEST_RATE_DEFAULT, MAX_NEST_CELLS, CELL7_LAT_STEP, CELL7_LON_STEP,
} from "../bundles/ramble/server/nests.js";

const WEEK = "2026-W37";

/** Walk north from a start point until nestFor says there is a nest. */
function findNestCell(week, rate = NEST_RATE_DEFAULT) {
  for (let i = 0; i < 2000; i++) {
    const cell = encodeGeohash(30.46 + i * CELL7_LAT_STEP, -98.08, 7);
    if (nestFor(cell, week, { rate })) return cell;
  }
  throw new Error("no nest found in 2000 cells — the hash or the rate is broken");
}

test("nestFor is the spec's exact formula: salt, sha256, uint32 mod rate, offsets inside the cell", () => {
  const cell = findNestCell(WEEK);
  const nest = nestFor(cell, WEEK);
  const h = createHash("sha256").update(NEST_SALT + cell + ":" + WEEK).digest();
  assert.equal(h.readUInt32BE(0) % NEST_RATE_DEFAULT, 0);
  const { lat, lon, latErr, lonErr } = decodeGeohash(cell);
  assert.ok(Math.abs(nest.lat - (lat - latErr + (h.readUInt32BE(4) / 2 ** 32) * 2 * latErr)) < 1e-12);
  assert.ok(Math.abs(nest.lon - (lon - lonErr + (h.readUInt32BE(8) / 2 ** 32) * 2 * lonErr)) < 1e-12);
  assert.equal(nest.seed, h.readUInt32BE(12));
  assert.equal(nest.cell, cell); assert.equal(nest.week, WEEK);
  // The point never leaves its own cell (the claim path re-derives the cell from it).
  assert.equal(encodeGeohash(nest.lat, nest.lon, 7), cell);
});

test("same inputs -> same nest on two 'devices'; a different week re-rolls", () => {
  const cell = findNestCell(WEEK);
  assert.deepEqual(nestFor(cell, WEEK), nestFor(cell, WEEK));
  let differs = false;
  for (let w = 1; w <= 52 && !differs; w++) {
    const other = nestFor(cell, "2026-W" + String(w).padStart(2, "0"));
    if (!other || other.seed !== nestFor(cell, WEEK).seed) differs = true;
  }
  assert.ok(differs, "every week rolled the identical nest");
});

test("rate is honoured: about 1 nest per `rate` cells, and rate 1 means every cell", () => {
  const cells = [];
  for (let i = 0; i < 2400; i++) cells.push(encodeGeohash(30.46 + i * CELL7_LAT_STEP, -98.08, 7));
  const n24 = nestsInCells(cells, WEEK).length;
  assert.ok(n24 > 50 && n24 < 150, `expected ~100 nests in 2400 cells at rate 24, got ${n24}`);
  assert.equal(nestsInCells(cells, WEEK, { rate: 1 }).length, cells.length);
  assert.equal(nestFor(cells[0], WEEK, { rate: 0 }), nestFor(cells[0], WEEK), "a bad rate falls back to the default");
});

test("nestFor rejects a non-7 cell and a malformed week", () => {
  assert.throws(() => nestFor("9v6m2", WEEK));
  assert.throws(() => nestFor("9v6m21h", "week 37"));
  assert.throws(() => nestFor("9v6m21H", WEEK));
});

test("cellsInBbox covers exactly the intersecting cells and refuses a cover wider than max", () => {
  const c = decodeGeohash("9v6m21h");
  const tiny = { south: c.lat - c.latErr / 2, west: c.lon - c.lonErr / 2, north: c.lat + c.latErr / 2, east: c.lon + c.lonErr / 2 };
  assert.deepEqual(cellsInBbox(tiny), ["9v6m21h"]);

  // ~3 x 3 cells around the centre: every cell touching the box, no duplicates.
  const box = { south: c.lat - 1.2 * 2 * c.latErr, west: c.lon - 1.2 * 2 * c.lonErr, north: c.lat + 1.2 * 2 * c.latErr, east: c.lon + 1.2 * 2 * c.lonErr };
  const cells = cellsInBbox(box);
  assert.equal(new Set(cells).size, cells.length);
  assert.ok(cells.includes("9v6m21h"));
  assert.ok(cells.length >= 9 && cells.length <= 16, `got ${cells.length}`);
  for (const cell of cells) {
    const d = decodeGeohash(cell);
    assert.ok(d.lat + d.latErr >= box.south && d.lat - d.latErr <= box.north, cell + " outside (lat)");
    assert.ok(d.lon + d.lonErr >= box.west && d.lon - d.lonErr <= box.east, cell + " outside (lon)");
  }

  const wide = { south: 30, west: -99, north: 30.2, east: -98.8 }; // ~146 x 146 cells
  assert.equal(cellsInBbox(wide), null, "the max check must run before any hashing");
  assert.ok(cellsInBbox(wide, { max: 10 ** 6 }).length > MAX_NEST_CELLS);
  assert.throws(() => cellsInBbox({ south: 1, west: 0, north: 0, east: 1 }));
  assert.throws(() => cellsInBbox({ south: "a", west: 0, north: 1, east: 1 }));
});

test("cellsInBbox clamps at the poles and the antimeridian instead of throwing", () => {
  assert.ok(Array.isArray(cellsInBbox({ south: 89.999, west: 179.999, north: 90, east: 180 })));
  assert.ok(Array.isArray(cellsInBbox({ south: -90, west: -180, north: -89.999, east: -179.999 })));
});
