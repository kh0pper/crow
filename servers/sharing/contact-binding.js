/**
 * Contact binding for Hyperswarm handshakes (PT-3).
 *
 * Helpers the PeerManager verifier builds on: the channel-binding message,
 * the per-contact "has bound" pin, the pinned-key lookup, the admission
 * decision table, and a bounded refusal-log limiter. See the private
 * engineering notes for the design.
 */

import { crowIdMatchesKey } from "./identity.js";

/** LOCAL dashboard_settings_overrides key prefix: `<prefix><crowId>` (value >= 1). Never synced. */
export const CB_PIN_PREFIX = "contact_hs_cb:";

/**
 * Whether the per-contact pin is enforced (decision Q-K4). Dropping pins is a
 * one-constant change: false makes isCbPinned always false.
 */
export const CB_PIN_ENFORCED = true;

/** LOCAL key `<prefix><ourCrowId>`: some sibling instance has bound (proved our key with a cb_sig). */
export const INSTANCE_CB_PIN_PREFIX = "instance_hs_cb:";

/**
 * The string a responder signs to bind a challenge to one connection.
 * `role` is the SIGNER's end of the Noise stream ("init" or "resp"): the two
 * ends of one connection sign different strings, so neither end's cb_sig can
 * stand in for the other's. The `/` and newlines keep it disjoint from every
 * other ed25519-signed string in the tree (64-hex nonces, `cr-resp:`,
 * `cr-proof:`, `addr:`, hello).
 */
export function contactCbMessage({ role, signerCrowId, challengeHex, handshakeHashHex }) {
  if (role !== "init" && role !== "resp") throw new TypeError('contactCbMessage: role must be "init" or "resp"');
  for (const v of [signerCrowId, challengeHex, handshakeHashHex]) {
    if (typeof v !== "string") throw new TypeError("contactCbMessage: fields must be strings");
    if (v.includes("\n")) throw new Error("contactCbMessage: field contains a newline");
  }
  return `crow/hs-contact-cb/v1\n${role}\n${signerCrowId}\n${challengeHex}\n${handshakeHashHex}`;
}

const pinKey = (crowId) => `${CB_PIN_PREFIX}${crowId}`;

/**
 * Has this contact ever bound? Fails CLOSED (true) on a missing local id or a
 * read error; only a missing table (an old DB) means "not pinned".
 */
export async function isCbPinned(db, localId, crowId, { enforced = CB_PIN_ENFORCED } = {}) {
  if (!enforced) return false;
  return readPin(db, localId, pinKey(crowId));
}

/** Record that `crowId` bound. No write without a local id. True when newly written. */
export async function markCbPinned(db, localId, crowId, { enforced = CB_PIN_ENFORCED } = {}) {
  if (!enforced) return false;
  return writePin(db, localId, pinKey(crowId));
}

/** Has any sibling of `ownCrowId` bound? Same fail-closed rules as isCbPinned. */
export async function isInstanceCbPinned(db, localId, ownCrowId) {
  return readPin(db, localId, `${INSTANCE_CB_PIN_PREFIX}${ownCrowId}`);
}

/** Record that a sibling bound. No write without a local id. True when newly written. */
export async function markInstanceCbPinned(db, localId, ownCrowId) {
  return writePin(db, localId, `${INSTANCE_CB_PIN_PREFIX}${ownCrowId}`);
}

/**
 * Read a LOCAL dashboard_settings_overrides pin (value >= 1). Fails CLOSED
 * (true) on a missing local id or a read error; only a missing table (an old
 * DB) means "not pinned". Shared with sync-pair-binding.js.
 */
export async function readPin(db, localId, key) {
  if (!localId) return true;
  try {
    const { rows } = await db.execute({
      sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ? LIMIT 1",
      args: [key, localId],
    });
    return Number(rows[0]?.value) >= 1;
  } catch (err) {
    return !/no such table/i.test(String(err?.message || err));
  }
}

/**
 * Write a LOCAL pin (value '1'). No write without a local id; never throws.
 * True when newly written. Shared with sync-pair-binding.js.
 */
