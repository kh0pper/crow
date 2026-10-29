/**
 * Unpaired-mode pairing, satellite side (SAT-3, spec §4.1 step 6, §4.2 steps 1, 3, 4).
 *
 * Pairing code: 24 Crockford base32 characters, 15 min, single use. The db keeps only
 * pairMacKey(code) (HKDF-SHA256, one way): enough to check a MAC, never enough to print or
 * recover the code, and it lets `cli.js pair-code` mint a code the running agent accepts.
 * Minting voids every earlier live code.
 *
 * Wrong MACs (coordinator ruling, overrides spec §4.2's "5 wrong MACs void the code", so one
 * reachable caller cannot burn the owner's code): each nonce_s is bound to the source it was
 * issued to (`<via>:<client>`) and only that source can redeem it; a source is refused after
 * 5 wrong MACs for the current code; the code itself is voided only at 25 wrong MACs in all or
 * wrong MACs from 3 distinct sources. /pair/complete is limited to 10/min per source.
 *
 * hello {nonce_c} → {satellite_id, satellite_pubkey, nonce_s, agent_protocol, sig}; nonce_s is
 * kept in pair_nonces. complete {cert, crow_id, root_pubkey, primary_instance_id, primary_url,
 * target_sha, protocol, nonce_s, mac} → {ok:true, sig} over doneSigningString. A complete that
 * reaches the MAC check spends its nonce_s whatever the outcome (one complete per hello).
 * Errors are JSON {error:"<snake_code>"}, which crow's client reports as the refusal detail.
 *
 * Hello rate limits (Kevin note c): 10/min per source AND 30/min in all, so one flooding source
 * cannot lock the owner out for the code's 15 minutes.
 */
import { randomBytes } from "node:crypto";
import {
  AGENT_PROTOCOL, PAIR_CODE_TTL_MS, PAIR_NONCE_TTL_MS, PAIR_MAX_WRONG,
  acceptCert, certSha256, doneSigningString, formatFingerprint, generatePairCode, helloSigningString,
  macEqualHex, pairMacKey, pairMacWithKey, signBytes, verifyCertSignature, certTimeState,
} from "../shared/satellite-protocol.js";

export const HELLO_PER_SOURCE_PER_MIN = 10;
export const COMPLETE_PER_SOURCE_PER_MIN = 10;
export const PAIR_SOURCE_MAX_WRONG = PAIR_MAX_WRONG; // 5, per source and code
export const PAIR_GLOBAL_MAX_WRONG = 25;
export const PAIR_VOID_DISTINCT_SOURCES = 3;
export const HELLO_GLOBAL_PER_MIN = 30;
export const PAIR_NONCE_KEEP_MS = 24 * 3600000;
const MIN = 60000;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;

export class PairRefusal extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const refuse = (status, code) => new PairRefusal(status, code);

const pad2 = (n) => String(n).padStart(2, "0");

/** Void every live code and mint a fresh one. → {code, normalized, expiresAt}. */
export function issuePairCode(db, { now = Date.now() } = {}) {
  const { code, normalized } = generatePairCode();
  const expiresAt = now + PAIR_CODE_TTL_MS;
  db.transaction(() => {
    db.prepare("UPDATE pair_codes SET voided_at = ? WHERE used_at IS NULL AND voided_at IS NULL").run(now);
    db.prepare("INSERT INTO pair_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)").run(pairMacKey(normalized), now, expiresAt);
  })();
  return { code, normalized, expiresAt };
}

/** The two console lines of spec §4.1 step 6 (HH:MM in the server's local time). */
export function pairCodeLines({ code, expiresAt }, satelliteId) {
  const d = new Date(expiresAt);
  return [
    `Pairing code:   ${code}   (expires ${pad2(d.getHours())}:${pad2(d.getMinutes())})`,
    `This server id: ${formatFingerprint(satelliteId)}`,
  ];
}

