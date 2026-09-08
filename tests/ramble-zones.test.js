/**
 * Spec 2026-09-08 §2.1-§2.2: three zones. A cell you stood in is UNLOCKED
 * forever; a cell within `frontier.depth` of one is FRONTIER (previewed, not
 * owned); everything else is FOG. Pure — no database, no clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { neighborhood, classifyCell, classifyBbox, cellBox, FRONTIER_DEPTH_DEFAULT } from "../bundles/ramble/server/zones.js";
import { CELL7_RE } from "../bundles/ramble/server/nests.js";
import { encodeGeohash, decodeGeohash } from "../bundles/ramble/server/anchors.js";

const HOME = "9vk79ed";

test("neighborhood: a square ring of real geohash-7 cells, excluding the centre", () => {
  assert.equal(FRONTIER_DEPTH_DEFAULT, 3);
  const d1 = neighborhood(HOME, 1);
  assert.equal(d1.length, 8, "depth 1 is the eight surrounding cells");
  assert.ok(!d1.includes(HOME), "the centre is not its own neighbour");
  for (const c of d1) assert.match(c, CELL7_RE, `${c} is a valid cell`);
  assert.equal(new Set(d1).size, d1.length, "no duplicates");

  assert.equal(neighborhood(HOME, 3).length, 48, "depth 3 is 7x7 minus the centre");
  assert.deepEqual(neighborhood(HOME, 0), [], "depth 0 has no frontier");
  assert.deepEqual(neighborhood("nope", 1), [], "a non-cell yields nothing");
  assert.deepEqual(neighborhood(null, 1), []);

  // The immediate neighbours really are adjacent on the ground.
  const here = decodeGeohash(HOME);
  for (const c of d1) {
    const there = decodeGeohash(c);
    assert.ok(Math.abs(there.lat - here.lat) < 0.01 && Math.abs(there.lon - here.lon) < 0.01,
      `${c} is next door, not across the world`);
  }
});

test("classifyCell: unlocked beats frontier beats fog", () => {
  const unlocked = new Set([HOME]);
  assert.equal(classifyCell(HOME, unlocked, 3), "unlocked");
  const near = neighborhood(HOME, 1)[0];
  assert.equal(classifyCell(near, unlocked, 3), "frontier");
  assert.equal(classifyCell(near, unlocked, 0), "fog", "depth 0 makes everything but home fog");
  assert.equal(classifyCell(encodeGeohash(0, 0, 7), unlocked, 3), "fog", "the other side of the planet");
  assert.equal(classifyCell(HOME, new Set(), 3), "fog", "nothing unlocked, nothing previewed");
  assert.equal(classifyCell("nope", unlocked, 3), "fog");
});

test("classifyBbox: returns the unlocked and frontier cells inside a viewport, and nothing else", () => {
  const here = decodeGeohash(HOME);
  const bbox = { south: here.lat - 0.01, west: here.lon - 0.01, north: here.lat + 0.01, east: here.lon + 0.01 };
  const out = classifyBbox(bbox, new Set([HOME]), { depth: 1 });
  assert.ok(out, "a small bbox is answerable");
  assert.deepEqual(out.unlocked.map((c) => c.cell), [HOME]);
  assert.equal(out.frontier.length, 8);
  assert.ok(!out.frontier.some((c) => c.cell === HOME), "a cell is never in both lists");
  for (const c of out.frontier) {
    assert.match(c.cell, CELL7_RE);
    // Every entry carries its footprint, so the client needs no geohash code.
    assert.ok(c.south < c.north && c.west < c.east, `${c.cell} has real bounds`);
  }
  const home = out.unlocked[0];
  assert.ok(home.south <= here.lat && here.lat <= home.north, "home's box contains home");
  assert.ok(home.west <= here.lon && here.lon <= home.east);

  assert.deepEqual(classifyBbox(bbox, new Set(), { depth: 3 }), { unlocked: [], frontier: [] },
    "no unlocked ground means no zones at all");
  assert.equal(cellBox("nope"), null);

  const world = { south: -80, west: -170, north: 80, east: 170 };
  assert.equal(classifyBbox(world, new Set([HOME]), { depth: 1 }), null, "too large to answer");
});

test("classifyBbox expands from the unlocked cells, so a wide viewport stays cheap", () => {
  // The naive direction (ask every viewport cell for its neighbours) costs
  // |viewport| x (2d+1)^2 and was measured at 61 ms for a 7921-cell viewport
  // at depth 3 (see the comment in zones.js). The correct direction costs
  // |unlocked near the viewport| x (2d+1)^2 -- one cell here, so ~48
  // operations, which is microseconds. 30 ms leaves a wide margin on both
  // sides (naive ~61 ms, correct <1 ms) without being flaky on a slow box.
  // Do not loosen this bound to "fix" a slow CI -- that puts the naive
  // direction back inside the pass window and the test stops catching it.
  const here = decodeGeohash(HOME);
  const NEAR_CEILING_SPAN = 0.12; // ~89 x 89 = 7921 cells, just under MAX_NEST_CELLS (8192)
  const wide = {
    south: here.lat - NEAR_CEILING_SPAN / 2,
    west: here.lon - NEAR_CEILING_SPAN / 2,
    north: here.lat + NEAR_CEILING_SPAN / 2,
    east: here.lon + NEAR_CEILING_SPAN / 2,
  };
  const started = Date.now();
  const out = classifyBbox(wide, new Set([HOME]), { depth: 3 });
  const elapsed = Date.now() - started;
  assert.ok(out, "a wide-but-legal viewport is answerable");
  assert.equal(out.unlocked.length, 1);
  assert.equal(out.frontier.length, 48, "one unlocked cell yields exactly its 48-cell ring, whatever the viewport");
  assert.ok(elapsed < 30, `classification is bounded by unlocked ground, not viewport size (took ${elapsed} ms)`);

  // The 48-cell ring is a property of the unlocked set, not of the viewport --
  // assert that directly, since (unlike timing) it doesn't depend on the
  // clock or the host's speed. A small viewport and a near-ceiling one must
  // agree.
  const small = { south: here.lat - 0.01, west: here.lon - 0.01, north: here.lat + 0.01, east: here.lon + 0.01 };
  const smallOut = classifyBbox(small, new Set([HOME]), { depth: 3 });
  assert.equal(smallOut.frontier.length, 48, "frontier size doesn't shrink for a small viewport");
  assert.equal(out.frontier.length, 48, "frontier size doesn't grow for a near-ceiling viewport");
});

test("neighborhood handles the antimeridian and a pole without throwing or duplicating", () => {
  // Antimeridian: candidates that fall past +180 must wrap to negative
  // longitude, not produce junk or drop below 8.
  const antimeridianCell = encodeGeohash(10, 179.999, 7);
  const wrapped = neighborhood(antimeridianCell, 1);
  assert.equal(wrapped.length, 8, "wrapping still yields all eight neighbours");
  assert.equal(new Set(wrapped).size, wrapped.length, "no duplicates from the wrap");
  for (const c of wrapped) assert.match(c, CELL7_RE, `${c} is a valid cell`);

  // Near a pole: candidates past +90 latitude are skipped, not wrapped over
  // the top, so the count drops below 8 -- but the exact count depends on
  // how close to the pole the cell sits, so only bound it, don't hard-code it.
  const poleCell = encodeGeohash(89.999, 0, 7);
  const nearPole = neighborhood(poleCell, 1);
  assert.ok(nearPole.length > 0 && nearPole.length < 8,
    `near the pole some neighbours are skipped, not wrapped (got ${nearPole.length})`);
  for (const c of nearPole) assert.match(c, CELL7_RE, `${c} is a valid cell`);
});

test("classifyBbox returns null rather than throwing on a malformed bbox", () => {
  assert.equal(classifyBbox({ south: "x", west: 0, north: 1, east: 1 }, new Set([HOME]), { depth: 1 }), null);
  assert.equal(classifyBbox(null, new Set([HOME]), { depth: 1 }), null);
});

test("classifyBbox only reports cells inside the viewport", () => {
  const here = decodeGeohash(HOME);
  // A viewport shifted well east of home: home is unlocked but off-screen.
  const bbox = { south: here.lat - 0.002, west: here.lon + 0.05, north: here.lat + 0.002, east: here.lon + 0.06 };
  const out = classifyBbox(bbox, new Set([HOME]), { depth: 3 });
  assert.deepEqual(out, { unlocked: [], frontier: [] }, "off-screen unlocked ground is not reported");
});
