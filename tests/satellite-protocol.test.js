import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import {
  PREFIXES, AGENT_PROTOCOL, CERT_TTL_MS, RENEW_BELOW_MS, GRACE_MS, TS_WINDOW_MS,
  RESULT_CAP_BYTES, PAIR_CODE_TTL_MS, PAIR_NONCE_TTL_MS, PAIR_MAX_WRONG,
  canonicalJson, sha256Hex, generateKeypair, signBytes, verifyBytes,
  satelliteIdFromPub, isSatelliteId, formatFingerprint,
  buildCertPayload, signCert, verifyCertSignature, acceptCert, certTimeState, needsRenewal,
  signRevocation, verifyRevocation,
  requestSigningString, signRequest, verifyRequest, isValidCaller,
  responseSigningString, signResponse, verifyResponse,
  generatePairCode, normalizePairCode, hashPairCode, helloSigningString, pairMac,
  macEqualHex, doneSigningString, certSha256,
} from "../servers/shared/satellite-protocol.js";

const DAY = 86400000;
const NOW = Date.parse("2026-11-01T00:00:00.000Z");

// A real crow root identity: crow_id derived from the root pubkey.
const makeRoot = generateKeypair;
function crowIdFor(pubHex) {
  const h = createHash("sha256").update(Buffer.from(pubHex, "hex")).digest();
  return `crow:${h.readBigUInt64BE(0).toString(36).slice(0, 10).padStart(10, "0")}`;
}

function reissue(f, now, extra = {}) {
  const { issued_at, expires_at, serial, ...rest } = f.payload;
  void issued_at; void expires_at; void serial;
  return signCert(f.root.privHex, buildCertPayload({ ...rest, ...extra, now }));
}

function fixture(over = {}) {
  const root = makeRoot();
  const sat = generateKeypair();
  const mgmt = generateKeypair();
  const payload = buildCertPayload({
    crow_id: crowIdFor(root.pubHex), root_pubkey: root.pubHex,
    primary_instance_id: "inst-1", primary_url: "https://crow.example.ts.net:8444",
    satellite_id: satelliteIdFromPub(sat.pubHex), satellite_pubkey: sat.pubHex,
    mgmt_pubkey: mgmt.pubHex, now: NOW, ...over,
  });
  const cert = signCert(root.privHex, payload);
  return { root, sat, mgmt, payload, cert };
}

describe("constants", () => {
  test("values", () => {
    assert.equal(AGENT_PROTOCOL, 1);
    assert.equal(CERT_TTL_MS, 90 * DAY);
    assert.equal(RENEW_BELOW_MS, 76 * DAY);
    assert.equal(GRACE_MS, 30 * DAY);
    assert.equal(TS_WINDOW_MS, 60000);
    assert.equal(RESULT_CAP_BYTES, 262144);
    assert.equal(PAIR_CODE_TTL_MS, 15 * 60000);
    assert.equal(PAIR_NONCE_TTL_MS, 5 * 60000);
    assert.equal(PAIR_MAX_WRONG, 5);
    assert.ok(Object.isFrozen(PREFIXES));
    assert.deepEqual(PREFIXES, {
      cert: "crow-satellite-cert/v1\n", revocation: "crow-satellite-revocation/v1\n",
      req: "crow-satellite-req/v1\n", resp: "crow-satellite-resp/v1\n",
      hello: "crow-satellite-pair-hello/v1\n", pair: "crow-satellite-pair/v1",
      done: "crow-satellite-pair-done/v1\n",
    });
  });
});

