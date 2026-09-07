/**
 * Ramble nests — deterministic spawn points in the world (spec §2.4).
 *
 * Pure: no db, no clock. A nest is a function of (geohash-7 cell, ISO week)
 * under a PUBLIC salt, so every device computes the same nests with no
 * server round trip and nothing to replicate. flock.js layers claims,
 * settings and the db on top; this file must stay importable in the browser
 * someday (phase 4 AR) and in tests without a db.
 */
import { createHash } from "node:crypto";
import { encodeGeohash, decodeGeohash } from "./anchors.js";

export const NEST_SALT = "ramble-nest-v1:";
export const NEST_RATE_DEFAULT = 24;
export const CELL7_RE = /^[0-9b-hjkmnp-z]{7}$/;
export const WEEK_RE = /^\d{4}-W\d{2}$/;
/** A geohash-7 cell is 17 lat bits by 18 lon bits (~153 m square). */
export const CELL7_LAT_STEP = 180 / 2 ** 17;
export const CELL7_LON_STEP = 360 / 2 ** 18;
/** Hard ceiling on cells one nests query may cover (8192 sha256 ~ 10 ms). */
export const MAX_NEST_CELLS = 8192;

function effectiveRate(rate) {
  return Number.isInteger(rate) && rate >= 1 ? rate : NEST_RATE_DEFAULT;
}

/**
 * The nest in `cell` during `week`, or null. h = sha256(salt + cell + ":" +
 * week); a nest exists iff the first uint32 mod rate is 0; its point is the
 * cell's SW corner plus hash-derived fractions of the cell's height/width,
 * so it is always strictly inside the cell; its art seed is the fourth uint32.
 */
export function nestFor(cell, week, { rate } = {}) {
  if (typeof cell !== "string" || !CELL7_RE.test(cell)) throw new Error("cell must be a 7-character geohash");
  if (typeof week !== "string" || !WEEK_RE.test(week)) throw new Error("week must look like 2026-W37");
  const h = createHash("sha256").update(NEST_SALT + cell + ":" + week).digest();
  if (h.readUInt32BE(0) % effectiveRate(rate) !== 0) return null;
  const { lat, lon, latErr, lonErr } = decodeGeohash(cell);
  const fy = h.readUInt32BE(4) / 0x100000000; // [0, 1)
  const fx = h.readUInt32BE(8) / 0x100000000;
  return {
    cell,
    week,
    lat: lat - latErr + fy * 2 * latErr,
    lon: lon - lonErr + fx * 2 * lonErr,
    seed: h.readUInt32BE(12),
  };
}

/**
 * Every geohash-7 cell that intersects the bbox, or null when the cover would
 * exceed `max` cells (the caller decides what "zoom in" looks like). Samples a
 * lattice one cell apart — that hits every cell at least once — then keeps a
 * cell only if its own bounds actually touch the box, so a box strictly inside
 * one cell yields exactly that cell.
 */
export function cellsInBbox(bbox, { max = MAX_NEST_CELLS } = {}) {
  const { south, west, north, east } = bbox || {};
  if (![south, west, north, east].every((v) => typeof v === "number" && Number.isFinite(v))) {
    throw new Error("bbox must be four finite numbers");
  }
  if (south > north || west > east) throw new Error("bbox must have south <= north and west <= east");
  const rows = Math.floor((north - south) / CELL7_LAT_STEP) + 2;
  const cols = Math.floor((east - west) / CELL7_LON_STEP) + 2;
  if (rows * cols > max) return null;
  const seen = new Set();
  const out = [];
  for (let i = 0; i < rows; i++) {
    const lat = Math.min(90, Math.max(-90, south + i * CELL7_LAT_STEP));
    for (let j = 0; j < cols; j++) {
      const lon = Math.min(180, Math.max(-180, west + j * CELL7_LON_STEP));
      const cell = encodeGeohash(lat, lon, 7);
      if (seen.has(cell)) continue;
      seen.add(cell);
      const d = decodeGeohash(cell);
      if (d.lat + d.latErr < south || d.lat - d.latErr > north) continue;
      if (d.lon + d.lonErr < west || d.lon - d.lonErr > east) continue;
      out.push(cell);
    }
  }
  return out;
}

/** The nests among `cells` for `week`, in input order. */
export function nestsInCells(cells, week, { rate } = {}) {
  const out = [];
  for (const cell of cells) {
    const nest = nestFor(cell, week, { rate });
    if (nest) out.push(nest);
  }
  return out;
}