/**
 * True when `cert` is a well-signed cert for this satellite that has not lapsed (grace counts)
 * AND `pinned` matches it (crow_id, root_pubkey, mgmt_pubkey). pinned.json is written before
 * cert.json, so a cert without its pin (a crash between the two, a deleted pin) is not paired.
 */
export function certIsLive(cert, pinned, ownPubHex, now = Date.now()) {
  if (!cert || !pinned || !verifyCertSignature(cert)) return false;
  const p = cert.payload;
  return p.satellite_pubkey === ownPubHex && certTimeState(cert, now) !== "lapsed"
    && pinned.crow_id === p.crow_id && pinned.root_pubkey === p.root_pubkey && pinned.mgmt_pubkey === p.mgmt_pubkey;
}

/** Sliding one-minute windows: per source and in all. */
export function createHelloLimiter({ perSource = HELLO_PER_SOURCE_PER_MIN, global = HELLO_GLOBAL_PER_MIN } = {}) {
  let all = [];
  const bySource = new Map();
  return {
    /** Records the hit and returns true when allowed; a refused hit is not recorded. */
    hit(source, now) {
      all = all.filter((t) => now - t < MIN);
      for (const [k, v] of bySource) {
        const kept = v.filter((t) => now - t < MIN);
        if (kept.length) bySource.set(k, kept); else bySource.delete(k);
      }
      const mine = bySource.get(source) || [];
      if (mine.length >= perSource || all.length >= global) return false;
      mine.push(now);
      bySource.set(source, mine);
      all.push(now);
      return true;
    },
  };
}

export function handleHello(ctx, body, source) {
  const { db, key, now } = ctx;
  const nonce_c = body?.nonce_c;
  if (typeof nonce_c !== "string" || !HEX32.test(nonce_c)) throw refuse(400, "bad_request");
  const t = now();
  const nonce_s = randomBytes(16).toString("hex");
  db.transaction(() => {
    db.prepare("DELETE FROM pair_nonces WHERE issued_at < ?").run(t - PAIR_NONCE_KEEP_MS);
    db.prepare("INSERT INTO pair_nonces (nonce_s, nonce_c, issued_at, source) VALUES (?, ?, ?, ?)").run(nonce_s, nonce_c, t, source);
  })();
  const sig = signBytes(key.ed25519_priv, Buffer.from(helloSigningString({ nonceC: nonce_c, nonceS: nonce_s, satelliteId: key.satellite_id }), "utf8"));
  return { satellite_id: key.satellite_id, satellite_pubkey: key.ed25519_pub, nonce_s, agent_protocol: AGENT_PROTOCOL, sig };
}

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Verify and apply a complete. `persist({cert, pinned})` writes cert.json + pinned.json; it runs
 * inside the db transaction, so a failed write leaves the code and nonce unspent.
 * → {sig, cert, pinned}. Throws PairRefusal.
 */
