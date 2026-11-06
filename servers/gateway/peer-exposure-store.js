/**
 * F4a Layer 2a exposure storage — WHO may invoke WHAT on this instance.
 *
 * Two settings, both local-only (deliberately absent from sync-allowlist.js —
 * writeSetting downgrades them to local scope, so each instance is sovereign
 * over what it exposes):
 *
 *   1. `remote_exposed_tools`  — the legacy ALL-TRUSTED-PEERS allowlist: a flat
 *      JSON array of canonical capability ids. Unchanged by the N1b-8 fix; a
 *      capability listed here is invocable by every trusted peer, exactly as
 *      before. The Settings UI's checkbox list is this control, and it stays
 *      the operator's explicit "share with all my Crows" statement.
 *
 *   2. `remote_exposed_tools_by_peer` — N1b-8: PER-PEER grants, keyed by the
 *      VERIFIED peer instance id (never a name from a request body):
 *
 *        { "<peer instance id>": {
 *            "<canonical capability id>": {
 *              "expires_at": "2026-01-31T12:00:00.000Z" | null,  // null = until removed
 *              "granted_at": "2026-01-01T12:00:00.000Z"
 *            } } }
 *
 *      A Fix-it "Allow" card writes here only — it can no longer reach the
 *      all-peer list. Expiry is evaluated at check time (an expired grant is
 *      refused) but the row is KEPT, so Settings can show it as expired and
 *      renew or remove it.
 *
 * Storage decision (N1b-8): a JSON-backed settings value, NOT a table. The
 * exposure allowlist was already a local setting; keeping the per-peer grants in
 * the same place needs no schema change and no SCHEMA_GENERATION bump, and the
 * two shapes live side by side without migrating anything.
 *
 * This module is a leaf: it imports only the settings registry, so the Fix-it
 * detector/remedy and the Settings section can use it without pulling in
 * peer-exposure.js (which itself imports the Fix-it emitter).
 */
import { readSetting, writeSetting } from "./dashboard/settings/registry.js";
import { normalizePeerId } from "../shared/peer-id.js";

/** Local-only (never-synced) setting key for the all-trusted-peers allowlist. */
export const EXPOSURE_SETTING_KEY = "remote_exposed_tools";
/** Local-only setting key for the per-peer grants (N1b-8). */
export const PEER_EXPOSURE_SETTING_KEY = "remote_exposed_tools_by_peer";

const EMPTY_SET = new Set();

/**
 * Read the all-peer exposure allowlist → Set<canonicalId>. Tolerates
 * absent/malformed settings by returning an empty set (deny-all). Never throws.
 */
export async function getExposedCapabilities(db) {
  let raw;
  try { raw = await readSetting(db, EXPOSURE_SETTING_KEY); } catch { return new Set(); }
  if (raw == null) return new Set();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return new Set(); }
  if (!Array.isArray(parsed)) return new Set();
  return new Set(parsed.filter((x) => typeof x === "string" && x.length > 0));
}

/**
 * Parse the per-peer store → Map<peerId, Map<capability, {expiresAt, grantedAt}>>.
 * Tolerates absent/malformed input (deny-all) and drops anything that is not a
 * plain, id-shaped grant. Never throws.
 */
export function parsePeerExposures(raw) {
  const out = new Map();
  if (raw == null) return out;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return out; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [rawPeerId, grants] of Object.entries(parsed)) {
    const peerId = normalizePeerId(rawPeerId);
    if (!peerId) continue;
    if (!grants || typeof grants !== "object" || Array.isArray(grants)) continue;
    const caps = new Map();
    for (const [capability, grant] of Object.entries(grants)) {
      if (typeof capability !== "string" || capability.length === 0) continue;
      if (!grant || typeof grant !== "object" || Array.isArray(grant)) continue;
      const expiresAt = typeof grant.expires_at === "string" ? grant.expires_at : null;
      const grantedAt = typeof grant.granted_at === "string" ? grant.granted_at : null;
      caps.set(capability, { expiresAt, grantedAt });
    }
    if (caps.size > 0) out.set(peerId, caps);
  }
  return out;
}

