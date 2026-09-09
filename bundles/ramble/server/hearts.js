/**
 * Heart containers (spec 2026-09-08 §2.3, §3, D6).
 *
 * The rare currency. A heart raises the bird's MAXIMUM energy and does nothing
 * else — the Zelda mapping D6 names: seed buys gear, hearts only extend the
 * bar. There is no spend path in this phase.
 *
 * WHERE A HEART IS is a hash of the cell, copying nestFor and seedFor: the
 * answer is identical on every one of the user's devices with nothing stored
 * and nothing to sync, and it cannot be re-rolled by leaving and coming back.
 * Two independent sources, two independent salts:
 *
 *   - the FIRST heart, keyed by the bare cell, once ever, roughly 1 in
 *     `heart.rate` cells. This is the one a new unlock can surprise you with.
 *   - a WILD heart, keyed `cell:window`, in ground already unlocked, roughly
 *     1 in `heart.wild.rate` cells per `heart.wild.days` window. §2.3 accepts
 *     that this makes maximum energy grindable by a heavy walker: it is not
 *     competitive power, only a longer buffer, and it lets someone who cannot
 *     range far still progress.
 *
 * ⚠ ONE RULE, TWO READERS. `heartCandidates` is the ONLY place that decides
 * whether a cell holds a heart. The map (availableHearts) and the payout
 * (recordHeartPickup) both go through it. Phase 1 shipped a seed layer where
 * the map and the payout disagreed and had to fix it; this module exists in
 * this shape so that cannot happen again.
 *
 * ⚠ A HEART ROW'S `delta` IS ALWAYS 1 — a count of containers, never an
 * energy amount. applyRambleWallet resolves conflicts with MAX(delta), which
 * is only convergent when the value cannot differ between instances for the
 * same key; a constant cannot disagree. Storing energy would also freeze
 * `energy.max.per.heart` into history and make retuning it a no-op.
 */
import { createHash } from "node:crypto";
import { CELL7_RE } from "./nests.js";
import { decodeGeohash } from "./anchors.js";

export const HEART_KIND = "heart";
export const HEART_SALT = "ramble-heart-v1:";
export const HEART_WILD_SALT = "ramble-heart-wild-v1:";

export const HEART_RATE_DEFAULT = 3;
export const HEART_WILD_DAYS_DEFAULT = 30;
export const HEART_WILD_RATE_DEFAULT = 40;
export const ENERGY_MAX_BASE_DEFAULT = 100;
export const ENERGY_MAX_PER_HEART_DEFAULT = 10;
export const ENERGY_MAX_CAP_DEFAULT = 300;

/** Which regrowth window `now` falls in. Same cell, same window = one wild heart. */
export function wildWindow(now, days) {
  const d = Number.isFinite(Number(days)) && Number(days) >= 1 ? Number(days) : HEART_WILD_DAYS_DEFAULT;
  return Math.floor(Number(now) / (d * 24 * 3600 * 1000));
}

/**
 * The shared body: hash `salt + material`, keep 1 in `rate`, and place the
 * result at a hash-derived point INSIDE the cell rather than at its centre, so
 * a street's worth of hearts does not line up like a pegboard.
 */
function place(salt, material, rate, fallbackRate, cell, key, source) {
  if (typeof cell !== "string" || !CELL7_RE.test(cell)) return null;
  const r = Number.isInteger(rate) && rate >= 1 ? rate : fallbackRate;
  const h = createHash("sha256").update(salt + material).digest();
  if (h.readUInt32BE(0) % r !== 0) return null;
  let c;
  try { c = decodeGeohash(cell); } catch { return null; }
  if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return null;
  const fy = h.readUInt32BE(4) / 0x100000000;
  const fx = h.readUInt32BE(8) / 0x100000000;
  return {
    cell, key, source,
    lat: c.lat - c.latErr + fy * 2 * c.latErr,
    lon: c.lon - c.lonErr + fx * 2 * c.lonErr,
  };
}

/** The once-ever heart in this cell, or null. Keyed by the bare cell. */
export function heartFor(cell, { rate = HEART_RATE_DEFAULT } = {}) {
  return place(HEART_SALT, String(cell), rate, HEART_RATE_DEFAULT, cell, String(cell), "first");
}

/** The regrowing heart in this cell in this window, or null. Keyed `cell:window`. */
export function wildHeartFor(cell, window, { wildRate = HEART_WILD_RATE_DEFAULT } = {}) {
  if (!Number.isFinite(Number(window))) return null;
  const w = Number(window);
  return place(HEART_WILD_SALT, String(cell) + ":" + String(w), wildRate, HEART_WILD_RATE_DEFAULT,
    cell, String(cell) + ":" + String(w), "wild");
}

/**
 * THE ONE RULE. Every heart this cell could hold right now, in priority order.
 *
 * The permanent heart is offered first when both hit: it is the rarer of the
 * two and it disappears forever once taken, so handing it over first is
 * strictly better for the player. The wild heart comes round again next window.
 *
 * ⚠ RETURNS BOTH, and deliberately. The obvious `heartFor(...) || wildHeartFor(...)`
 * short-circuits: once a cell's permanent heart is in the ledger, that version
 * keeps returning the taken spot and never consults the wild source, so at the
 * default rate one cell in three would be sterile for wild hearts FOREVER —
 * while this very comment promised it "comes round again". The callers, which
 * are the only things that know what has been taken, pick the first candidate
 * that is still there.
 */
export function heartCandidates(cell, window, { rate = HEART_RATE_DEFAULT, wildRate = HEART_WILD_RATE_DEFAULT } = {}) {
  const out = [];
  const first = heartFor(cell, { rate });
  if (first) out.push(first);
  const wild = wildHeartFor(cell, window, { wildRate });
  if (wild) out.push(wild);
  return out;
}

/** Live settings (spec §6.4 plus the two deviations). Junk or a negative falls back. */
export async function readHeartSettings(db) {
  const out = {
    rate: HEART_RATE_DEFAULT,
    wildDays: HEART_WILD_DAYS_DEFAULT,
    wildRate: HEART_WILD_RATE_DEFAULT,
    energyBase: ENERGY_MAX_BASE_DEFAULT,
    perHeart: ENERGY_MAX_PER_HEART_DEFAULT,
    cap: ENERGY_MAX_CAP_DEFAULT,
  };
  try {
    const { rows } = await db.execute({
      sql: `SELECT key, value FROM ramble_settings WHERE key IN
            ('heart.rate', 'heart.wild.days', 'heart.wild.rate',
             'energy.max.base', 'energy.max.per.heart', 'energy.max.cap')`,
      args: [],
    });
    for (const r of rows || []) {
      const n = parseInt(r.value, 10);
      if (!Number.isInteger(n)) continue;
      if (r.key === "heart.rate" && n >= 1) out.rate = n;
      if (r.key === "heart.wild.days" && n >= 1) out.wildDays = n;
      if (r.key === "heart.wild.rate" && n >= 1) out.wildRate = n;
      if (r.key === "energy.max.base" && n >= 1) out.energyBase = n;
      // >= 1, not >= 0: a zero would make every heart inert while the pet page
      // went on counting them.
      if (r.key === "energy.max.per.heart" && n >= 1) out.perHeart = n;
      if (r.key === "energy.max.cap" && n >= 1) out.cap = n;
    }
  } catch { /* defaults */ }
  // A cap below the base would clamp a heartless bird's energy DOWN, which is
  // a punishment no setting in this design is allowed to hand out.
  if (out.cap < out.energyBase) out.cap = out.energyBase;
  return out;
}
