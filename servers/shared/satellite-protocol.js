/**
 * Satellite Crow: protocol core (SAT-1).
 *
 * Pure crypto and canonical forms shared by the crow primary and the
 * satellite agent. No I/O, no DB. Every signed message carries its own
 * domain-separation prefix, so a signature made for one purpose never
 * verifies as another.
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyCrowIdBinding } from "./identity-attestation.js";

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export const PREFIXES = Object.freeze({
  cert: "crow-satellite-cert/v1\n",
  revocation: "crow-satellite-revocation/v1\n",
  req: "crow-satellite-req/v1\n",
  resp: "crow-satellite-resp/v1\n",
  hello: "crow-satellite-pair-hello/v1\n",
  pair: "crow-satellite-pair/v1",
  done: "crow-satellite-pair-done/v1\n",
});

const DAY = 86400000;
export const AGENT_PROTOCOL = 1;
export const CERT_TTL_MS = 90 * DAY;
export const RENEW_BELOW_MS = 76 * DAY;
export const GRACE_MS = 30 * DAY;
export const TS_WINDOW_MS = 60000;
export const RESULT_CAP_BYTES = 262144;
export const PAIR_CODE_TTL_MS = 15 * 60000;
export const PAIR_NONCE_TTL_MS = 5 * 60000;
export const PAIR_MAX_WRONG = 5;

const HEX_RE = /^(?:[0-9a-f]{2})+$/;
const hexBuf = (h, len) => {
  if (typeof h !== "string" || !HEX_RE.test(h)) throw new Error("bad hex");
  if (len && h.length !== len * 2) throw new Error("bad length");
  return Buffer.from(h, "hex");
};
const toBuf = (v) => (Buffer.isBuffer(v) ? v : typeof v === "string" ? Buffer.from(v, "utf8") : v instanceof Uint8Array ? Buffer.from(v) : null);

// ── canonical JSON ──────────────────────────────────────────────────────────

export function canonicalJson(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string": return JSON.stringify(value);
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError("canonicalJson: non-plain object");
      return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
}

export function sha256Hex(v) {
  return createHash("sha256").update(typeof v === "string" ? Buffer.from(v, "utf8") : v).digest("hex");
}

// ── keys ────────────────────────────────────────────────────────────────────

export function generateKeypair() {
  const priv = ed.utils.randomPrivateKey();
  return { privHex: Buffer.from(priv).toString("hex"), pubHex: Buffer.from(ed.getPublicKey(priv)).toString("hex") };
}

export function signBytes(privHex, bytes) {
  return Buffer.from(ed.sign(toBuf(bytes), hexBuf(privHex, 32))).toString("hex");
}

export function verifyBytes(pubHex, bytes, sigHex) {
  try {
    const b = toBuf(bytes);
    if (!b) return false;
    return ed.verify(hexBuf(sigHex, 64), b, hexBuf(pubHex, 32)) === true;
  } catch {
    return false;
  }
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32Lower(buf) {
  let bits = 0, acc = 0, out = "";
  for (const byte of buf) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

export function satelliteIdFromPub(pubHex) {
  const digest = createHash("sha256").update(hexBuf(pubHex, 32)).digest();
  return `sat_${base32Lower(digest).slice(0, 20)}`;
}

export function isSatelliteId(s) {
  return typeof s === "string" && /^sat_[a-z2-7]{20}$/.test(s);
}

export function formatFingerprint(id) {
  return `sat_${id.slice(4).match(/.{1,4}/g).join("-")}`;
}

// ── certificate (§3.2) ──────────────────────────────────────────────────────

const iso = (ms) => new Date(ms).toISOString();

export function buildCertPayload({
  serial, crow_id, root_pubkey, primary_instance_id, primary_url, satellite_id, satellite_pubkey,
  mgmt_pubkey, scopes = ["manage", "tools", "vault"], issued_at, expires_at, now = Date.now(),
}) {
  const issued = issued_at || iso(now);
  return {
    type: "crow-satellite-cert",
    v: 1,
    serial: serial || randomBytes(16).toString("hex"),
    crow_id, root_pubkey, primary_instance_id, primary_url,
    satellite_id, satellite_pubkey, mgmt_pubkey,
    scopes: [...scopes],
    issued_at: issued,
    expires_at: expires_at || iso(Date.parse(issued) + CERT_TTL_MS),
  };
}

const certBytes = (payload) => Buffer.from(PREFIXES.cert + canonicalJson(payload), "utf8");

export function signCert(rootPrivHex, payload) {
  return { payload, sig: signBytes(rootPrivHex, certBytes(payload)) };
}

export function verifyCertSignature(cert) {
  try {
    const p = cert?.payload;
    if (!p || p.type !== "crow-satellite-cert" || p.v !== 1) return false;
    if (!verifyBytes(p.root_pubkey, certBytes(p), cert.sig)) return false;
    if (!verifyCrowIdBinding(p.crow_id, p.root_pubkey)) return false;
    return p.satellite_id === satelliteIdFromPub(p.satellite_pubkey);
  } catch {
    return false;
  }
}

export function acceptCert(cert, { ownPubHex, pinned = null, current = null, serialSeen = () => false, now = Date.now() } = {}) {
  const no = (code) => ({ ok: false, code });
  if (!verifyCertSignature(cert)) return no("bad_signature");
  const p = cert.payload;
  if (p.satellite_pubkey !== ownPubHex) return no("wrong_satellite");
  if (pinned && (pinned.crow_id !== p.crow_id || pinned.root_pubkey !== p.root_pubkey)) return no("wrong_crow");
  const issued = Date.parse(p.issued_at);
  const expires = Date.parse(p.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return no("bad_signature");
  if (now >= expires) return no("expired");
  if (issued > now + TS_WINDOW_MS) return no("not_yet_valid");
  if (current?.payload) {
    const cur = Date.parse(current.payload.issued_at);
    if (!(issued > cur)) return no("not_newer");
  }
  if (serialSeen(p.serial)) return no("serial_reused");
  return { ok: true };
}

export function certTimeState(cert, now = Date.now()) {
  const exp = Date.parse(cert.payload.expires_at);
  if (now < exp) return "valid";
  return now - exp <= GRACE_MS ? "grace" : "lapsed";
}

export function needsRenewal(cert, now = Date.now()) {
  return Date.parse(cert.payload.expires_at) - now < RENEW_BELOW_MS;
}

export function certSha256(cert) {
  return sha256Hex(canonicalJson(cert));
}

// ── revocation (§3.3) ───────────────────────────────────────────────────────

const revBytes = (payload) => Buffer.from(PREFIXES.revocation + canonicalJson(payload), "utf8");

export function signRevocation(rootPrivHex, { serial, satellite_id, revoked_at, reason }) {
  const payload = { type: "crow-satellite-revocation", v: 1, serial, satellite_id, revoked_at, reason };
  return { payload, sig: signBytes(rootPrivHex, revBytes(payload)) };
}

export function verifyRevocation(rec, rootPubHex) {
  try {
    const p = rec?.payload;
    if (!p || p.type !== "crow-satellite-revocation" || p.v !== 1) return false;
    return verifyBytes(rootPubHex, revBytes(p), rec.sig);
  } catch {
    return false;
  }
}

// ── request signing (§5.1) ──────────────────────────────────────────────────

export function isValidCaller(c) {
  return typeof c === "string" && (c === "owner-local" || c === "owner-remote" || /^bot:[A-Za-z0-9._-]{1,64}$/.test(c));
}

export function requestSigningString({ method, pathQuery, bodySha256, ts, nonce, satelliteId, caller }) {
  return `${PREFIXES.req}${String(method).toUpperCase()}\n${pathQuery}\n${bodySha256}\n${ts}\n${nonce}\n${satelliteId}\n${caller}`;
}

const bodyHash = (body) => sha256Hex(body == null || body === "" ? "" : body);

export function signRequest(mgmtPrivHex, { method, pathQuery, body = "", satelliteId, caller, ts, nonce }) {
  if (!isValidCaller(caller)) throw new Error("signRequest: invalid caller");
  const t = ts ?? String(Date.now());
  const n = nonce ?? randomBytes(16).toString("hex");
  const str = requestSigningString({ method, pathQuery, bodySha256: bodyHash(body), ts: t, nonce: n, satelliteId, caller });
  return {
    "X-Crow-Sat-Sig": signBytes(mgmtPrivHex, Buffer.from(str, "utf8")),
    "X-Crow-Sat-Ts": t,
    "X-Crow-Sat-Nonce": n,
    "X-Crow-Sat-Caller": caller,
  };
}

function header(headers, name) {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === want) return headers[k];
  return undefined;
}

export function verifyRequest(mgmtPubHex, { method, pathQuery, body = "", headers, satelliteId, now = Date.now() }) {
  const no = (code) => ({ ok: false, code, caller: undefined, nonce: undefined });
  const caller = header(headers, "X-Crow-Sat-Caller");
  if (!isValidCaller(caller)) return no("bad_caller");
  const ts = header(headers, "X-Crow-Sat-Ts");
  if (typeof ts !== "string" || !/^\d{1,16}$/.test(ts) || Math.abs(Number(ts) - now) > TS_WINDOW_MS) return no("clock_skew");
  const nonce = header(headers, "X-Crow-Sat-Nonce");
  const sig = header(headers, "X-Crow-Sat-Sig");
  if (typeof nonce !== "string" || !nonce || typeof sig !== "string") return no("bad_signature");
  const str = requestSigningString({ method, pathQuery, bodySha256: bodyHash(body), ts, nonce, satelliteId, caller });
  if (!verifyBytes(mgmtPubHex, Buffer.from(str, "utf8"), sig)) return no("bad_signature");
  return { ok: true, code: undefined, caller, nonce };
}

// ── response signing (§5.2) ─────────────────────────────────────────────────

export function responseSigningString({ requestNonce, status, bodySha256 }) {
  return `${PREFIXES.resp}${requestNonce}\n${status}\n${bodySha256}`;
}

export function signResponse(satPrivHex, args) {
  return signBytes(satPrivHex, Buffer.from(responseSigningString(args), "utf8"));
}

export function verifyResponse(satPubHex, args, sigHex) {
  return verifyBytes(satPubHex, Buffer.from(responseSigningString(args), "utf8"), sigHex);
}

// ── pairing (§4.1 step 6, §4.2) ─────────────────────────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generatePairCode() {
  const bytes = randomBytes(15);
  let bits = 0, acc = 0, normalized = "";
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      normalized += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return { code: normalized.match(/.{4}/g).join("-"), normalized };
}

export function normalizePairCode(input) {
  if (typeof input !== "string") return null;
  const s = input.replace(/[\s-]+/g, "").toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0");
  return /^[0-9A-HJKMNP-TV-Z]{24}$/.test(s) ? s : null;
}

export function hashPairCode(normalized) {
  return sha256Hex(normalized);
}

export function helloSigningString({ nonceC, nonceS, satelliteId }) {
  return `${PREFIXES.hello}${nonceC}\n${nonceS}\n${satelliteId}`;
}

export function pairMac(normalizedCode, { nonceC, nonceS, certSha256: certHash, satelliteId }) {
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(normalizedCode, "utf8"), Buffer.alloc(0), PREFIXES.pair, 32));
  return createHmac("sha256", key)
    .update(`${PREFIXES.pair}\n${nonceC}\n${nonceS}\n${certHash}\n${satelliteId}`)
    .digest("hex");
}

export function macEqualHex(a, b) {
  try {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !HEX_RE.test(a) || !HEX_RE.test(b)) return false;
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export function doneSigningString({ nonceC, certSha256: certHash }) {
  return `${PREFIXES.done}${nonceC}\n${certHash}`;
}