export async function writePin(db, localId, key, { onError } = {}) {
  if (!localId) return false;
  try {
    const r = await db.execute({
      sql: `INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at)
            VALUES (?, ?, '1', datetime('now'))
            ON CONFLICT(key, instance_id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
            WHERE dashboard_settings_overrides.value IS NOT excluded.value`,
      args: [key, localId],
    });
    return Number(r.rowsAffected ?? 0) > 0;
  } catch (err) {
    try { onError?.(err); } catch { /* a logger must not throw */ }
    return false;
  }
}

/** Remove the pin (a re-added person starts unpinned). */
export async function clearCbPin(db, localId, crowId) {
  if (!localId) return;
  await db.execute({
    sql: "DELETE FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?",
    args: [pinKey(crowId), localId],
  });
}

/**
 * LOCAL dashboard_settings_overrides key prefix `<prefix><crowId>`: this
 * instance has sent that contact its `hs_cb` advert (peer-profile.js). Never
 * synced.
 */
export const CB_ADVERT_PREFIX = "contact_hs_cb_adv:";

/**
 * Remove the "advert sent" marker so a re-added person gets a fresh advert.
 * Without a local id, every instance's marker for that contact in this DB is
 * removed (a resend is harmless; a missed one is not).
 */
export async function clearCbAdvertMarker(db, localId, crowId) {
  await db.execute(localId
    ? { sql: "DELETE FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?", args: [CB_ADVERT_PREFIX + crowId, localId] }
    : { sql: "DELETE FROM dashboard_settings_overrides WHERE key = ?", args: [CB_ADVERT_PREFIX + crowId] });
}

/** The pinned Ed25519 key of a full, unblocked contact, or null. Throws on a DB error. */
export async function lookupPinnedContactKey(db, crowId) {
  const { rows } = await db.execute({
    sql: `SELECT ed25519_pubkey FROM contacts
          WHERE crow_id = ? AND is_blocked = 0 AND request_status IS NULL AND ed25519_pubkey != ''
          LIMIT 1`,
    args: [crowId],
  });
  const k = rows[0]?.ed25519_pubkey;
  return typeof k === "string" && k ? k : null;
}

/**
 * Admission decision for a foreign Crow ID's proof. A throwing verify is
 * passed in as `false`.
 */
export function decideContactProof({ cbPresent, cbValid, sigPresent, sigValid, cbPinned }) {
  if (cbPresent) {
    return cbValid
      ? { ok: true, bound: true, legacy: false, reason: null }
      : { ok: false, bound: false, legacy: false, reason: "cb_invalid" };
  }
  if (sigPresent) {
    if (!sigValid) return { ok: false, bound: false, legacy: false, reason: "bad_sig" };
    if (cbPinned) return { ok: false, bound: false, legacy: false, reason: "cb_required_pinned" };
    return { ok: true, bound: false, legacy: true, reason: null };
  }
  return { ok: false, bound: false, legacy: false, reason: "bad_sig" };
}

/**
 * Wire the helpers onto a PeerManager. The local instance id is resolved at
 * call time (string, function, or `peerManager.localInstanceId`), never
 * captured here.
 */
export function wireContactBinding(peerManager, { db, localInstanceId } = {}) {
  const localId = () => {
    const v = typeof localInstanceId === "function" ? localInstanceId() : (localInstanceId ?? peerManager.localInstanceId);
    return v || null;
  };
  peerManager.contactBinding = {
    lookupKey: (crowId) => lookupPinnedContactKey(db, crowId),
    isCbPinned: (crowId) => isCbPinned(db, localId(), crowId),
    markCbPinned: (crowId) => markCbPinned(db, localId(), crowId),
    isInstanceCbPinned: (ownCrowId) => isInstanceCbPinned(db, localId(), ownCrowId),
    markInstanceCbPinned: (ownCrowId) => markInstanceCbPinned(db, localId(), ownCrowId),
  };
}

/** Bounded LRU limiter: at most one log per key per interval. */
export class RefusalLog {
  constructor({ max = 256, intervalMs = 60_000 } = {}) {
    this.max = max;
    this.intervalMs = intervalMs;
    this.map = new Map();
  }
  get size() { return this.map.size; }
  shouldLog(key, now = Date.now()) {
    const last = this.map.get(key);
    if (last !== undefined) this.map.delete(key); // refresh LRU position
    const log = last === undefined || now - last >= this.intervalMs;
    this.map.set(key, log ? now : last);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return log;
  }
}