describe("canonicalJson", () => {
  test("sorted, compact, deterministic", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
    assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
    assert.equal(canonicalJson(null), "null");
    assert.equal(canonicalJson("é"), '"é"');
  });
  test("refusals", () => {
    assert.throws(() => canonicalJson(undefined));
    assert.throws(() => canonicalJson({ a: undefined }));
    assert.throws(() => canonicalJson({ a: () => 1 }));
    assert.throws(() => canonicalJson(NaN));
    assert.throws(() => canonicalJson({ a: Infinity }));
    assert.throws(() => canonicalJson(new Date()));
    assert.throws(() => canonicalJson(new Map()));
    assert.throws(() => canonicalJson(Buffer.from("x")));
    assert.throws(() => canonicalJson(Symbol("s")));
    assert.throws(() => canonicalJson(10n));
  });
});

describe("keys and ids", () => {
  test("sha256Hex", () => {
    assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(sha256Hex(Buffer.from("abc")), sha256Hex("abc"));
  });
  test("keypair round trip", () => {
    const { privHex, pubHex } = generateKeypair();
    assert.match(privHex, /^[0-9a-f]{64}$/);
    assert.match(pubHex, /^[0-9a-f]{64}$/);
    const sig = signBytes(privHex, Buffer.from("hi"));
    assert.match(sig, /^[0-9a-f]{128}$/);
    assert.equal(verifyBytes(pubHex, Buffer.from("hi"), sig), true);
    assert.equal(verifyBytes(pubHex, Buffer.from("ho"), sig), false);
    assert.equal(verifyBytes(generateKeypair().pubHex, Buffer.from("hi"), sig), false);
  });
  test("verifyBytes never throws on malformed input", () => {
    const { pubHex } = generateKeypair();
    assert.equal(verifyBytes("zz", Buffer.from("x"), "00"), false);
    assert.equal(verifyBytes(pubHex, Buffer.from("x"), "nothex"), false);
    assert.equal(verifyBytes(pubHex, Buffer.from("x"), "ab"), false);
    assert.equal(verifyBytes(null, Buffer.from("x"), null), false);
    assert.equal(verifyBytes(pubHex, null, "00"), false);
  });
  test("satellite id format and derivation", () => {
    const { pubHex } = generateKeypair();
    const id = satelliteIdFromPub(pubHex);
    assert.match(id, /^sat_[a-z2-7]{20}$/);
    assert.equal(isSatelliteId(id), true);
    assert.equal(satelliteIdFromPub(pubHex), id);
    assert.equal(isSatelliteId("sat_ABCDEFGHIJKLMNOPQRST"), false);
    assert.equal(isSatelliteId("sat_abc"), false);
    assert.equal(isSatelliteId(`${id}x`), false);
    assert.equal(isSatelliteId(null), false);
  });
  test("satellite id is RFC 4648 base32 of sha256(pub) first 20 chars (known vector)", () => {
    // pub = 32 zero bytes; sha256 = 66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925
    // base32 of the first 12.5 bytes: 66687aadf862bd776c8fc18b8e -> "mzuhvlpyml3xn3mpyfny" (computed independently below)
    const digest = Buffer.from("66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925", "hex");
    let bits = "";
    for (const b of digest) bits += b.toString(2).padStart(8, "0");
    const A = "abcdefghijklmnopqrstuvwxyz234567";
    let expect = "";
    for (let i = 0; i < 20; i++) expect += A[parseInt(bits.slice(i * 5, i * 5 + 5), 2)];
    assert.equal(satelliteIdFromPub("00".repeat(32)), `sat_${expect}`);
  });
  test("fingerprint formatting", () => {
    const id = satelliteIdFromPub(generateKeypair().pubHex);
    const fp = formatFingerprint(id);
    assert.match(fp, /^sat_[a-z2-7]{4}(-[a-z2-7]{4}){4}$/);
    assert.equal(fp.replace(/-/g, ""), id);
  });
});

