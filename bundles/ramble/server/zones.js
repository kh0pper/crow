/**
 * Ramble map zones (spec 2026-09-08 §2.1-§2.2).
 *
 *   unlocked — a cell the user physically stood in. Permanent, full detail.
 *   frontier — within `depth` cells of an unlocked one. A rolling PREVIEW that
 *              carries typed beacons only; it is never itself earned, because
 *              a persisting preview would retreat the fog faster than the user
 *              walks.
 *   fog      — everything else.
 *
 * The classification functions are pure — no database, no clock, no I/O — and
 * always scoped to a viewport, so cost is bounded by the bbox rather than by
 * how much ground the user has covered over the years. Two exports are not
 * pure and say so on the tin: `frontierDepth(db)` reads a setting, and
 * `gateForZones` takes an encoder.
 */
import { CELL7_RE, CELL7_LAT_STEP, CELL7_LON_STEP, cellsInBbox, MAX_NEST_CELLS } from "./nests.js";
import { encodeGeohash, decodeGeohash } from "./anchors.js";

export const FRONTIER_DEPTH_DEFAULT = 3;

/** The square ring of cells within `depth` of `cell`, centre excluded. [] for junk. */
export function neighborhood(cell, depth = FRONTIER_DEPTH_DEFAULT) {
  const d = Number.isInteger(depth) && depth > 0 ? depth : 0;
  if (d === 0 || typeof cell !== "string" || !CELL7_RE.test(cell)) return [];
  let centre;
  try { centre = decodeGeohash(cell); } catch { return []; }
  if (!centre || !Number.isFinite(centre.lat) || !Number.isFinite(centre.lon)) return [];
  const out = new Set();
  for (let dy = -d; dy <= d; dy++) {
    for (let dx = -d; dx <= d; dx++) {
      if (dx === 0 && dy === 0) continue;
      const lat = centre.lat + dy * CELL7_LAT_STEP;
      const lon = centre.lon + dx * CELL7_LON_STEP;
      if (lat > 90 || lat < -90) continue;              // no wrapping over the poles
      const wrapped = ((lon + 180) % 360 + 360) % 360 - 180;
      let c;
      try { c = encodeGeohash(lat, wrapped, 7); } catch { continue; }
      if (c !== cell && CELL7_RE.test(c)) out.add(c);
    }
  }
  return [...out];
}

/** "unlocked" | "frontier" | "fog" for one cell against the unlocked set. */
export function classifyCell(cell, unlocked, depth = FRONTIER_DEPTH_DEFAULT) {
  if (typeof cell !== "string" || !CELL7_RE.test(cell)) return "fog";
  const set = unlocked instanceof Set ? unlocked : new Set(unlocked || []);
  if (set.has(cell)) return "unlocked";
  for (const n of neighborhood(cell, depth)) if (set.has(n)) return "frontier";
  return "fog";
}

/** A cell's footprint, so the client never needs a geohash decoder. null for junk. */
export function cellBox(cell) {
  if (typeof cell !== "string" || !CELL7_RE.test(cell)) return null;
  let c;
  try { c = decodeGeohash(cell); } catch { return null; }
  if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return null;
  const halfLat = CELL7_LAT_STEP / 2, halfLon = CELL7_LON_STEP / 2;
  return { cell, south: c.lat - halfLat, west: c.lon - halfLon, north: c.lat + halfLat, east: c.lon + halfLon };
}

/**
 * Classify every cell in a viewport. Returns null when the bbox covers more
 * cells than we will compute (the same ceiling nests use), so the caller can
 * answer "zoom in" rather than melt. Fog is implicit: a cell in neither list.
 * Entries are footprints (see cellBox), which is what the map draws.
 */
export function classifyBbox(bbox, unlocked, { depth = FRONTIER_DEPTH_DEFAULT, max = MAX_NEST_CELLS } = {}) {
  let cells;
  try { cells = cellsInBbox(bbox, { max }); } catch { return null; }   // cellsInBbox THROWS on a malformed bbox
  if (!cells) return null;
  const set = unlocked instanceof Set ? unlocked : new Set(unlocked || []);
  const out = { unlocked: [], frontier: [] };
  if (set.size === 0) return out;

  // Expand OUTWARD from the unlocked cells once, rather than asking every cell
  // in the viewport who its neighbours are. The naive direction costs
  // |viewport| x (2d+1)^2 — measured at 61 ms of synchronous, event-loop-
  // blocking work for a 7921-cell viewport at depth 3, on every map settle.
  // This direction costs |unlocked near the viewport| x (2d+1)^2, which for a
  // handful of nearby cells is a few hundred operations.
  const frontier = new Set();
  for (const u of set) {
    for (const n of neighborhood(u, depth)) if (!set.has(n)) frontier.add(n);
  }

  for (const cell of cells) {
    const box = set.has(cell) ? cellBox(cell) : (frontier.has(cell) ? cellBox(cell) : null);
    if (!box) continue;
    if (set.has(cell)) out.unlocked.push(box); else out.frontier.push(box);
  }
  return out;
}
