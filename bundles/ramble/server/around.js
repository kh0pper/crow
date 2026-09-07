/**
 * Ramble around — everything the AR view can point at, around a point
 * (spec §6): marks and caws from `ramble_marks` and this week's nests,
 * within `radiusM` of `here`.
 *
 * Rows are returned AS STORED — `listMarks` teasers included, so a locked
 * mark still carries no lat/lon here (the route decodes the cell centre into
 * approx_lat/approx_lon exactly as the map does). This module only adds
 * `distance_m` and drops what is out of range.
 *
 * A row with no exact anchor is located at its geohash cell centre and kept
 * when the CELL could hold a point inside the radius (distance to the centre
 * <= radius + the cell's half-diagonal). A 7-char teaser therefore measures
 * ~100 m at worst; a 5-char wire caw whose cell covers the user is listed
 * rather than given an invented position — the client shows those without a
 * direction.
 */
import { decodeGeohash, haversineMeters, cellsCoveringBbox } from "./anchors.js";
import { listMarks } from "./marks.js";
import { listNests } from "./flock.js";

export const AROUND_RADIUS_DEFAULT = 500;
export const AROUND_RADIUS_MIN = 50;
export const AROUND_RADIUS_MAX = 1000;
/**
 * Two covers, because `listMarks` matches by geohash PREFIX and the rows come
 * in two grains: marks with an exact anchor are stored at geohash-7, wire
 * caws only at their 5-char publish cell.
 *   fine   — the precision-7 cells the circle touches (~63 for 500 m): every
 *            exact-anchor row in range, and nothing outside the box, so the
 *            query's LIMIT can never starve a nearby mark;
 *   coarse — the precision-5 cells (1–4): only rows whose OWN geohash is that
 *            coarse are taken from this pass (the caws); everything finer was
 *            already answered by the fine pass.
 * Past ~84° latitude the fine cover overflows MAX_FINE_CELLS and the coarse
 * pass alone answers (bounded by LIST_LIMIT — accepted, nobody rambles there);
 * when even the coarse cover overflows the call is refused (`too-wide`).
 */
const FINE_PRECISION = 7;
const MAX_FINE_CELLS = 512;
const COVER_PRECISION = 5;
const MAX_COVER_CELLS = 64;
/**
 * The fine pass covers ~1 km square (an 8x9 lattice, ~63 cells): 5000 rows
 * there is far beyond anything real, so its LIMIT can never hide a nearby
 * mark. The coarse pass covers ~10 km x 8 km and keeps the map's own
 * bound; a genuine 5-char caw older than that cell's 500 newest rows is
 * missed — it would only ever have been a direction-less row (accepted).
 */
const FINE_LIST_LIMIT = 5000;
const LIST_LIMIT = 500;
const M_PER_DEG_LAT = 111320;

/** A bbox that contains the circle of `radiusM` around `here` (clamped, never wrapped). */
export function bboxAround(here, radiusM) {
  const dLat = radiusM / M_PER_DEG_LAT;
  // The floor only stops a division by zero AT the pole; a larger floor would
  // make the box too NARROW near it and silently miss marks east/west.
  const cosLat = Math.max(1e-6, Math.cos((here.lat * Math.PI) / 180));
  const dLon = radiusM / (M_PER_DEG_LAT * cosLat);
  return {
    south: Math.max(-90, here.lat - dLat),
    north: Math.min(90, here.lat + dLat),
    west: Math.max(-180, here.lon - dLon),
    east: Math.min(180, here.lon + dLon),
  };
}

/** Where a stored row is, for distance: the exact anchor, else the cell centre plus its half-diagonal as `err_m`. */
export function locate(row) {
  if (typeof row.lat === "number" && typeof row.lon === "number") return { lat: row.lat, lon: row.lon, err_m: 0 };
  if (typeof row.geohash !== "string" || row.geohash.length === 0) return null;
  try {
    const { lat, lon, latErr, lonErr } = decodeGeohash(row.geohash);
    return { lat, lon, err_m: haversineMeters({ lat, lon }, { lat: lat + latErr, lon: lon + lonErr }) };
  } catch {
    return null;
  }
}

export async function aroundPoint(db, { lat, lon, radiusM = AROUND_RADIUS_DEFAULT, now = Date.now() } = {}) {
  const here = { lat, lon };
  const radius = Math.min(AROUND_RADIUS_MAX, Math.max(AROUND_RADIUS_MIN, Number(radiusM) || AROUND_RADIUS_DEFAULT));
  const bbox = bboxAround(here, radius);
  const coarseCells = cellsCoveringBbox(bbox, COVER_PRECISION, { max: MAX_COVER_CELLS });
  if (!coarseCells) {
    // An empty `cells` would make listMarks drop the cell filter and scan the
    // newest 500 rows of the whole table — a wrong answer, not a slow one.
    const err = new Error("too far north or south for the AR view");
    err.code = "too-wide";
    throw err;
  }
  const fineCells = cellsCoveringBbox(bbox, FINE_PRECISION, { max: MAX_FINE_CELLS });
  const seen = new Set();
  const marks = [];
  const consider = (row) => {
    if (seen.has(row.mark_id)) return;
    const at = locate(row);
    if (!at) return;
    const d = haversineMeters(here, at);
    if (d > radius + at.err_m) return;
    seen.add(row.mark_id);
    marks.push({ ...row, distance_m: Math.round(d) });
  };
  if (fineCells) {
    for (const row of await listMarks(db, { cells: fineCells, limit: FINE_LIST_LIMIT })) consider(row);
  }
  for (const row of await listMarks(db, { cells: coarseCells, limit: LIST_LIMIT })) {
    // With a fine pass, only the coarse rows are new here; without one (high
    // latitude) everything is.
    if (fineCells && (typeof row.geohash !== "string" || row.geohash.length > COVER_PRECISION)) continue;
    consider(row);
  }
  marks.sort((a, b) => a.distance_m - b.distance_m);
  const nestsOut = await listNests(db, bbox, { now, from: here });
  const nests = (nestsOut?.nests ?? []).filter((n) => n.distance_m <= radius);
  return { here, radius_m: radius, week: nestsOut?.week ?? null, marks, nests };
}
