/**
 * N1b-8: where a rate-limited peer-exposure request is recorded.
 *
 * A denial that does not earn a card (see peer-card-policy.js) is still
 * COUNTED — otherwise a peer retrying in a loop would leave no trace at all.
 * Local-only JSON setting, keyed "<peerId>|<capability>", no schema change.
 */
import { readSetting, writeSetting } from "../dashboard/settings/registry.js";
import { normalizePeerId } from "../../shared/peer-id.js";

/** Local-only (never-synced) setting key. */
export const PEER_CARD_SUPPRESSED_KEY = "peer_exposure_card_suppressed";

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
    const prev = counts.get(key);
    counts.set(key, { count: (prev?.count || 0) + 1, lastAt: new Date(now).toISOString(), reason });
    const obj = Object.create(null);
    for (const [k, v] of counts) obj[k] = { count: v.count, last_at: v.lastAt, reason: v.reason };
    await writeSetting(db, PEER_CARD_SUPPRESSED_KEY, JSON.stringify(obj), { scope: "local" });
    return { ok: true, key, count: counts.get(key).count };
  });
  writeChain = run.then(() => {}, () => {});
  return run;
}