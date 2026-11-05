/**
 * Sync session binding (PT-2b): the tailnet control phase's per-connection key.
 *
 * PT-2a binds the two hello frames to the pair key (`pb_mac` / `pb_proof`),
 * but everything after them — the feed-key exchange and the signed dial
 * address — travelled unauthenticated, and the Noise stream that follows was
 * opened with a fresh, unauthenticated keypair. A seed holder sitting on the
 * network path could therefore rewrite the feed frames, replay them, or
 * terminate Noise on both legs and read the replication stream.
 *
 * This module adds the missing layer: one key per connection, derived from the
 * pair key `K_pb` with a salt that is a hash of the two exact hello frames (the
 * transcript), split per direction. Every control frame after the hellos then
 * carries a counter and an HMAC under that key, and the Noise stream's static
 * key is sent inside one of those MAC'd frames. A relay that changes either
 * hello makes the two sides' keys differ; one that changes a later frame
 * breaks its MAC; one that replays it breaks the counter.
 *
 * Pure functions only — the transport wires them (tailnet-sync.js). See the
 * private engineering notes for the design.
 */
import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

const SESSION_LABEL = "crow/sync-session/v1";
const TRANSCRIPT_LABEL = "crow/sync-transcript/v1";

/** The version both hellos carry when they speak session MACs. */
export const SM_VERSION = 1;

const HEX_RE = /^[0-9a-f]*$/;
// Per-kind field rules: exact shapes, so a frame can never smuggle a value
// (or a differently-typed value) past the MAC's own hex check.
const FIELD_RULES = {
  proof: { cr_proof: /^[0-9a-f]{128}$/, pb_proof: /^[0-9a-f]{64}$/ },
  feed: { feed_key_hex: /^([0-9a-f]{64})?$/, noise_pk: /^[0-9a-f]{64}$/ },
};
const FIELD_ORDER = { proof: ["cr_proof", "pb_proof"], feed: ["feed_key_hex", "noise_pk"] };
const DIRS = new Set(["c2s", "s2c"]);

function assertLabel(tag, name, v) {
  if (typeof v !== "string" || v.length === 0) throw new TypeError(`${tag}: ${name} must be a non-empty string`);
  if (v.includes("\n")) throw new Error(`${tag}: ${name} contains a newline`);
  return v;
}

function assertKey(k) {
  if (!Buffer.isBuffer(k) || k.length !== 32) throw new TypeError("sync-session: a derived session key must be a 32-byte Buffer");
  return k;
}

/** Normalise a field value: `null`/`undefined` stand for the empty string. */
export function sessionFieldValue(frame, name) {
  const v = frame?.[name];
  return v === undefined || v === null ? "" : v;
}

/**
 * th = SHA-256("crow/sync-transcript/v1\n" ‖ u32be(|C1|) ‖ C1 ‖ u32be(|S1|) ‖ S1),
 * over the EXACT bytes each side put on the wire. Payload bytes are what a WS
 * middlebox cannot re-encode (framing and compression happen around them).
 */
export function transcriptHash(c1Buf, s1Buf) {
  const parts = [c1Buf, s1Buf].map((b) => {
    if (!Buffer.isBuffer(b) && !(b instanceof Uint8Array)) throw new TypeError("transcriptHash: frames must be Buffers");
    return Buffer.from(b);
  });
  const h = createHash("sha256");
  h.update(`${TRANSCRIPT_LABEL}\n`);
  for (const b of parts) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length, 0);
    h.update(len);
    h.update(b);
  }
  return h.digest();
}

/**
 * The input keying material: HMAC(K_pb, the session label). K_pb itself is
 * then only ever an HMAC key, and HKDF-Extract (HMAC with the salt as key)
 * cannot reproduce any PT-2a MAC.
 */
function sessionIkm(kPb) {
  assertKey(kPb);
  return createHmac("sha256", kPb).update(SESSION_LABEL).digest();
}

/**
 * K_dir = HKDF-SHA256(ikm, salt = th, info = "…/v1\n<dir>\n<client>\n<server>\n<cN>\n<sN>").
 * The direction label separates the two keys; the nonces and th separate one
 * connection from every other.
 */
export function deriveSessionKeys(kPb, { client, server, cN, sN, th } = {}) {
  assertLabel("deriveSessionKeys", "client", client);
  assertLabel("deriveSessionKeys", "server", server);
  assertLabel("deriveSessionKeys", "cN", cN);
  assertLabel("deriveSessionKeys", "sN", sN);
  if (!Buffer.isBuffer(th) || th.length !== 32) throw new TypeError("deriveSessionKeys: th must be a 32-byte Buffer");
  const ikm = sessionIkm(kPb);
  const derive = (dir) => Buffer.from(hkdfSync("sha256", ikm, th, Buffer.from(`${SESSION_LABEL}\n${dir}\n${client}\n${server}\n${cN}\n${sN}`, "utf8"), 32));
  return { c2s: derive("c2s"), s2c: derive("s2c") };
}

/**
 * sm = HMAC-SHA256(K_dir, "sm\n<dir>\n<ctr>\n<kind>\n<f1>\n<f2>"). Explicit
 * field lists per kind: no JSON canonicalisation, so no field ordering or
 * number formatting can be argued about.
 */
