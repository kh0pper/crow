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
import { CELL7_RE, CELL7_LAT_STEP, CELL7_LON_STEP } from "./nests.js";
import { encodeGeohash, decodeGeohash } from "./anchors.js";

export const FRONTIER_DEPTH_DEFAULT = 3;

/** The live `frontier.depth` setting (spec §6.4), default 3, floor 0. */
export async function frontierDepth(db) {
  try {
    const { rows } = await db.execute({ sql: "SELECT value FROM ramble_settings WHERE key = 'frontier.depth'", args: [] });
    const n = parseInt(rows?.[0]?.value, 10);
    return Number.isInteger(n) && n >= 0 ? n : FRONTIER_DEPTH_DEFAULT;
  } catch { return FRONTIER_DEPTH_DEFAULT; }
}

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
 * Which unlocked and frontier cells fall inside a viewport. Fog is implicit: a
 * cell in neither list. Entries are footprints (see cellBox), which is what
 * the map draws.
 *
 * ⚠ THIS ITERATES THE USER'S HISTORY, NOT THE VIEWPORT — deliberately, and it
 * is why there is no longer a size ceiling. The first version enumerated every
 * cell in the bbox and asked each whether it was unlocked, which made the cost
 * proportional to the ZOOM LEVEL and forced a MAX_NEST_CELLS ceiling; above it
 * the route answered "zoom in". That ceiling turned out to make the feature
 * unreachable: a player's revealed region grows past what a viewport shows at
 * the minimum zoom the ceiling allows, so they stand inside their own cleared
 * ground and can never see its edge (found live on 2026-09-08 — a 2749 m
 * revealed region against a 1611 m viewport at the old zoom floor).
 *
 * Expanding outward from the unlocked set instead costs |unlocked| x (2d+1)^2
 * regardless of zoom, and the output is bounded by how far the user has walked
 * rather than how far they have zoomed out. So fog can render at ANY zoom.
 */
export function classifyBbox(bbox, unlocked, { depth = FRONTIER_DEPTH_DEFAULT } = {}) {
  if (!bbox) return null;
  const { south, west, north, east } = bbox;
  if (![south, west, north, east].every((n) => Number.isFinite(Number(n)))) return null;
  const view = { south: Number(south), west: Number(west), north: Number(north), east: Number(east) };
  const set = unlocked instanceof Set ? unlocked : new Set(unlocked || []);
  const out = { unlocked: [], frontier: [] };
  if (set.size === 0) return out;

  const frontier = new Set();
  for (const u of set) {
    for (const n of neighborhood(u, depth)) if (!set.has(n)) frontier.add(n);
  }

  for (const cell of set) {
    const box = cellBox(cell);
    if (box && boxInView(box, view)) out.unlocked.push(box);
  }
  for (const cell of frontier) {
    const box = cellBox(cell);
    if (box && boxInView(box, view)) out.frontier.push(box);
  }
  return out;
}

/**
 * Merge horizontally adjacent footprints in each latitude row into single
 * rectangles.
 *
 * WHY: the wire used to be bounded by the viewport and is now bounded by how
 * far the user has walked, which is unbounded. Measured on a contiguous blob:
 * 5000 unlocked cells is 702 KB of JSON and 5000 hole rings for the client to
 * draw, on every map settle. People walk STREETS, so their cells come in long
 * horizontal and vertical runs — collapsing each row's run to one rectangle
 * turns that same blob into a few dozen boxes with identical geometry.
 *
 * The merged box drops `cell`: a run is not one cell. Callers that need cell
 * ids must read them BEFORE coalescing (the zones route does).
 */
export function coalesceBoxes(boxes) {
  const rows = new Map();
  for (const b of boxes || []) {
    if (!b) continue;
    // Row key off the integer grid index, never the float: two cells in the
    // same band can differ in the last bit after decode.
    const row = Math.round((b.south + 90) / CELL7_LAT_STEP);
    const col = Math.round((b.west + 180) / CELL7_LON_STEP);
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push({ col, box: b });
  }
  const out = [];
  for (const entries of rows.values()) {
    entries.sort((a, b) => a.col - b.col);
    let run = null;
    for (const e of entries) {
      if (run && e.col === run.lastCol + 1) {
        run.east = e.box.east;
        run.lastCol = e.col;
        continue;
      }
      if (run) out.push({ south: run.south, west: run.west, north: run.north, east: run.east });
      run = { south: e.box.south, west: e.box.west, north: e.box.north, east: e.box.east, lastCol: e.col };
    }
    if (run) out.push({ south: run.south, west: run.west, north: run.north, east: run.east });
  }
  return out;
}

/**
 * Does a cell footprint touch the viewport? The route rejects a bbox with
 * west > east before we ever see one, so there is no antimeridian-crossing
 * case to handle here — a crossing viewport is a 400, not a wrap.
 */
function boxInView(box, view) {
  return box.north >= view.south && box.south <= view.north
    && box.east >= view.west && box.west <= view.east;
}

/**
 * Fog the PUBLIC overlay (spec 2026-09-08 §2.1, D4, D5).
 *
 * Only a stranger's PUBLIC mark is gated, and public means `visibility ===
 * "public"` — not `origin`, which is "remote" for a contact's mark too. The
 * user's own rows (origin local or sync) and anything delivered by a contact
 * or a group (visibility "contacts") pass through whole in every zone:
 * contacts are geographically spread, and making a friend's mark depend on
 * visiting their neighbourhood would be absurd.
 *
 * A frontier row is rebuilt from scratch rather than deleted from, so a field
 * added upstream later cannot silently start leaking through a beacon.
 */
const BEACON_KINDS = new Set(["mark", "caw", "nest"]);

export function gateForZones(rows, { unlocked, depth = FRONTIER_DEPTH_DEFAULT, encode } = {}) {
  if (!Array.isArray(rows) || typeof encode !== "function") return [];
  const set = unlocked instanceof Set ? unlocked : new Set(unlocked || []);
  const out = [];
  for (const row of rows) {
    // ⚠ `origin` does NOT separate public from contact content: a
    // contact-delivered mark is also origin "remote" (delivery.js:136,144).
    // Only `visibility` does. `contact_name` is not a safe fallback either —
    // it comes from contactsByPubkey, which filters to unblocked FULL
    // contacts, so a pending, blocked or deleted contact's mark would be
    // misread as public and fogged off the user's own map (against D4).
    const isPublic = row && row.origin === "remote" && row.visibility === "public";
    if (!isPublic) { if (row) out.push(row); continue; }

    const lat = Number(row.lat ?? row.approx_lat);
    const lon = Number(row.lon ?? row.approx_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    let cell;
    try { cell = encode(lat, lon, 7); } catch { continue; }
    const zone = classifyCell(cell, set, depth);
    if (zone === "unlocked") { out.push(row); continue; }
    if (zone !== "frontier") continue;

    out.push({
      beacon: true,
      kind: BEACON_KINDS.has(row.kind) ? row.kind : "mark",
      lat,
      lon,
    });
  }
  return out;
}