/** Serialize the per-peer store (Map shape) back to the stored JSON. */
export function serializePeerExposures(exposures) {
  const obj = Object.create(null);
  for (const [peerId, caps] of exposures || []) {
    const out = Object.create(null);
    for (const [capability, grant] of caps) {
      out[capability] = { expires_at: grant?.expiresAt ?? null, granted_at: grant?.grantedAt ?? null };
    }
    obj[peerId] = out;
  }
  return JSON.stringify(obj);
}

/** Read every stored per-peer grant (including expired ones — Settings shows them). */
export async function getPeerExposures(db) {
  let raw;
  try { raw = await readSetting(db, PEER_EXPOSURE_SETTING_KEY); } catch { return new Map(); }
  return parsePeerExposures(raw);
}

/**
 * Is a stored grant still in force? `expires_at` null/absent = "until I remove
 * it" (never expires). A malformed timestamp fails CLOSED.
 */
export function grantIsActive(grant, now = Date.now()) {
  if (!grant || typeof grant !== "object") return false;
  if (grant.expiresAt == null) return true;
  const t = Date.parse(grant.expiresAt);
  if (!Number.isFinite(t)) return false;
  return t > now;
}

/**
 * The capabilities that peer is allowed to invoke RIGHT NOW: non-expired grants
 * only. Deny-all on a missing/unknown/ill-shaped peer id. Never throws.
 *
 * @param {object} db
 * @param {string} peerId verified peer instance id (req.instanceAuth.instance.id)
 * @param {{now?: number}} [opts] `now` is injected by tests for expiry
 */
export async function getPeerGrantedCapabilities(db, peerId, { now = Date.now() } = {}) {
  const id = normalizePeerId(peerId);
  if (!id) return EMPTY_SET;
  const grants = (await getPeerExposures(db)).get(id);
  if (!grants) return EMPTY_SET;
  const out = new Set();
  for (const [capability, grant] of grants) if (grantIsActive(grant, now)) out.add(capability);
  return out.size > 0 ? out : EMPTY_SET;
}

/** Per-call check: is `capability` granted to THIS peer and not expired? */
export async function isCapabilityExposedToPeer(db, capability, peerId, { now = Date.now() } = {}) {
  if (typeof capability !== "string" || capability.length === 0) return false;
  return (await getPeerGrantedCapabilities(db, peerId, { now })).has(capability);
}

/**
 * What ONE peer may invoke right now: the all-trusted-peers allowlist UNION that
 * peer's own active grants. Used where the catalog is served to a verified peer
 * (S2) — its Bot Builder must see a one-device allowance as exposed without
 * ever seeing anybody else's.
 *
 * Never throws. An ill-shaped peer id yields the all-peer set only.
 *
 * @param {object} db
 * @param {string} peerId verified peer instance id
 * @param {{now?: number}} [opts] injected clock (tests)
 * @returns {Promise<Set<string>>}
 */
export async function getExposureForPeer(db, peerId, { now = Date.now() } = {}) {
  const out = new Set();
  try { for (const cap of await getExposedCapabilities(db)) out.add(cap); } catch { /* deny-all for this half */ }
  try { for (const cap of await getPeerGrantedCapabilities(db, peerId, { now })) out.add(cap); } catch { /* deny-all for this half */ }
  return out;
}

// --- mutations -------------------------------------------------------------
// Read-modify-write on ONE settings key, serialized per process so two
// concurrent fixes cannot clobber each other's grant.
let writeChain = Promise.resolve();
function withStoreLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => {}, () => {});
  return run;
}

async function mutatePeerExposures(db, mutate) {
  return withStoreLock(async () => {
    const current = await getPeerExposures(db);
    const next = mutate(current) || current;
    await writeSetting(db, PEER_EXPOSURE_SETTING_KEY, serializePeerExposures(next), { scope: "local" });
    return next;
  });
}