describe("certificate", () => {
  test("payload defaults", () => {
    const { payload } = fixture();
    assert.equal(payload.type, "crow-satellite-cert");
    assert.equal(payload.v, 1);
    assert.match(payload.serial, /^[0-9a-f]{32}$/);
    assert.deepEqual(payload.scopes, ["manage", "tools", "vault"]);
    assert.equal(payload.issued_at, new Date(NOW).toISOString());
    assert.equal(payload.expires_at, new Date(NOW + 90 * DAY).toISOString());
  });
  test("sign and verify", () => {
    const { cert } = fixture();
    assert.equal(verifyCertSignature(cert), true);
  });
  test("signature is over prefix + canonical json", () => {
    const { cert, root } = fixture();
    const bytes = Buffer.from(PREFIXES.cert + canonicalJson(cert.payload), "utf8");
    assert.equal(verifyBytes(root.pubHex, bytes, cert.sig), true);
    assert.equal(verifyBytes(root.pubHex, Buffer.from(canonicalJson(cert.payload)), cert.sig), false);
  });
  test("tampered payload fails", () => {
    const { cert } = fixture();
    const t = { payload: { ...cert.payload, scopes: ["manage", "tools", "vault", "root"] }, sig: cert.sig };
    assert.equal(verifyCertSignature(t), false);
    const t2 = { payload: { ...cert.payload, expires_at: new Date(NOW + 900 * DAY).toISOString() }, sig: cert.sig };
    assert.equal(verifyCertSignature(t2), false);
  });
  test("crow_id / root_pubkey mismatch fails even with valid signature", () => {
    const root = generateKeypair();
    const sat = generateKeypair();
    const p = buildCertPayload({
      crow_id: "crow:0000000000", root_pubkey: root.pubHex, primary_instance_id: "i", primary_url: "u",
      satellite_id: satelliteIdFromPub(sat.pubHex), satellite_pubkey: sat.pubHex, mgmt_pubkey: generateKeypair().pubHex, now: NOW,
    });
    assert.equal(verifyCertSignature(signCert(root.privHex, p)), false);
  });
  test("satellite_id must derive from satellite_pubkey", () => {
    const f = fixture({ satellite_id: satelliteIdFromPub(generateKeypair().pubHex) });
    assert.equal(verifyCertSignature(f.cert), false);
  });
  test("wrong type / version fails", () => {
    const f = fixture();
    for (const patch of [{ type: "other" }, { v: 2 }]) {
      const p = { ...f.payload, ...patch };
      assert.equal(verifyCertSignature(signCert(f.root.privHex, p)), false);
    }
  });
  test("verifyCertSignature never throws on garbage", () => {
    assert.equal(verifyCertSignature(null), false);
    assert.equal(verifyCertSignature({}), false);
    assert.equal(verifyCertSignature({ payload: {}, sig: "00" }), false);
  });

  describe("acceptCert", () => {
    const ctx = (f, over = {}) => ({
      ownPubHex: f.sat.pubHex, pinned: null, current: null, serialSeen: () => false, now: NOW, ...over,
    });
    test("first pairing ok", () => {
      const f = fixture();
      assert.deepEqual(acceptCert(f.cert, ctx(f)), { ok: true });
    });
    test("bad_signature", () => {
      const f = fixture();
      const bad = { payload: { ...f.cert.payload, primary_url: "https://evil" }, sig: f.cert.sig };
      assert.deepEqual(acceptCert(bad, ctx(f)), { ok: false, code: "bad_signature" });
    });
    test("wrong_satellite on first and renewed certs", () => {
      const f = fixture();
      const other = generateKeypair();
      assert.deepEqual(acceptCert(f.cert, ctx(f, { ownPubHex: other.pubHex })), { ok: false, code: "wrong_satellite" });
      // renewal for a different satellite key, even with matching pin and a newer issued_at
      const renewed = signCert(f.root.privHex, buildCertPayload({
        crow_id: f.payload.crow_id, root_pubkey: f.payload.root_pubkey, primary_instance_id: "i", primary_url: "u",
        satellite_id: satelliteIdFromPub(other.pubHex), satellite_pubkey: other.pubHex,
        mgmt_pubkey: f.mgmt.pubHex, now: NOW + 8 * DAY,
      }));
      const r = acceptCert(renewed, ctx(f, {
        now: NOW + 8 * DAY, pinned: { crow_id: f.payload.crow_id, root_pubkey: f.payload.root_pubkey }, current: f.cert,
      }));
      assert.deepEqual(r, { ok: false, code: "wrong_satellite" });
    });
    test("wrong_crow when pinned pair differs", () => {
      const f = fixture();
      const other = fixture();
      assert.deepEqual(
        acceptCert(f.cert, ctx(f, { pinned: { crow_id: other.payload.crow_id, root_pubkey: other.payload.root_pubkey } })),
        { ok: false, code: "wrong_crow" });
      assert.deepEqual(
        acceptCert(f.cert, ctx(f, { pinned: { crow_id: f.payload.crow_id, root_pubkey: other.payload.root_pubkey } })),
        { ok: false, code: "wrong_crow" });
      assert.deepEqual(
        acceptCert(f.cert, ctx(f, { pinned: { crow_id: f.payload.crow_id, root_pubkey: f.payload.root_pubkey } })),
        { ok: true });
    });
    test("not_newer: equal and older issued_at refused; strictly later accepted", () => {
      const f = fixture();
      const pinned = { crow_id: f.payload.crow_id, root_pubkey: f.payload.root_pubkey };
      const mk = (now) => reissue(f, now);
      const same = mk(NOW);
      assert.deepEqual(acceptCert(same, ctx(f, { pinned, current: f.cert })), { ok: false, code: "not_newer" });
      const older = mk(NOW - DAY);
      assert.deepEqual(acceptCert(older, ctx(f, { pinned, current: f.cert })), { ok: false, code: "not_newer" });
      const newer = mk(NOW + 8 * DAY);
      assert.deepEqual(acceptCert(newer, ctx(f, { pinned, current: f.cert, now: NOW + 8 * DAY })), { ok: true });
    });
    test("serial_reused", () => {
      const f = fixture();
      const pinned = { crow_id: f.payload.crow_id, root_pubkey: f.payload.root_pubkey };
      const newer = reissue(f, NOW + 8 * DAY);
      const seen = new Set([newer.payload.serial]);
      assert.deepEqual(
        acceptCert(newer, ctx(f, { pinned, current: f.cert, now: NOW + 8 * DAY, serialSeen: (s) => seen.has(s) })),
        { ok: false, code: "serial_reused" });
    });
    test("expired and not_yet_valid", () => {
      const f = fixture();
      assert.deepEqual(acceptCert(f.cert, ctx(f, { now: NOW + 90 * DAY })), { ok: false, code: "expired" });
      assert.deepEqual(acceptCert(f.cert, ctx(f, { now: NOW + 91 * DAY })), { ok: false, code: "expired" });
      assert.deepEqual(acceptCert(f.cert, ctx(f, { now: NOW + 90 * DAY - 1 })), { ok: true });
      assert.deepEqual(acceptCert(f.cert, ctx(f, { now: NOW - 61000 })), { ok: false, code: "not_yet_valid" });
      assert.deepEqual(acceptCert(f.cert, ctx(f, { now: NOW - 59000 })), { ok: true });
    });
    test("mgmt key rotation by a newer cert is accepted", () => {
      const f = fixture();
      const pinned = { crow_id: f.payload.crow_id, root_pubkey: f.payload.root_pubkey };
      const rotated = reissue(f, NOW + DAY, { mgmt_pubkey: generateKeypair().pubHex });
      assert.deepEqual(acceptCert(rotated, ctx(f, { pinned, current: f.cert, now: NOW + DAY })), { ok: true });
    });
  });

  describe("time state", () => {
    const { cert } = fixture();
    const exp = Date.parse(cert.payload.expires_at);
    test("valid / grace / lapsed", () => {
      assert.equal(certTimeState(cert, exp - 1), "valid");
      assert.equal(certTimeState(cert, exp), "grace");
      assert.equal(certTimeState(cert, exp + 30 * DAY), "grace");
      assert.equal(certTimeState(cert, exp + 30 * DAY + 1), "lapsed");
    });
    test("renewal threshold 76 d left", () => {
      assert.equal(needsRenewal(cert, exp - 76 * DAY), false);
      assert.equal(needsRenewal(cert, exp - 76 * DAY + 1), true);
      assert.equal(needsRenewal(cert, exp + DAY), true);
    });
  });
});

