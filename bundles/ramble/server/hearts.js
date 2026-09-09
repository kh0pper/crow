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

/** Mirrors eggs.js's helper: an emit must never be able to fail the write. */
async function safeEmit(emit, table, op, row) {
  if (typeof emit !== "function") return;
  try { await emit(table, op, row); }
  catch (err) { try { console.warn(`[ramble] emit ${table} failed:`, err?.message); } catch {} }
}

/** Every heart key already taken. Bounded by the player's lifetime collection. */
async function takenKeys(db) {
  const { rows } = await db.execute({
    sql: "SELECT key FROM ramble_wallet WHERE kind = ?", args: [HEART_KIND],
  });
  return new Set((rows || []).map((r) => String(r.key)));
}

/**
 * Which of the ASKED cells are unlocked. Bounded by the question, not by the
 * player's history: `SELECT cell FROM ramble_cells` would be a second
 * unbounded full-table scan on every /zones request, and phase 1 already left
 * one of those behind in unlockedCellsNear. The caller has usually filtered to
 * unlocked ground already, but this stays fail-closed rather than trusting it.
 */
async function unlockedAmong(db, cells) {
  const out = new Set();
  // Chunked: a close-zoom viewport over a walked town can ask about more cells
  // than SQLite will bind at once, which is the same limit harvestableCells
  // avoids by matching on a key suffix instead.
  for (let i = 0; i < cells.length; i += 400) {
    const chunk = cells.slice(i, i + 400);
    const marks = chunk.map(() => "?").join(",");
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await db.execute({
      sql: `SELECT cell FROM ramble_cells WHERE cell IN (${marks})`, args: chunk,
    });
    for (const r of rows || []) out.add(String(r.cell));
  }
  return out;
}

/**
 * Take the heart in this cell, if there is one and it is still there.
 *
 * ⚠ FAIL CLOSED. The cell must already be in ramble_cells. A position fix
 * vaguer than `unlock.max.accuracy.m` is refused an unlock, and it must be
 * refused a heart on exactly the same grounds — otherwise a 2 km wifi fix pays
 * out in ground the user never entered. Checked HERE rather than trusted to
 * the caller, because this function is the payout.
 */
export async function recordHeartPickup(db, cell, { now = Date.now(), emit } = {}) {
  const none = { picked: false, amount: 0 };
  if (!db || typeof cell !== "string" || !CELL7_RE.test(cell)) return none;
  try {
    const { rows } = await db.execute({
      sql: "SELECT 1 AS ok FROM ramble_cells WHERE cell = ?", args: [cell],
    });
    if (!rows || rows.length === 0) return none;

    const { rate, wildDays, wildRate } = await readHeartSettings(db);
    // NOT `Number(now) || Date.now()` — that treats `now: 0` as falsy and
    // silently substitutes the real clock (the phase 1 note on this still holds).
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    // EVERY candidate, in priority order, not just the first: a cell whose
    // permanent heart was collected long ago must still be able to pay out its
    // wild one. The INSERT is the arbiter — whichever key is not yet in the
    // ledger is the one that pays.
    for (const spot of heartCandidates(cell, wildWindow(at, wildDays), { rate, wildRate })) {
      // eslint-disable-next-line no-await-in-loop
      const res = await db.execute({
        sql: `INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, 1, ?)
              ON CONFLICT(kind, key) DO NOTHING`,
        args: [HEART_KIND, spot.key, at],
      });
      if (Number(res.rowsAffected) === 0) continue;
      // eslint-disable-next-line no-await-in-loop
      await safeEmit(emit, "ramble_wallet", "insert",
        { kind: HEART_KIND, key: spot.key, delta: 1, created_at: at });
      return { picked: true, amount: 1, source: spot.source };
    }
    return none;
  } catch (err) {
    try { console.warn("[ramble] heart pickup failed:", err?.message); } catch {}
    return none;
  }
}

/**
 * Which of these cells still hold a heart to walk to.
 *
 * ⚠ THE SAME RULE THE PAYOUT USES. This goes through heartCandidates and takes
 * the first untaken one, exactly as recordHeartPickup does, and returns the
 * candidate object itself rather than a re-derived position — so the map cannot
 * drift from the payout. That drift is the hazard 0.9.5 closed for seed.
 *
 * Cells the caller has not unlocked are dropped even when they are asked for:
 * a heart in fog would be a preview of ground you have not earned (K3).
 */
export async function availableHearts(db, cells, { now = Date.now() } = {}) {
  const asked = (Array.from(cells || [])).filter((c) => typeof c === "string" && CELL7_RE.test(c));
  if (!db || asked.length === 0) return [];
  try {
    const { rate, wildDays, wildRate } = await readHeartSettings(db);
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const window = wildWindow(at, wildDays);
    const unlocked = await unlockedAmong(db, asked);
    const taken = await takenKeys(db);
    const out = [];
    for (const cell of asked) {
      if (!unlocked.has(cell)) continue;
      // The FIRST candidate still standing — the same choice recordHeartPickup
      // makes when it walks the list and lets the INSERT arbitrate.
      const spot = heartCandidates(cell, window, { rate, wildRate }).find((c) => !taken.has(c.key));
      if (spot) out.push(spot);
    }
    return out;
  } catch (err) {
    // A map that cannot say where a heart is should still draw. Never throw.
    try { console.warn("[ramble] availableHearts failed:", err?.message); } catch {}
    return [];
  }
}

/** How many containers the player holds. Every row is worth exactly one. */
export async function heartsBalance(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT COALESCE(SUM(delta), 0) AS total FROM ramble_wallet WHERE kind = ?",
      args: [HEART_KIND],
    });
    return Number(rows?.[0]?.total) || 0;
  } catch { return 0; }
}

/**
 * The bird's ceiling: the base plus one step per container, capped.
 *
 * DERIVED, never stored. A stored maximum would be a balance, and §6.1's whole
 * point is that a balance loses increments to last-writer-wins. It also means
 * retuning `energy.max.per.heart` retunes every existing player's bar, which is
 * what makes these numbers settings rather than a redesign.
 */
export async function maxEnergy(db) {
  try {
    const { energyBase, perHeart, cap } = await readHeartSettings(db);
    return Math.min(cap, energyBase + (await heartsBalance(db)) * perHeart);
  } catch { return ENERGY_MAX_BASE_DEFAULT; }
}
