import { createHash } from "node:crypto";
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export function encodeGeohash(lat, lon, precision = 7) {
  let idx = 0, bit = 0, evenBit = true, geohash = "";
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  while (geohash.length < precision) {
    if (evenBit) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) { idx = (idx << 1) + 1; lonMin = mid; } else { idx = idx << 1; lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { idx = (idx << 1) + 1; latMin = mid; } else { idx = idx << 1; latMax = mid; }
    }
    evenBit = !evenBit;
    if (++bit === 5) { geohash += BASE32[idx]; bit = 0; idx = 0; }
  }
  return geohash;
}

/**
 * Inverse of `encodeGeohash`: the CENTRE of the cell a geohash names, plus the
 * cell's half-height/half-width in degrees.
 *
 * R18: a locked mark's teaser deliberately carries no lat/lon (reveal.js's
 * allowlist), only its coarse `geohash` -- so the map has nothing to pin unless
 * it can turn that cell back into a point. This gives it the cell centre and an
 * honest error radius; it never recovers the real anchor.
 */
export function decodeGeohash(geohash) {
  if (typeof geohash !== "string" || geohash.length === 0) throw new Error("geohash must be a non-empty string");
  let evenBit = true;
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  for (const ch of geohash.toLowerCase()) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error(`invalid geohash character: ${ch}`);
    for (let n = 4; n >= 0; n--) {
      const bit = (idx >> n) & 1;
      if (evenBit) {
        const mid = (lonMin + lonMax) / 2;
        if (bit === 1) lonMin = mid; else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit === 1) latMin = mid; else latMax = mid;
      }
      evenBit = !evenBit;
    }
  }
  return {
    lat: (latMin + latMax) / 2,
    lon: (lonMin + lonMax) / 2,
    latErr: (latMax - latMin) / 2,
    lonErr: (lonMax - lonMin) / 2,
  };
}

export function haversineMeters(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function withinRange(anchor, here) {
  // Fail closed on malformed anchors
  if (!anchor) return false;
  const validKinds = ["geo", "lan", "beacon", "fingerprint", "visual"];
  if (!validKinds.includes(anchor.anchor_kind)) return false;

  if (anchor.anchor_kind === "geo") {
    if (here == null || here.lat == null) return false;
    return haversineMeters({ lat: anchor.lat, lon: anchor.lon }, here) <= (anchor.accuracy_m ?? 75);
  }

  // For ref kinds (lan, beacon, fingerprint, visual): exact match on anchor_ref
  if (!anchor.anchor_ref || !here?.ref) return false;
  return here.ref === anchor.anchor_ref;
}

export function geohashNeighborsPrefix(geohash, precision) {
  // Phase 1: query the mark's own prefix cell. Neighbor expansion is added in phase 2.
  return [geohash.slice(0, precision)];
}

export function saltedLanId(bssid, salt) {
  return createHash("sha256").update(`${bssid}::${salt}`).digest("hex").slice(0, 32);
}

/** Cell height/width in degrees at `precision`: 5 bits per character, longitude takes the odd bit. */
export function cellStepDegrees(precision) {
  if (!Number.isInteger(precision) || precision < 1 || precision > 12) throw new Error("precision must be an integer 1..12");
  const bits = precision * 5;
  const lonBits = Math.ceil(bits / 2);
  const latBits = Math.floor(bits / 2);
  return { latStep: 180 / 2 ** latBits, lonStep: 360 / 2 ** lonBits };
}

/**
 * Every geohash cell at `precision` that intersects `bbox`, or null when the
 * cover would exceed `max` cells. The precision-general form of nests.js's
 * `cellsInBbox` (which is this at precision 7): sample a lattice one cell
 * apart — that hits every cell at least once — then keep a cell only if its
 * own bounds actually touch the box. Clamps at the poles/antimeridian; it
 * does not wrap across ±180.
 */
export function cellsCoveringBbox(bbox, precision, { max = 64 } = {}) {
  const { south, west, north, east } = bbox || {};
  if (![south, west, north, east].every((v) => typeof v === "number" && Number.isFinite(v))) {
    throw new Error("bbox must be four finite numbers");
  }
  if (south > north || west > east) throw new Error("bbox must have south <= north and west <= east");
  const { latStep, lonStep } = cellStepDegrees(precision);
  const rows = Math.floor((north - south) / latStep) + 2;
  const cols = Math.floor((east - west) / lonStep) + 2;
  if (rows * cols > max) return null;
  const seen = new Set();
  const out = [];
  for (let i = 0; i < rows; i++) {
    const lat = Math.min(90, Math.max(-90, south + i * latStep));
    for (let j = 0; j < cols; j++) {
      const lon = Math.min(180, Math.max(-180, west + j * lonStep));
      const cell = encodeGeohash(lat, lon, precision);
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