describe("revocation", () => {
  test("sign and verify", () => {
    const root = generateKeypair();
    const rec = signRevocation(root.privHex, { serial: "ab".repeat(16), satellite_id: "sat_aaaaaaaaaaaaaaaaaaaa", revoked_at: "2026-11-01T00:00:00.000Z", reason: "unpaired" });
    assert.equal(rec.payload.type, "crow-satellite-revocation");
    assert.equal(rec.payload.v, 1);
    assert.equal(verifyRevocation(rec, root.pubHex), true);
    assert.equal(verifyRevocation(rec, generateKeypair().pubHex), false);
    assert.equal(verifyRevocation({ payload: { ...rec.payload, reason: "x" }, sig: rec.sig }, root.pubHex), false);
    assert.equal(verifyRevocation(null, root.pubHex), false);
  });
});

describe("request signing", () => {
  const base = (m) => ({ method: "post", pathQuery: "/satellite/v1/mcp/x?a=1", body: '{"k":1}', satelliteId: "sat_aaaaaaaaaaaaaaaaaaaa", caller: "owner-local", ...m });
  test("signing string layout", () => {
    const s = requestSigningString({ method: "post", pathQuery: "/p?q=1", bodySha256: "BH", ts: "123", nonce: "N", satelliteId: "sat_x", caller: "bot:b1" });
    assert.equal(s, "crow-satellite-req/v1\nPOST\n/p?q=1\nBH\n123\nN\nsat_x\nbot:b1");
  });
  test("round trip and headers", () => {
    const mg = generateKeypair();
    const h = signRequest(mg.privHex, base());
    assert.deepEqual(Object.keys(h).sort(), ["X-Crow-Sat-Caller", "X-Crow-Sat-Nonce", "X-Crow-Sat-Sig", "X-Crow-Sat-Ts"]);
    assert.match(h["X-Crow-Sat-Ts"], /^\d+$/);
    assert.match(h["X-Crow-Sat-Nonce"], /^[0-9a-f]{32}$/);
    const r = verifyRequest(mg.pubHex, { ...base(), headers: h, now: Number(h["X-Crow-Sat-Ts"]) });
    assert.deepEqual(r, { ok: true, code: undefined, caller: "owner-local", nonce: h["X-Crow-Sat-Nonce"] });
  });
  test("lowercase header names and Buffer body accepted", () => {
    const mg = generateKeypair();
    const ts = String(NOW);
    const h = signRequest(mg.privHex, base({ ts, nonce: "ab".repeat(16) }));
    const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
    const r = verifyRequest(mg.pubHex, { ...base({ body: Buffer.from('{"k":1}') }), headers: lower, now: NOW });
    assert.equal(r.ok, true);
  });
  test("ts window boundaries", () => {
    const mg = generateKeypair();
    const h = signRequest(mg.privHex, base({ ts: String(NOW) }));
    const v = (now) => verifyRequest(mg.pubHex, { ...base(), headers: h, now });
    assert.equal(v(NOW + 60000).ok, true);
    assert.equal(v(NOW - 60000).ok, true);
    assert.equal(v(NOW + 60001).code, "clock_skew");
    assert.equal(v(NOW - 60001).code, "clock_skew");
  });
  test("bad ts values", () => {
    const mg = generateKeypair();
    const h = signRequest(mg.privHex, base({ ts: String(NOW) }));
    for (const ts of ["abc", "", "1e3", "-5"]) {
      assert.equal(verifyRequest(mg.pubHex, { ...base(), headers: { ...h, "X-Crow-Sat-Ts": ts }, now: NOW }).code, "clock_skew");
    }
  });
  test("tamper: each signed field", () => {
    const mg = generateKeypair();
    const h = signRequest(mg.privHex, base({ ts: String(NOW), caller: "bot:b1" }));
    const ok = (over) => verifyRequest(mg.pubHex, { ...base({ caller: "bot:b1" }), headers: h, now: NOW, ...over });
    assert.equal(ok({}).ok, true);
    assert.equal(ok({ method: "GET" }).code, "bad_signature");
    assert.equal(ok({ pathQuery: "/other" }).code, "bad_signature");
    assert.equal(ok({ body: "x" }).code, "bad_signature");
    assert.equal(ok({ satelliteId: "sat_bbbbbbbbbbbbbbbbbbbb" }).code, "bad_signature");
    assert.equal(ok({ headers: { ...h, "X-Crow-Sat-Nonce": "00".repeat(16) } }).code, "bad_signature");
    assert.equal(ok({ headers: { ...h, "X-Crow-Sat-Caller": "owner-local" } }).code, "bad_signature");
    assert.equal(verifyRequest(generateKeypair().pubHex, { ...base({ caller: "bot:b1" }), headers: h, now: NOW }).code, "bad_signature");
  });
  test("caller validation inside verify; signRequest refuses bad caller", () => {
    const mg = generateKeypair();
    assert.throws(() => signRequest(mg.privHex, base({ caller: "root" })));
    const h = signRequest(mg.privHex, base({ ts: String(NOW) }));
    const r = verifyRequest(mg.pubHex, { ...base(), headers: { ...h, "X-Crow-Sat-Caller": "bot:bad id" }, now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.code, "bad_caller");
  });
  test("missing headers do not throw", () => {
    const mg = generateKeypair();
    assert.equal(verifyRequest(mg.pubHex, { ...base(), headers: {}, now: NOW }).ok, false);
  });
  test("isValidCaller", () => {
    for (const c of ["owner-local", "owner-remote", "bot:b1", "bot:A.b_c-9", "bot:" + "a".repeat(64)]) assert.equal(isValidCaller(c), true, c);
    for (const c of ["", "bot:", "bot:" + "a".repeat(65), "bot:a b", "bot:a/b", "owner", "Owner-local", "user:x", null, undefined, 5, "bot:a\nb"]) assert.equal(isValidCaller(c), false, String(c));
  });
});

describe("response signing", () => {
  test("string layout and round trip", () => {
    const s = responseSigningString({ requestNonce: "N", status: 200, bodySha256: "BH" });
    assert.equal(s, "crow-satellite-resp/v1\nN\n200\nBH");
    const sat = generateKeypair();
    const args = { requestNonce: "ab".repeat(16), status: 200, bodySha256: sha256Hex("{}") };
    const sig = signResponse(sat.privHex, args);
    assert.equal(verifyResponse(sat.pubHex, args, sig), true);
    assert.equal(verifyResponse(sat.pubHex, { ...args, status: 500 }, sig), false);
    assert.equal(verifyResponse(sat.pubHex, { ...args, requestNonce: "00" }, sig), false);
    assert.equal(verifyResponse(sat.pubHex, { ...args, bodySha256: sha256Hex("[]") }, sig), false);
    assert.equal(verifyResponse(generateKeypair().pubHex, args, sig), false);
    assert.equal(verifyResponse(sat.pubHex, args, "zz"), false);
  });
});

describe("pairing", () => {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  test("generatePairCode", () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const { code, normalized } = generatePairCode();
      assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
      assert.equal(normalized.length, 24);
      assert.equal(code.replace(/-/g, ""), normalized);
      for (const ch of normalized) assert.ok(A.includes(ch));
      seen.add(normalized);
    }
    assert.equal(seen.size, 200);
  });
  test("code carries 120 bits: all 32 symbols appear and positions vary", () => {
    const counts = new Map();
    for (let i = 0; i < 400; i++) for (const ch of generatePairCode().normalized) counts.set(ch, (counts.get(ch) || 0) + 1);
    assert.equal(counts.size, 32);
  });
  test("normalizePairCode", () => {
    const { code, normalized } = generatePairCode();
    assert.equal(normalizePairCode(code), normalized);
    assert.equal(normalizePairCode(code.toLowerCase()), normalized);
    assert.equal(normalizePairCode(` ${code.replace(/-/g, " ")} `), normalized);
    assert.equal(normalizePairCode("ILO" + "0".repeat(21)), "110" + "0".repeat(21));
    assert.equal(normalizePairCode("il" + "o".repeat(22)), "11" + "0".repeat(22));
    assert.equal(normalizePairCode("U" + "0".repeat(23)), null);
    assert.equal(normalizePairCode("0".repeat(23)), null);
    assert.equal(normalizePairCode("0".repeat(25)), null);
    assert.equal(normalizePairCode("0".repeat(23) + "!"), null);
    assert.equal(normalizePairCode(""), null);
    assert.equal(normalizePairCode(null), null);
    assert.equal(normalizePairCode(123), null);
  });
  test("hashPairCode", () => {
    const { normalized } = generatePairCode();
    assert.equal(hashPairCode(normalized), sha256Hex(normalized));
    assert.match(hashPairCode(normalized), /^[0-9a-f]{64}$/);
  });
  test("hello string and done string", () => {
    assert.equal(helloSigningString({ nonceC: "C", nonceS: "S", satelliteId: "sat_x" }), "crow-satellite-pair-hello/v1\nC\nS\nsat_x");
    assert.equal(doneSigningString({ nonceC: "C", certSha256: "H" }), "crow-satellite-pair-done/v1\nC\nH");
  });
  test("pairMac equality, determinism and mismatches", () => {
    const { normalized } = generatePairCode();
    const f = fixture();
    const args = { nonceC: randomBytes(16).toString("hex"), nonceS: randomBytes(16).toString("hex"), certSha256: certSha256(f.cert), satelliteId: f.payload.satellite_id };
    const m = pairMac(normalized, args);
    assert.match(m, /^[0-9a-f]{64}$/);
    assert.equal(macEqualHex(m, pairMac(normalized, args)), true);
    assert.equal(macEqualHex(m, pairMac(generatePairCode().normalized, args)), false);
    for (const k of Object.keys(args)) {
      assert.equal(macEqualHex(m, pairMac(normalized, { ...args, [k]: "x" + args[k] })), false, k);
    }
  });
  test("pairMac matches an independent HKDF+HMAC computation", async () => {
    const { hkdfSync, createHmac } = await import("node:crypto");
    const code = "0123456789ABCDEFGHJKMNPQ";
    const a = { nonceC: "c1", nonceS: "s1", certSha256: "h1", satelliteId: "sat_zzzzzzzzzzzzzzzzzzzz" };
    const key = Buffer.from(hkdfSync("sha256", Buffer.from(code), Buffer.alloc(0), "crow-satellite-pair/v1", 32));
    const want = createHmac("sha256", key).update(`crow-satellite-pair/v1\nc1\ns1\nh1\n${a.satelliteId}`).digest("hex");
    assert.equal(pairMac(code, a), want);
  });
  test("macEqualHex constant-time wrapper handles bad input", () => {
    assert.equal(macEqualHex("ab", "abcd"), false);
    assert.equal(macEqualHex("zz", "zz"), false);
    assert.equal(macEqualHex(null, "ab"), false);
    assert.equal(macEqualHex("AB", "ab"), false);
  });
  test("done signature verifies under satellite key and binds the cert hash", () => {
    const f = fixture();
    const nonceC = randomBytes(16).toString("hex");
    const bytes = Buffer.from(doneSigningString({ nonceC, certSha256: certSha256(f.cert) }));
    const sig = signBytes(f.sat.privHex, bytes);
    assert.equal(verifyBytes(f.sat.pubHex, bytes, sig), true);
    const other = Buffer.from(doneSigningString({ nonceC, certSha256: certSha256(fixture().cert) }));
    assert.equal(verifyBytes(f.sat.pubHex, other, sig), false);
  });
  test("certSha256 is sha256 of canonical json of the whole cert", () => {
    const { cert } = fixture();
    assert.equal(certSha256(cert), sha256Hex(canonicalJson(cert)));
  });
});

