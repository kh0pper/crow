/**
 * Sync pair binding (PT-2a): the second factor of both instance-sync
 * handshakes (tailnet and Hyperswarm).
 *
 * Holding the Crow ID seed is not enough to sync as a sibling: each side also
 * proves, with an HMAC over both sides' fresh nonces, that it holds the
 * pair's `signing_key` (the per-pair key PT-1 deletes on revoke). After one
 * bound handshake each side pins the peer LOCALLY and never accepts an
 * unbound handshake from it again. Peers that are not pinned are governed by
 * the mode (`auto` admits them as legacy, `require` refuses them). See the
 * private engineering notes for the design.
 *
 * This module holds the pure pieces both transports share: the subkey and
 * MACs, the production key lookup, the pin, the policy, and the Nest records.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadPeerCreds } from "./peer-credentials.js";
import { ENROLL_ID_RE } from "./enroll-guard.js";
import { SYNC_PB_KEY_PREFIX, SYNC_PB_CLEARED_PREFIX } from "./self-dial-address.js";
import { readPin, writePin } from "../sharing/contact-binding.js";
import { recordUnboundPeer, recordPairBindingRefusal, clearPairBindingState } from "./peer-trust-health.js";

/**
 * The subkey label. Its first line contains `/`, which an HTTP method token
 * (the first line of cross-host-auth's canonicalString) cannot, so a MAC under
 * the raw signing key can never stand in for this derivation.
 */
const SUBKEY_LABEL = "crow/sync-pair-binding/v1";
const HEX_RE = /^(?:[0-9a-fA-F]{2})+$/;

/**
 * K_pb = HMAC-SHA256(key = the DECODED signing_key bytes, SUBKEY_LABEL), the
 * same decoding signRequest uses. Throws TypeError on anything but even-length
 * hex (Buffer.from would silently truncate it).
 */
export function pairSubkey(signingKeyHex) {
  if (typeof signingKeyHex !== "string" || !HEX_RE.test(signingKeyHex)) {
    throw new TypeError("pairSubkey: signing key must be non-empty hex");
  }
  return createHmac("sha256", Buffer.from(signingKeyHex, "hex")).update(SUBKEY_LABEL).digest();
}

function label(tag, fields) {
  for (const v of fields) {
    if (typeof v !== "string") throw new TypeError(`${tag}: fields must be strings`);
    if (v.includes("\n")) throw new Error(`${tag}: field contains a newline`);
  }
  return [tag, ...fields].join("\n");
}

function mac(k, msg) {
  if (!Buffer.isBuffer(k) || k.length === 0) throw new TypeError("pair-binding MAC: key must be a subkey Buffer");
  return createHmac("sha256", k).update(msg).digest("hex");
}

/** Tailnet server → client: `pb-resp\n<server>\n<client>\n<cN>\n<sN>`. */
export function tailnetRespMac(k, { server, client, cN, sN }) {
  return mac(k, label("pb-resp", [server, client, cN, sN]));
}

/** Tailnet client → server: `pb-proof\n<client>\n<server>\n<sN>\n<cN>`. */
export function tailnetProofMac(k, { client, server, sN, cN }) {
  return mac(k, label("pb-proof", [client, server, sN, cN]));
}

/** Hyperswarm responder → challenger: `hs-pb\n<responder>\n<challenger>\n<challenge>\n<handshakeHash>`. */
export function hyperswarmMac(k, { responder, challenger, challenge, handshakeHash }) {
  return mac(k, label("hs-pb", [responder, challenger, challenge, handshakeHash]));
}

/** Constant-time MAC comparison after a type and length check. */
export function macEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0) return false;
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/**
 * The production key lookup: the pair's `signing_key` from the PT-1
 * credential store, or null. Re-read on every call (no cache), so a revoke or
 * re-pair takes effect on the next handshake. The store reads as empty when
 * it is not mode 0600 (loadPeerCreds). `ENROLL_ID_RE` keeps `__proto__` out,
 * and `Object.hasOwn` keeps `constructor`/`toString` from indexing the
 * prototype: both checks stay.
 */
export function defaultPairKey(peerId) {
  if (typeof peerId !== "string" || !ENROLL_ID_RE.test(peerId)) return null;
  const store = loadPeerCreds();
  if (!store || typeof store !== "object" || !Object.hasOwn(store, peerId)) return null;
  const entry = store[peerId];
  const key = entry && typeof entry === "object" ? entry.signing_key : null;
  return typeof key === "string" && HEX_RE.test(key) ? key : null;
}

/** PT-2a's default; PT-2b changes it to "require". */
export const DEFAULT_PAIR_BINDING_MODE = "auto";
let _modeWarned = false;

/**
 * `CROW_SYNC_PAIR_BINDING` = `auto` | `require` (unset or empty → the
 * default). There is no `off`: any other value means `require`, logged once.
 */
export function pairBindingMode(env = process.env) {
  const raw = env?.CROW_SYNC_PAIR_BINDING;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_PAIR_BINDING_MODE;
  if (raw === "auto" || raw === "require") return raw;
  if (!_modeWarned) {
    _modeWarned = true;
    console.warn(`[sync-pair-binding] unknown CROW_SYNC_PAIR_BINDING=${JSON.stringify(String(raw)).slice(0, 40)}; using "require" (valid: auto, require)`);
  }
  return "require";
}

/** Test seam: forget that the unknown-mode warning was logged. */
export function _resetPairBindingModeLog() { _modeWarned = false; }

/**
 * Has `peerId` ever completed a bound handshake with us? Fails CLOSED (true)
 * on a lookup error or a missing local id; only a missing table means "not
 * pinned". A null peer id has no pin to read: no pin can ever be written for
 * it (markPairPinned refuses), so it is reported unpinned.
 */
