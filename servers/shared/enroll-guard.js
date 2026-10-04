/**
 * Shared pieces of the peer-enrollment gate (servers/gateway/routes/instance-enroll.js)
 * and the operator CLI (scripts/cli/instance-pair.js).
 *
 *   - the one-time code (OTC): generation, minimum length, a digest for
 *     constant-time comparison and for persisting "used" / "first seen" marks;
 *   - the re-pair PROOF: an instance re-pairing with a peer that already
 *     trusts it proves it holds its CURRENT bearer without sending it. The
 *     proof is HMAC-SHA256 keyed by sha256(current bearer) — exactly the
 *     auth_token_hash the peer stores — over every field of the new request,
 *     so it cannot be lifted onto different credentials or a different dial
 *     address, and it is useless to whoever receives it if the URL was wrong;
 *   - the local re-pair ALLOWANCE: `crow instance pair --allow-re-pair <id>`,
 *     run by the operator on the receiving host, writes a short-lived,
 *     single-use permission for that one peer id.
 *
 * All persisted marks live in dashboard_settings_overrides (LOCAL scope —
 * never replicated by instance sync).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ENROLL_OTC_MIN_LENGTH = 16;
export const REPAIR_ALLOW_KEY_PREFIX = "enroll_repair_allow:";
export const OTC_USED_KEY_PREFIX = "enroll_otc_used:";
export const OTC_SEEN_KEY_PREFIX = "enroll_otc_seen:";
export const REPAIR_ALLOW_DEFAULT_MINUTES = 15;
export const REPAIR_ALLOW_MAX_MINUTES = 60;
/** At most this many re-pair proofs are accepted / sent per request. */
export const MAX_REPAIR_PROOFS = 32;

/** A strong one-time code: 24 random bytes, base64url (32 chars). */
export function generateEnrollOtc() {
  return randomBytes(24).toString("base64url");
}

export function sha256Hex(s) {
  return createHash("sha256").update(String(s)).digest("hex");
}

/** Constant-time string equality (compares fixed-length digests). */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}

/**
 * v2 (2026-10-04 review): the proof is bound to the TARGET instance id (the
 * receiver checks it against its OWN id, so a proof made for peer B never
 * verifies at peer C) and to the digest of this enrollment's one-time code
 * (single-use and time-boxed, so a captured proof dies with its code), plus
 * every field of the request. Its MAC key (repairProofKey) is derived from
 * the hash the receiver stores for the source's current bearer AND the shared
 * signing key — whoever holds both of the receiver's stores could forge one,
 * which is acceptable (they already hold its trust store). A successful
 * re-pair rotates that hash in the same transaction that consumes the code
 * (compare-and-swap on the old hash), so a proof is never usable twice.
 */
function proofMessage(body, { targetId, otcDigest }) {
  return JSON.stringify([
    "crow-enroll-repair-v2",
    String(targetId ?? ""),
    String(otcDigest ?? ""),
    String(body.source_instance_id ?? ""),
    body.source_name == null ? "" : String(body.source_name),
    sha256Hex(body.source_outbound_bearer ?? ""),
    sha256Hex(body.shared_signing_key ?? ""),
    body.source_gateway_url == null ? "" : String(body.source_gateway_url),
    body.source_tailscale_ip == null ? "" : String(body.source_tailscale_ip),
    body.source_sync_port == null ? "" : String(body.source_sync_port),
  ]);
}

/**
 * The proof key: needs BOTH the bearer hash the target stores in crow.db and
 * the shared signing key it keeps only in peer-tokens.json, so a copy of the
 * target's DB (a backup, a stolen disk) alone cannot forge a proof.
 */
export function repairProofKey(authTokenHash, signingKey) {
  if (!authTokenHash || !signingKey) return null;
  return sha256Hex(`crow-enroll-repair-key-v2\n${authTokenHash}\n${signingKey}`);
}

/**
 * The re-pair proof for an enroll request body sent to `targetId` under the
 * one-time code whose digest is `otcDigest`, keyed by repairProofKey(sha256(our
 * current outbound bearer to that peer), our current shared signing key).
 */
export function repairProof(key, body, { targetId, otcDigest }) {
  if (!targetId || !otcDigest) throw new Error("repairProof needs targetId and otcDigest");
  return createHmac("sha256", String(key)).update(proofMessage(body, { targetId, otcDigest })).digest("hex");
}

/** True when any proof in `proofs` was made with `key` over `body` for this target + code. */
export function verifyRepairProofs(key, body, proofs, { targetId, otcDigest }) {
  if (!key || !targetId || !otcDigest || !Array.isArray(proofs)) return false;
  const expected = repairProof(key, body, { targetId, otcDigest });
  let ok = false;
  for (const p of proofs.slice(0, MAX_REPAIR_PROOFS)) {
    if (typeof p === "string" && safeEqual(p, expected)) ok = true; // no early exit
  }
  return ok;
}

async function upsertLocal(db, key, localId, value) {
  await db.execute({
    sql: `INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(key, instance_id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    args: [key, localId, String(value)],
  });
}

async function readLocal(db, key, localId) {
  const r = await db.execute({
    sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?",
    args: [key, localId],
  });
  return r.rows[0]?.value ?? null;
}

async function deleteLocal(db, key, localId) {
  await db.execute({
    sql: "DELETE FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?",
    args: [key, localId],
  });
}

/** Operator CLI: allow ONE re-pair of `peerId` on this host for `minutes`. */
export async function writeRepairAllowance(db, localId, peerId, { minutes = REPAIR_ALLOW_DEFAULT_MINUTES, now = Date.now() } = {}) {
  const m = Math.min(Math.max(1, Math.floor(Number(minutes) || REPAIR_ALLOW_DEFAULT_MINUTES)), REPAIR_ALLOW_MAX_MINUTES);
  const expiresAt = now + m * 60_000;
  await upsertLocal(db, `${REPAIR_ALLOW_KEY_PREFIX}${peerId}`, localId, JSON.stringify({ expires_at: expiresAt }));
  return { expiresAt, minutes: m };
}

/** True when an unexpired allowance for `peerId` exists. */
export async function hasRepairAllowance(db, localId, peerId, { now = Date.now() } = {}) {
  try {
    const raw = await readLocal(db, `${REPAIR_ALLOW_KEY_PREFIX}${peerId}`, localId);
    if (!raw) return false;
    const exp = Number(JSON.parse(raw)?.expires_at);
    return Number.isFinite(exp) && exp > now;
  } catch {
    return false;
  }
}

export async function consumeRepairAllowance(db, localId, peerId) {
  try { await deleteLocal(db, `${REPAIR_ALLOW_KEY_PREFIX}${peerId}`, localId); } catch { /* best effort */ }
}

export async function isOtcUsed(db, localId, digest) {
  return (await readLocal(db, `${OTC_USED_KEY_PREFIX}${digest}`, localId)) != null;
}

export async function markOtcUsed(db, localId, digest, now = Date.now()) {
  await upsertLocal(db, `${OTC_USED_KEY_PREFIX}${digest}`, localId, String(now));
}

/** When this gateway first saw this OTC (ms epoch); records `now` on first sight. */
export async function otcFirstSeen(db, localId, digest, now = Date.now()) {
  const key = `${OTC_SEEN_KEY_PREFIX}${digest}`;
  await db.execute({
    sql: `INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at)
          VALUES (?, ?, ?, datetime('now')) ON CONFLICT(key, instance_id) DO NOTHING`,
    args: [key, localId, String(now)],
  });
  const v = Number(await readLocal(db, key, localId));
  return Number.isFinite(v) ? v : now;
}
