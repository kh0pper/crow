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
    return haversineMeters({ lat: anchor.lat, lon: anchor.lon }, here) <= (anchor.accuracy_m || 75);
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