export async function isPairPinned(db, localId, peerId) {
  if (!peerId) return false;
  return readPin(db, localId, `${SYNC_PB_KEY_PREFIX}${peerId}`);
}

/**
 * Pin `peerId` (LOCAL scope). True when newly written; a new pin also removes
 * this instance's clear-pin marker for that peer (the owner's clear is over).
 * Never throws.
 */
export async function markPairPinned(db, localId, peerId) {
  if (!peerId) return false;
  const wrote = await writePin(db, localId, `${SYNC_PB_KEY_PREFIX}${peerId}`);
  if (wrote) {
    try {
      await db.execute({
        sql: "DELETE FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?",
        args: [`${SYNC_PB_CLEARED_PREFIX}${peerId}`, localId],
      });
    } catch { /* the marker is informational */ }
  }
  return wrote;
}

/**
 * The policy, one function for both transports:
 *   macInvalid (a MAC present but wrong) → refuse pb_invalid, never legacy
 *   bound                                → ok (the caller writes the pin)
 *   pinned                               → refuse pb_required_pinned
 *   mode "auto"                          → ok, legacy
 *   otherwise                            → refuse pb_required
 */
export function decidePairBinding({ bound, macInvalid, pinned, mode }) {
  if (macInvalid) return { ok: false, legacy: false, reason: "pb_invalid" };
  if (bound) return { ok: true, legacy: false, reason: null };
  if (pinned) return { ok: false, legacy: false, reason: "pb_required_pinned" };
  if (mode === "auto") return { ok: true, legacy: true, reason: null };
  return { ok: false, legacy: false, reason: "pb_required" };
}

function refusalMessage(peerId, reason, noKey) {
  if (noKey) return `sync refused: no pair key for ${peerId}; re-pair to fix`;
  if (reason === "pb_invalid") return `sync refused: ${peerId} failed pair binding (the two sides hold different pair keys); re-pair to fix`;
  if (reason === "pb_required_pinned") return `sync refused: ${peerId} was pair-bound before and now syncs without pair binding (older Crow or a rollback)`;
  if (reason === "pb_required") return `sync refused: ${peerId} syncs without pair binding and this Crow requires it (update that Crow)`;
  return `sync refused: ${peerId} (${reason})`;
}

/**
 * Record one handshake's outcome for the Nest (peer-trust-health). `noKey`
 * marks a refusal where WE hold no pair key for the peer (store missing,
 * unreadable or loose mode): its message says "re-pair to fix".
 */
export function recordPairBindingState(peerId, { bound, legacy, reason, noKey = false } = {}, nowMs = Date.now()) {
  if (!peerId) return;
  if (bound) { clearPairBindingState(peerId); return; }
  if (legacy) {
    recordUnboundPeer(peerId, `sibling ${peerId} syncs without pair binding (older Crow or no pair key)`, nowMs);
    return;
  }
  if (reason) recordPairBindingRefusal(peerId, reason, refusalMessage(peerId, reason, noKey), nowMs);
}

/**
 * The pair subkey for `peerId` through `lookup` (production: defaultPairKey),
 * or null: no id, no key, a bad key, or a lookup error. Both transports.
 */
export async function pairSubkeyVia(lookup, peerId) {
  if (!peerId) return null;
  const fn = typeof lookup === "function" ? lookup : defaultPairKey;
  try {
    const hex = await fn(peerId);
    return hex ? pairSubkey(hex) : null;
  } catch {
    return null;
  }
}

const _legacyLogged = new Set();

/**
 * One handshake's binding decision, shared by both transports: reads the pin
 * only when it can change the outcome (fails CLOSED), decides, records the
 * Nest state (unless `recordNest` is false), writes the pin on a bound
 * handshake, and logs `pair-bound` / `pair binding failed`.
 *
 *   prefix  log prefix, e.g. "[tailnet-sync]"
 *   where   e.g. "server side", "client side", "Hyperswarm"
 *
 * Returns decidePairBinding's { ok, legacy, reason }.
 */
export async function decideAndRecordPairBinding({
  db, localId, peerId, k, bound, macInvalid, mode, log = console, prefix, where, recordNest = true,
}) {
  const pinned = bound || macInvalid ? false : await isPairPinned(db, localId, peerId);
  const d = decidePairBinding({ bound, macInvalid, pinned, mode: mode ?? pairBindingMode() });
  if (recordNest) recordPairBindingState(peerId, { bound: d.ok && bound, legacy: d.legacy, reason: d.reason, noKey: !k });
  const who = peerId ?? "(no instance id)";
  if (d.legacy && recordNest && peerId && !_legacyLogged.has(peerId)) {
    // Once per peer per process: the Nest item's log twin (a legacy link can
    // re-handshake every few minutes, the item stays until a bound handshake).
    _legacyLogged.add(peerId);
    const info = typeof log.log === "function" ? log.log.bind(log) : console.log;
    info(`${prefix} ${who} syncs without pair binding (${where}; older Crow or no pair key)`);
  }
  if (!d.ok) {
    log.warn?.(`${prefix} pair binding failed for ${who} (${where}): ${d.reason}${k ? "" : "; this side holds no pair key for it"}`);
    return d;
  }
  if (bound) {
    const fresh = await markPairPinned(db, localId, peerId);
    const info = typeof log.log === "function" ? log.log.bind(log) : console.log;
    info(`${prefix} pair-bound handshake with ${who} (${where})${fresh ? "; pinned: unbound handshakes from it are refused from now on" : ""}`);
  }
  return d;
}