export function sessionFrameMac(k, { dir, ctr, kind, fields } = {}) {
  assertKey(k);
  if (!DIRS.has(dir)) throw new Error("sessionFrameMac: unknown direction");
  if (!Number.isSafeInteger(ctr) || ctr < 0) throw new TypeError("sessionFrameMac: ctr must be a non-negative safe integer");
  const order = FIELD_ORDER[kind];
  if (!order) throw new Error("sessionFrameMac: unknown frame kind");
  if (!Array.isArray(fields) || fields.length !== order.length) throw new TypeError(`sessionFrameMac: ${kind} takes ${order.length} fields`);
  for (const v of fields) {
    if (typeof v !== "string") throw new TypeError("sessionFrameMac: fields must be strings");
    if (!HEX_RE.test(v)) throw new Error("sessionFrameMac: fields must be hex");
  }
  const msg = ["sm", dir, String(ctr), kind, ...fields].join("\n");
  return createHmac("sha256", k).update(msg).digest("hex");
}

function macEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0) return false;
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/**
 * One direction's send counter and the other direction's expected counter.
 * `role` is "client" or "server": it decides which direction this side sends.
 *
 * seal(kind, values) → { sm_ctr, sm }, values in FIELD_ORDER[kind] order.
 * open(kind, frame, names) → { ok, reason }, names in the same order; the frame
 * may carry no other keys than those names plus sm_ctr/sm. The checks run
 * missing → ctr → shape → mac, so a stripped MAC is reported as missing even
 * when the counters have also drifted.
 */
export class SessionChannel {
  constructor({ keys, role } = {}) {
    if (!keys || !Buffer.isBuffer(keys.c2s) || !Buffer.isBuffer(keys.s2c)) throw new TypeError("SessionChannel: two direction keys are required");
    if (role !== "client" && role !== "server") throw new TypeError('SessionChannel: role must be "client" or "server"');
    this.keys = keys;
    this.role = role;
    this._send = 0;
    this._recv = 0;
  }

  get outDir() { return this.role === "client" ? "c2s" : "s2c"; }
  get inDir() { return this.role === "client" ? "s2c" : "c2s"; }

  seal(kind, values) {
    const dir = this.outDir;
    const ctr = this._send;
    const sm = sessionFrameMac(this.keys[dir], { dir, ctr, kind, fields: values });
    this._send += 1;
    return { sm_ctr: ctr, sm };
  }

  open(kind, frame, names) {
    const order = FIELD_ORDER[kind];
    if (!order) return { ok: false, reason: "bad_shape" };
    const dir = this.inDir;
    if (!frame || typeof frame !== "object" || frame.sm === undefined) return { ok: false, reason: "missing" };
    if (!Number.isSafeInteger(frame.sm_ctr) || frame.sm_ctr !== this._recv) return { ok: false, reason: "bad_ctr" };
    const wanted = names || order;
    if (!Array.isArray(wanted) || wanted.length !== order.length || wanted.some((n, i) => n !== order[i])) {
      return { ok: false, reason: "bad_shape" };
    }
    // Anything beyond the listed fields plus sm_ctr/sm is not covered by the
    // MAC, so it must not be there at all.
    const allowed = new Set([...order, "sm_ctr", "sm"]);
    for (const k of Object.keys(frame)) {
      if (!allowed.has(k)) return { ok: false, reason: "bad_shape" };
    }
    const values = [];
    for (const name of order) {
      const v = sessionFieldValue(frame, name);
      if (typeof v !== "string" || v.includes("\n") || !FIELD_RULES[kind][name].test(v)) return { ok: false, reason: "bad_shape" };
      values.push(v);
    }
    const expected = sessionFrameMac(this.keys[dir], { dir, ctr: frame.sm_ctr, kind, fields: values });
    if (!macEqual(frame.sm, expected)) return { ok: false, reason: "bad_mac" };
    this._recv += 1;
    return { ok: true, reason: null };
  }
}

/**
 * The auto-legacy branch's channel: it sends nothing and accepts everything,
 * so the transport's "every frame after the hellos goes through the session"
 * rule holds on the unbound path too.
 */
export const NULL_SESSION = Object.freeze({
  seal() { return {}; },
  open() { return { ok: true, reason: null }; },
});

/**
 * The negotiation decision, applied AFTER the pair-binding decision. Session
 * mode is negotiated AND bound: a side with no pair key never derives keys,
 * whatever the peer's hello claims. Unbound peers are already decided by
 * decidePairBinding, so this only ever refuses a negotiated mismatch or a
 * peer that does not speak the session check at all.
 */
export function decideSession({ bound, negotiated, peerOffered, macResult, mode } = {}) {
  if (bound === true) {
    if (negotiated) {
      return macResult?.ok
        ? { ok: true, legacySession: false, reason: null }
        : { ok: false, legacySession: false, reason: "sm_invalid" };
    }
    // The peer claimed `sm` but this side cannot derive keys (no pair key, or
    // a relay added the flag): never fall back to a weaker path silently.
    if (peerOffered) return { ok: false, legacySession: false, reason: "sm_invalid" };
    if (mode === "auto") return { ok: true, legacySession: true, reason: null };
    return { ok: false, legacySession: false, reason: "sm_required" };
  }
  // Not bound: decidePairBinding already decided (legacy in auto, refused
  // otherwise), and a side with no bound pair never derives session keys.
  return { ok: true, legacySession: true, reason: null };
}