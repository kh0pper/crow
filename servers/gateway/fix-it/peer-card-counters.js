/**
 * N1b-8: where a rate-limited peer-exposure request is recorded.
 *
 * A denial that does not earn a card (see peer-card-policy.js) is still
 * COUNTED — otherwise a peer retrying in a loop would leave no trace at all.
 * Local-only JSON setting, keyed "<peerId>|<capability>", no schema change.
 *
 * Bounded by construction (review round 1, B2): the key is built from a
 * canonical capability id that the peer-exposure gate matched against this
 * instance's own catalog, and a capability the gate could NOT match is counted
 * in ONE bucket per peer (`<peerId>|unknown`) — never under the peer's own
 * string. The map itself is capped too: entries older than
 * SUPPRESSED_COUNTER_WINDOW_MS are pruned on every write and, when the map is
 * still full, the oldest entry is evicted. So a peer cannot grow this setting
 * without bound, whatever it sends.
 */
import { readSetting, writeSetting } from "../dashboard/settings/registry.js";
import { normalizePeerId } from "../../shared/peer-id.js";

/** Local-only (never-synced) setting key. */
export const PEER_CARD_SUPPRESSED_KEY = "peer_exposure_card_suppressed";

/** The capability name used for every id the gate could not match (B2). */
export const UNKNOWN_CAPABILITY_BUCKET = "unknown";

/** Hard cap on the number of counter entries, across every peer. */
export const SUPPRESSED_COUNTER_MAX_ENTRIES = 500;

/** An entry untouched for this long is dropped on the next write. */
export const SUPPRESSED_COUNTER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Read the counters → Map<"<peerId>|<capability>", {count, last_at, reason}>. Never throws. */
export async function getSuppressedRequests(db) {
  let raw;
  try { raw = await readSetting(db, PEER_CARD_SUPPRESSED_KEY); } catch { return new Map(); }
  const out = new Map();
  if (raw == null) return out;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return out; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object") continue;
    out.set(key, {
      count: Number(value.count) || 0,
      lastAt: typeof value.last_at === "string" ? value.last_at : null,
      reason: typeof value.reason === "string" ? value.reason : null,
    });
  }
  return out;
}

/**
 * Drop every counter whose window has passed (or whose timestamp is
 * unreadable — an entry we cannot age is an entry we cannot bound).
 * Exported for tests.
 */
export function pruneSuppressedCounters(counts, now = Date.now()) {
  for (const [key, value] of counts) {
    const t = Date.parse(value?.lastAt || "");
    if (!Number.isFinite(t) || now - t > SUPPRESSED_COUNTER_WINDOW_MS) counts.delete(key);
  }
  return counts;
}

/**
 * Enforce the entry cap by evicting the least recently seen entries. Exported
 * for tests.
 */
export function capSuppressedCounters(counts, cap = SUPPRESSED_COUNTER_MAX_ENTRIES) {
  while (counts.size > cap) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, value] of counts) {
      const t = Date.parse(value?.lastAt || "");
      const at = Number.isFinite(t) ? t : -Infinity; // unreadable = oldest
      if (at < oldestAt) { oldestAt = at; oldestKey = key; }
    }
    if (oldestKey === null) break;
    counts.delete(oldestKey);
  }
  return counts;
}

let writeChain = Promise.resolve();

/**
 * Count one request that created no card.
 * @param {object} db
 * @param {{peerId: string, capability: string, reason?: string, now?: number}} info
 */
export async function recordSuppressedRequest(db, { peerId, capability, reason = null, now = Date.now() } = {}) {
  const id = normalizePeerId(peerId);
  if (!id) return { ok: false, error: "unknown_peer" };
  const cap = typeof capability === "string" ? capability.trim() : "";
  if (!cap) return { ok: false, error: "no_capability" };
  const key = `${id}|${cap}`;
  const run = writeChain.then(async () => {
    const counts = await getSuppressedRequests(db);
    pruneSuppressedCounters(counts, now);
    const prev = counts.get(key);
    counts.set(key, { count: (prev?.count || 0) + 1, lastAt: new Date(now).toISOString(), reason });
    capSuppressedCounters(counts);
    const obj = Object.create(null);
    for (const [k, v] of counts) obj[k] = { count: v.count, last_at: v.lastAt, reason: v.reason };
    await writeSetting(db, PEER_CARD_SUPPRESSED_KEY, JSON.stringify(obj), { scope: "local" });
    return { ok: true, key, count: counts.get(key)?.count ?? 0, entries: counts.size };
  });
  writeChain = run.then(() => {}, () => {});
  return run;
}