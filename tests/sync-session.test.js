/**
 * PT-2b Task 1: the pure session core (servers/shared/sync-session.js).
 *
 * S-1 known-answer style vectors: the expected values are recomputed here with
 *   node:crypto directly (an independent expression of the same formulas, not
 *   a call into the module under test).
 * S-2 direction separation. S-3 every transcript input matters.
 * S-4 SessionChannel: the whole refusal matrix plus a positive control.
 * S-5 decideSession: every row of the table, and the "bound AND negotiated"
 *   rule that a side with no pair key never derives keys.
 * S-6 (weak, kept as documentation) no session key equals a PT-2a MAC.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import {
  transcriptHash, deriveSessionKeys, sessionFrameMac, SessionChannel, NULL_SESSION, decideSession, SM_VERSION,
} from "../servers/shared/sync-session.js";
import { pairSubkey, tailnetRespMac, tailnetProofMac, hyperswarmMac } from "../servers/shared/sync-pair-binding.js";

const SK = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const C = "inst-client-01";
const S = "inst-server-02";
const CN = "a1".repeat(16);
const SN = "b2".repeat(16);
const C1 = Buffer.from(JSON.stringify({ instance_id: C, nonce_hex: CN, cr: 1, pb: 1, sm: 1 }), "utf8");
const S1 = Buffer.from(JSON.stringify({ instance_id: S, nonce_hex: SN, cr_sig: "cd".repeat(64), sm: 1 }), "utf8");
const CR = "ef".repeat(64);
const PB = "12".repeat(32);
const FEED = "34".repeat(32);
const NPK = "56".repeat(32);

// Independent expressions of the documented formulas.
const refTranscript = (a, b) => {
  const len = (x) => { const u = Buffer.alloc(4); u.writeUInt32BE(x.length, 0); return u; };
  return createHash("sha256").update("crow/sync-transcript/v1\n").update(len(a)).update(a).update(len(b)).update(b).digest();
};
const refIkm = (kPb) => createHmac("sha256", kPb).update("crow/sync-session/v1").digest();
const refKey = (kPb, th, dir) => Buffer.from(hkdfSync("sha256", refIkm(kPb), th,
  Buffer.from(`crow/sync-session/v1\n${dir}\n${C}\n${S}\n${CN}\n${SN}`, "utf8"), 32));
const refMac = (k, dir, ctr, kind, fields) => createHmac("sha256", k).update(["sm", dir, String(ctr), kind, ...fields].join("\n")).digest("hex");

const kPb = () => pairSubkey(SK);

// ── S-1 ────────────────────────────────────────────────────────────────────
test("S-1 transcriptHash / deriveSessionKeys / sessionFrameMac match the documented formulas", () => {
  const th = transcriptHash(C1, S1);
  assert.ok(Buffer.isBuffer(th));
  assert.equal(th.length, 32);
  assert.deepEqual(th, refTranscript(C1, S1));
  // Length framing: a concatenation alone would collide across the boundary.
  assert.notDeepEqual(transcriptHash(Buffer.from("ab"), Buffer.from("c")), transcriptHash(Buffer.from("a"), Buffer.from("bc")));

  const keys = deriveSessionKeys(kPb(), { client: C, server: S, cN: CN, sN: SN, th });
  assert.deepEqual(keys.c2s, refKey(kPb(), th, "c2s"));
  assert.deepEqual(keys.s2c, refKey(kPb(), th, "s2c"));
  assert.equal(keys.c2s.length, 32);

  assert.equal(sessionFrameMac(keys.c2s, { dir: "c2s", ctr: 0, kind: "proof", fields: [CR, PB] }), refMac(keys.c2s, "c2s", 0, "proof", [CR, PB]));
  assert.equal(sessionFrameMac(keys.s2c, { dir: "s2c", ctr: 0, kind: "feed", fields: [FEED, NPK] }), refMac(keys.s2c, "s2c", 0, "feed", [FEED, NPK]));

  // The key derives from the DECODED pair key bytes, and K_pb is only a key.
  assert.notDeepEqual(keys.c2s, Buffer.from(SK, "hex"));
  assert.equal(createHmac("sha256", Buffer.from(SK, "hex")).update("crow/sync-session/v1").digest("hex"), Buffer.from(refIkm(Buffer.from(SK, "hex"))).toString("hex"));

  // Field hygiene: a newline in a field, or a non-hex field, is refused.
  assert.throws(() => sessionFrameMac(keys.c2s, { dir: "c2s", ctr: 0, kind: "proof", fields: ["a\nb", PB] }), /hex/);
  assert.throws(() => sessionFrameMac(keys.c2s, { dir: "c2s", ctr: -1, kind: "proof", fields: [CR, PB] }), TypeError);
  assert.throws(() => sessionFrameMac(keys.c2s, { dir: "up", ctr: 0, kind: "proof", fields: [CR, PB] }), /direction/);
  assert.throws(() => sessionFrameMac(keys.c2s, { dir: "c2s", ctr: 0, kind: "other", fields: [] }), /kind/);
  assert.throws(() => deriveSessionKeys(kPb(), { client: "a\nb", server: S, cN: CN, sN: SN, th }), /newline/);
});

// ── S-2 ────────────────────────────────────────────────────────────────────
test("S-2 direction separation: c2s ≠ s2c, and a c2s MAC never opens as s2c", () => {
  const th = transcriptHash(C1, S1);
  const keys = deriveSessionKeys(kPb(), { client: C, server: S, cN: CN, sN: SN, th });
  assert.notDeepEqual(keys.c2s, keys.s2c);
  const mac = sessionFrameMac(keys.c2s, { dir: "c2s", ctr: 0, kind: "proof", fields: [CR, PB] });
  assert.notEqual(mac, sessionFrameMac(keys.c2s, { dir: "s2c", ctr: 0, kind: "proof", fields: [CR, PB] }));

  const client = new SessionChannel({ keys, role: "client" });
  const server = new SessionChannel({ keys, role: "server" });
  const frame = { cr_proof: CR, pb_proof: PB, ...client.seal("proof", [CR, PB]) };
  assert.deepEqual(server.open("proof", frame, ["cr_proof", "pb_proof"]), { ok: true, reason: null });
  // The same frame reflected back at the client is a c2s MAC on the s2c key.
  assert.deepEqual(client.open("proof", frame, ["cr_proof", "pb_proof"]), { ok: false, reason: "bad_mac" });
});

// ── S-3 ────────────────────────────────────────────────────────────────────
test("S-3 changing one byte of either hello, or any id or nonce, changes both keys", () => {
  const base = deriveSessionKeys(kPb(), { client: C, server: S, cN: CN, sN: SN, th: transcriptHash(C1, S1) });
  const other = (o) => deriveSessionKeys(kPb(), { client: C, server: S, cN: CN, sN: SN, th: transcriptHash(C1, S1), ...o });
  const bumped = Buffer.from(C1); bumped[3] ^= 0x01;
  const bumpedS = Buffer.from(S1); bumpedS[3] ^= 0x01;
  const variants = [
    { th: transcriptHash(bumped, S1) },
    { th: transcriptHash(C1, bumpedS) },
    { client: `${C}x` },
    { server: `${S}x` },
    { cN: `${CN.slice(0, -1)}3` },
    { sN: `${SN.slice(0, -1)}3` },
  ];
  for (const v of variants) {
    const keys = other(v);
    assert.notDeepEqual(keys.c2s, base.c2s, JSON.stringify(v).slice(0, 40));
    assert.notDeepEqual(keys.s2c, base.s2c, JSON.stringify(v).slice(0, 40));
  }
});

// ── S-4 ────────────────────────────────────────────────────────────────────
test("S-4 SessionChannel.open: missing → ctr → shape → mac, a positive control, and no extra keys", () => {
  const th = transcriptHash(C1, S1);
  const keys = deriveSessionKeys(kPb(), { client: C, server: S, cN: CN, sN: SN, th });
  const ok = () => {
    const client = new SessionChannel({ keys, role: "client" });
    const server = new SessionChannel({ keys, role: "server" });
    return { client, server };
  };
  const names = ["cr_proof", "pb_proof"];

  // Positive control: the correct sequence opens (0 then 1).
  {
    const { client, server } = ok();
    const p0 = { cr_proof: CR, pb_proof: PB, ...client.seal("proof", [CR, PB]) };
    assert.equal(p0.sm_ctr, 0);
    assert.deepEqual(server.open("proof", p0, names), { ok: true, reason: null });
    const f0 = { feed_key_hex: FEED, noise_pk: NPK, ...client.seal("feed", [FEED, NPK]) };
    assert.equal(f0.sm_ctr, 1);
    assert.deepEqual(server.open("feed", f0, ["feed_key_hex", "noise_pk"]), { ok: true, reason: null });
  }
  // The same counter twice.
  {
    const { client, server } = ok();
    const p0 = { cr_proof: CR, pb_proof: PB, ...client.seal("proof", [CR, PB]) };
    assert.equal(server.open("proof", p0, names).ok, true);
    assert.deepEqual(server.open("proof", p0, names), { ok: false, reason: "bad_ctr" });
  }
  // ctr 1 before 0.
  {
    const { client, server } = ok();
    client.seal("proof", [CR, PB]); // burn ctr 0
    const p1 = { cr_proof: CR, pb_proof: PB, ...client.seal("proof", [CR, PB]) };
    assert.deepEqual(server.open("proof", p1, names), { ok: false, reason: "bad_ctr" });
  }
  // A proof MAC presented as a feed frame (right shapes, wrong kind).
  {
    const { client, server } = ok();
    const p0 = client.seal("proof", [CR, PB]);
    assert.deepEqual(server.open("feed", { feed_key_hex: NPK, noise_pk: PB, ...p0 }, ["feed_key_hex", "noise_pk"]), { ok: false, reason: "bad_mac" });
  }
  // No sm at all.
  {
    const { server } = ok();
    assert.deepEqual(server.open("proof", { cr_proof: CR, pb_proof: PB }, names), { ok: false, reason: "missing" });
    assert.deepEqual(server.open("proof", null, names), { ok: false, reason: "missing" });
  }
  // Shape: non-hex, a newline, a truncated key, and an extra (unMAC'd) key.
  {
    const { client, server } = ok();
    const p0 = client.seal("proof", [CR, PB]);
    assert.deepEqual(server.open("proof", { cr_proof: "zz", pb_proof: PB, ...p0 }, names), { ok: false, reason: "bad_shape" });
    assert.deepEqual(server.open("proof", { cr_proof: CR, pb_proof: `${PB.slice(0, -1)}\n`, ...p0 }, names), { ok: false, reason: "bad_shape" });
    assert.deepEqual(server.open("proof", { cr_proof: CR, pb_proof: PB, feed_key_hex: FEED, ...p0 }, names), { ok: false, reason: "bad_shape" });
    // A missing noise_pk in a feed frame is a shape refusal, never accepted.
    const fresh = ok();
    const f1 = fresh.client.seal("feed", [FEED, NPK]);
    assert.equal(f1.sm_ctr, 0);
    assert.deepEqual(fresh.server.open("feed", { feed_key_hex: FEED, ...f1 }, ["feed_key_hex", "noise_pk"]), { ok: false, reason: "bad_shape" });
    assert.deepEqual(fresh.server.open("feed", { feed_key_hex: FEED, noise_pk: NPK, ...f1 }, ["feed_key_hex", "noise_pk"]), { ok: true, reason: null });
  }
  // A bad MAC (right shape, wrong key material) is bad_mac.
  {
    const { client } = ok();
    const otherKeys = deriveSessionKeys(kPb(), { client: C, server: S, cN: CN, sN: SN, th: transcriptHash(C1, Buffer.from("other")) });
    const server2 = new SessionChannel({ keys: otherKeys, role: "server" });
    const p0 = { cr_proof: CR, pb_proof: PB, ...client.seal("proof", [CR, PB]) };
    assert.deepEqual(server2.open("proof", p0, names), { ok: false, reason: "bad_mac" });
  }
  // NULL_SESSION: the auto-legacy branch's channel.
  assert.deepEqual(NULL_SESSION.seal("proof", [CR, PB]), {});
  assert.deepEqual(NULL_SESSION.open("proof", { anything: 1 }, names), { ok: true, reason: null });
});

// ── S-5 ────────────────────────────────────────────────────────────────────
test("S-5 decideSession: the negotiation table, bound AND negotiated", () => {
  const d = (o) => decideSession({ bound: true, negotiated: false, peerOffered: false, macResult: null, mode: "require", ...o });
  // negotiated + a good MAC → a session, whatever the mode.
  for (const mode of ["auto", "require"]) {
    assert.deepEqual(d({ negotiated: true, macResult: { ok: true }, mode }), { ok: true, legacySession: false, reason: null });
  }
  // negotiated + missing/bad → refused as sm_invalid, never legacy.
  for (const r of [{ ok: false, reason: "missing" }, { ok: false, reason: "bad_mac" }, { ok: false, reason: "bad_ctr" }, null]) {
    assert.deepEqual(d({ negotiated: true, macResult: r }), { ok: false, legacySession: false, reason: "sm_invalid" });
  }
  // not negotiated, peer did not offer, require → sm_required.
  assert.deepEqual(d({ mode: "require" }), { ok: false, legacySession: false, reason: "sm_required" });
  // not negotiated, peer did not offer, auto → the legacy session (PT-2a semantics).
  assert.deepEqual(d({ mode: "auto" }), { ok: true, legacySession: true, reason: null });
  // Nothing but the exact string "auto" is auto.
  for (const mode of [undefined, "", "off", "AUTO"]) assert.equal(d({ mode }).reason, "sm_required", String(mode));
  // A peer that claims sm while this side cannot bind is never a silent fallback.
  assert.deepEqual(d({ peerOffered: true, mode: "auto" }), { ok: false, legacySession: false, reason: "sm_invalid" });
  // Not bound: decidePairBinding already decided; no keys are derived here.
  assert.deepEqual(d({ bound: false, mode: "require" }), { ok: true, legacySession: true, reason: null });
  // A NEGOTIATED session over an UNBOUND pair is a contradiction (fix wave):
  // an `auto`, unpinned peer that proved no pair key leaves the pair decision
  // legacy, yet a session was negotiated — refused as sm_invalid, never run.
  for (const mode of ["auto", "require"]) {
    assert.deepEqual(d({ bound: false, negotiated: true, peerOffered: true, macResult: { ok: true }, mode }), { ok: false, legacySession: false, reason: "sm_invalid" }, mode);
  }
  // A peer that merely OFFERS sm while neither side can bind stays on the pair
  // decision's legacy path (the store-unreadable escape in `auto`).
  assert.deepEqual(d({ bound: false, peerOffered: true, mode: "auto" }), { ok: true, legacySession: true, reason: null });
  assert.equal(SM_VERSION, 1);
});

// ── S-6 ────────────────────────────────────────────────────────────────────
test("S-6 (weak) no derived session key equals a PT-2a MAC over the same labels", () => {
  const k = kPb();
  const th = transcriptHash(C1, S1);
  const keys = deriveSessionKeys(k, { client: C, server: S, cN: CN, sN: SN, th });
  const macs = [
    tailnetRespMac(k, { server: S, client: C, cN: CN, sN: SN }),
    tailnetProofMac(k, { client: C, server: S, sN: SN, cN: CN }),
    hyperswarmMac(k, { responder: S, challenger: C, challenge: CN, handshakeHash: SN }),
  ];
  for (const dir of ["c2s", "s2c"]) {
    const keyHex = keys[dir].toString("hex");
    for (const m of macs) assert.notEqual(keyHex, m);
    assert.notEqual(keyHex, k.toString("hex"));
  }
});