describe("cross-domain refusal", () => {
  const S = "same-body\nsame-body";
  const domains = {
    cert: PREFIXES.cert, revocation: PREFIXES.revocation, req: PREFIXES.req,
    resp: PREFIXES.resp, hello: PREFIXES.hello, done: PREFIXES.done,
  };
  test("a signature over one prefix fails under every other (table-driven)", () => {
    const kp = generateKeypair();
    for (const [a, pa] of Object.entries(domains)) {
      const sig = signBytes(kp.privHex, Buffer.from(pa + S));
      for (const [b, pb] of Object.entries(domains)) {
        assert.equal(verifyBytes(kp.pubHex, Buffer.from(pb + S), sig), a === b, `${a} as ${b}`);
      }
    }
  });
  test("real artifacts do not cross-verify", () => {
    const f = fixture();
    // cert signature as revocation
    assert.equal(verifyRevocation({ payload: f.cert.payload, sig: f.cert.sig }, f.root.pubHex), false);
    // revocation signature as cert
    const rev = signRevocation(f.root.privHex, { serial: f.payload.serial, satellite_id: f.payload.satellite_id, revoked_at: "2026-11-01T00:00:00.000Z", reason: "r" });
    assert.equal(verifyCertSignature({ payload: f.payload, sig: rev.sig }), false);
    // cert signature as request / response / hello / done under the same key
    const root = f.root;
    const nonce = "ab".repeat(16);
    const reqStr = requestSigningString({ method: "GET", pathQuery: "/", bodySha256: sha256Hex(""), ts: String(NOW), nonce, satelliteId: f.payload.satellite_id, caller: "owner-local" });
    assert.equal(verifyBytes(root.pubHex, Buffer.from(reqStr), f.cert.sig), false);
    const respStr = responseSigningString({ requestNonce: nonce, status: 200, bodySha256: sha256Hex("") });
    assert.equal(verifyBytes(root.pubHex, Buffer.from(respStr), f.cert.sig), false);
    // hello sig does not verify as done and vice versa (satellite key)
    const helloSig = signBytes(f.sat.privHex, Buffer.from(helloSigningString({ nonceC: "a", nonceS: "b", satelliteId: "c" })));
    assert.equal(verifyBytes(f.sat.pubHex, Buffer.from(doneSigningString({ nonceC: "a", certSha256: "b" })), helloSig), false);
    // a response signature does not verify as a request
    const rs = signResponse(f.sat.privHex, { requestNonce: nonce, status: 200, bodySha256: sha256Hex("") });
    const rqAsResp = verifyRequest(f.sat.pubHex, {
      method: "GET", pathQuery: "/", body: "", satelliteId: f.payload.satellite_id, now: NOW,
      headers: { "X-Crow-Sat-Sig": rs, "X-Crow-Sat-Ts": String(NOW), "X-Crow-Sat-Nonce": nonce, "X-Crow-Sat-Caller": "owner-local" },
    });
    assert.equal(rqAsResp.ok, false);
  });
});