function normalizeExpiry(expiresAt) {
  if (expiresAt == null) return { ok: true, expiresAt: null };
  const d = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (!Number.isFinite(d.getTime())) return { ok: false, expiresAt: null };
  return { ok: true, expiresAt: d.toISOString() };
}

/**
 * Grant ONE capability to ONE peer. `expiresAt` null = until removed.
 * @returns {Promise<{ok: boolean, error?: string, peerId?: string, capability?: string, expiresAt?: string|null}>}
 */
export async function grantPeerCapability(db, { peerId, capability, expiresAt = null, now = Date.now() } = {}) {
  const id = normalizePeerId(peerId);
  if (!id) return { ok: false, error: "unknown_peer" };
  const cap = typeof capability === "string" ? capability.trim() : "";
  if (!cap) return { ok: false, error: "no_capability" };
  const exp = normalizeExpiry(expiresAt);
  if (!exp.ok) return { ok: false, error: "bad_expiry" };
  await mutatePeerExposures(db, (all) => {
    const caps = all.get(id) || new Map();
    caps.set(cap, { expiresAt: exp.expiresAt, grantedAt: new Date(now).toISOString() });
    all.set(id, caps);
    return all;
  });
  return { ok: true, peerId: id, capability: cap, expiresAt: exp.expiresAt };
}

/**
 * Push one grant's expiry out by `days` from now ("Renew"), or make it
 * permanent with days = null.
 */
export async function renewPeerGrant(db, { peerId, capability, days = 30, now = Date.now() } = {}) {
  const id = normalizePeerId(peerId);
  if (!id) return { ok: false, error: "unknown_peer" };
  const cap = typeof capability === "string" ? capability.trim() : "";
  if (!cap) return { ok: false, error: "no_capability" };
  const n = Number(days);
  const expiresAt = days == null ? null
    : (Number.isFinite(n) && n > 0 ? new Date(now + n * 86_400_000).toISOString() : null);
  if (days != null && !expiresAt) return { ok: false, error: "bad_expiry" };
  let found = false;
  await mutatePeerExposures(db, (all) => {
    const caps = all.get(id);
    const grant = caps?.get(cap);
    if (!grant) return all;
    found = true;
    caps.set(cap, { expiresAt, grantedAt: grant.grantedAt });
    return all;
  });
  return found ? { ok: true, peerId: id, capability: cap, expiresAt } : { ok: false, error: "not_granted" };
}

/** Remove one peer's grant for one capability. */
export async function removePeerGrant(db, { peerId, capability } = {}) {
  const id = normalizePeerId(peerId);
  if (!id) return { ok: false, error: "unknown_peer" };
  const cap = typeof capability === "string" ? capability.trim() : "";
  if (!cap) return { ok: false, error: "no_capability" };
  let found = false;
  await mutatePeerExposures(db, (all) => {
    const caps = all.get(id);
    if (!caps || !caps.has(cap)) return all;
    found = true;
    caps.delete(cap);
    if (caps.size === 0) all.delete(id);
    return all;
  });
  return found ? { ok: true, peerId: id, capability: cap } : { ok: false, error: "not_granted" };
}

/**
 * Drop EVERY grant for one peer. Called when the peer is revoked or removed:
 * a revoked id must not come back with allowances attached if it is paired
 * again (a revoke→re-pair reuses the id). Goes through the same serialised
 * writer as every other mutation, and writes nothing when the peer has no
 * grants.
 *
 * @param {object} db
 * @param {{peerId: string}} args
 * @returns {Promise<{ok: boolean, peerId?: string, removed?: number, error?: string}>}
 */
export async function removePeerExposures(db, { peerId } = {}) {
  const id = normalizePeerId(peerId);
  if (!id) return { ok: false, error: "unknown_peer", removed: 0 };
  return withStoreLock(async () => {
    const current = await getPeerExposures(db);
    const caps = current.get(id);
    if (!caps) return { ok: true, peerId: id, removed: 0 };
    current.delete(id);
    await writeSetting(db, PEER_EXPOSURE_SETTING_KEY, serializePeerExposures(current), { scope: "local" });
    return { ok: true, peerId: id, removed: caps.size };
  });
}