export function handleComplete(ctx, body, source) {
  const { db, key, now, persist } = ctx;
  if (!isObj(body)) throw refuse(400, "bad_request");
  const { cert, crow_id, root_pubkey, primary_instance_id, primary_url, target_sha, protocol, nonce_s, mac } = body;
  if (!isObj(cert) || !isObj(cert.payload) || typeof nonce_s !== "string" || !HEX32.test(nonce_s)
    || typeof mac !== "string" || !HEX64.test(mac)) throw refuse(400, "bad_request");
  if (protocol !== AGENT_PROTOCOL) throw refuse(400, "unsupported_protocol");
  const p = cert.payload;
  if (crow_id !== p.crow_id || root_pubkey !== p.root_pubkey || primary_instance_id !== p.primary_instance_id
    || primary_url !== p.primary_url) throw refuse(400, "cert_mismatch");
  if (!(target_sha === null || target_sha === undefined || (typeof target_sha === "string" && SHA40.test(target_sha)))) {
    throw refuse(400, "bad_request");
  }
  let certHash;
  try { certHash = certSha256(cert); } catch { throw refuse(400, "bad_cert"); }

  const t = now();
  const outcome = db.transaction(() => {
    const n = db.prepare("SELECT nonce_c, issued_at, used_at, source FROM pair_nonces WHERE nonce_s = ?").get(nonce_s);
    if (!n) return { err: refuse(400, "bad_nonce") };
    // Another source's nonce: refused and left untouched for the source it was issued to.
    if (n.source !== source) return { err: refuse(403, "wrong_source") };
    if (n.used_at != null) return { err: refuse(400, "nonce_used") };
    if (!(t - n.issued_at < PAIR_NONCE_TTL_MS)) return { err: refuse(400, "nonce_expired") };
    const live = db.prepare("SELECT code_hash, wrong_tries FROM pair_codes WHERE used_at IS NULL AND voided_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1").get(t);
    if (!live) return { err: refuse(403, "no_live_code") };
    const mine = db.prepare("SELECT wrong FROM pair_tries WHERE code_hash = ? AND source = ?").get(live.code_hash, source);
    if ((mine?.wrong ?? 0) >= PAIR_SOURCE_MAX_WRONG) return { err: refuse(403, "too_many_tries") };
    // From here on the nonce is spent, whatever the outcome.
    db.prepare("UPDATE pair_nonces SET used_at = ? WHERE nonce_s = ?").run(t, nonce_s);
    let expected;
    try {
      expected = pairMacWithKey(live.code_hash, { nonceC: n.nonce_c, nonceS: nonce_s, certSha256: certHash, satelliteId: key.satellite_id });
    } catch {
      return { err: refuse(400, "bad_request") };
    }
    if (!macEqualHex(expected, mac)) {
      const total = live.wrong_tries + 1;
      db.prepare("INSERT INTO pair_tries (code_hash, source, wrong) VALUES (?, ?, 1) ON CONFLICT(code_hash, source) DO UPDATE SET wrong = wrong + 1")
        .run(live.code_hash, source);
      const sources = db.prepare("SELECT COUNT(*) AS n FROM pair_tries WHERE code_hash = ? AND wrong > 0").get(live.code_hash).n;
      const voidIt = total >= PAIR_GLOBAL_MAX_WRONG || sources >= PAIR_VOID_DISTINCT_SOURCES;
      db.prepare("UPDATE pair_codes SET wrong_tries = ?, voided_at = CASE WHEN ? THEN ? ELSE voided_at END WHERE code_hash = ?")
        .run(total, voidIt ? 1 : 0, t, live.code_hash);
      return { err: refuse(403, "bad_mac") };
    }
    const seen = db.prepare("SELECT 1 FROM cert_serials WHERE serial = ?");
    const ok = acceptCert(cert, { ownPubHex: key.ed25519_pub, pinned: null, current: null, serialSeen: (s) => !!seen.get(String(s)), now: t });
    if (!ok.ok) return { err: refuse(400, ok.code) };
    db.prepare("UPDATE pair_codes SET used_at = ? WHERE code_hash = ?").run(t, live.code_hash);
    db.prepare("INSERT INTO cert_serials (serial, accepted_at) VALUES (?, ?)").run(p.serial, new Date(t).toISOString());
    const pinned = {
      crow_id: p.crow_id, root_pubkey: p.root_pubkey, mgmt_pubkey: p.mgmt_pubkey, primary_url: p.primary_url,
      primary_instance_id: p.primary_instance_id, target_sha: target_sha ?? null,
    };
    persist({ cert, pinned });
    return { nonce_c: n.nonce_c, pinned };
  })();
  if (outcome.err) throw outcome.err;
  const sig = signBytes(key.ed25519_priv, Buffer.from(doneSigningString({ nonceC: outcome.nonce_c, certSha256: certHash }), "utf8"));
  return { sig, cert, pinned: outcome.pinned };
}
