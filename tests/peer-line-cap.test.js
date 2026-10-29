/**
 * Crow-to-Crow plan 1, task 1: once a contact is admitted, the pre-admission
 * caps stop counting and each line is held to postAdmitLineMax (32 MiB by
 * default, clamped to [1 MiB, 128 MiB]; the tests lower it to 1 MiB through
 * CROW_PEER_LINE_MAX_BYTES overrides). A partial line that grows past the cap
 * without a newline is killed, and so is a complete line over it. onPeerData
 * learns the proof and the instance id the peer CLAIMED.
 *
 * Harness (as in hyperswarm-contact-auth.test.js): a real PeerManager on a
 * real init-db scratch DB, wired by the real sharing runtime, facing a raw
 * scripted peer over a loopback NoiseSecretStream pair (never the DHT). The
 * raw peer proves the contact's real key with a cb_sig.
 *
 * Sibling (instance) connections are exempt: their stream also carries
 * Hypercore replication, whose JSON blocks have no raw newline. The last test
 * links two real paired siblings (real InstanceSyncManagers and feeds, wired
 * through wireInstanceSync as boot.js does) and replicates one entry far over
 * a lowered cap: it lands and the link stays open.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import NoiseSecretStream from "@hyperswarm/secret-stream";

import {
  makeRealDb, socketPair, until, sleep, makeSharedIdentity, addPeerRow, hasMemory, writeAndEmit, SHARED_CROW_ID,
} from "./fixtures/sync-fleet.mjs";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { wireInstanceSync } from "../servers/sharing/instance-connect.js";
import {
  PeerManager, PeerLineOverCapError, isPeerLineOverCap, parsePeerLineMax,
  PEER_LINE_MAX_MAX, PEER_LINE_MAX_DEFAULT, PEER_LINE_MAX_MIN, SECRET_STREAM_MAX_ATOMIC_WRITE as PM_ATOMIC,
} from "../servers/sharing/peer-manager.js";
import { deriveInstanceIdentity, generateInviteCode, parseInviteCode, sign } from "../servers/sharing/identity.js";
import { upsertFullContact } from "../servers/sharing/contact-promote.js";
import { contactCbMessage, wireContactBinding } from "../servers/sharing/contact-binding.js";
import { initSharingRuntime, deliverPendingShares } from "../servers/sharing/boot.js";

const T = { timeout: 30_000 };
// The tests drive the cap through the env, at the clamp floor for speed.
const CAP = 1024 * 1024;
const CAP_ENV = { CROW_PEER_LINE_MAX_BYTES: String(CAP) };
const CLAIMED = "inst-claimed-by-peer";

const realWarn = console.warn, realLog = console.log;
const warnings = [];
console.warn = (...a) => { warnings.push(a.map(String).join(" ")); }; console.log = () => {};
process.on("exit", () => { console.warn = realWarn; console.log = realLog; });

async function makeSide(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `linecap-${name}-`));
  const db = await makeRealDb(dir);
  const identity = deriveInstanceIdentity(randomBytes(32));
  t.after(() => { try { db.close?.(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { name, identity, db, localId: `inst-${name}-${randomBytes(3).toString("hex")}` };
}

async function addContact(side, other) {
  const p = parseInviteCode(generateInviteCode(other.identity));
  return upsertFullContact(side.db, {}, { crowId: p.crowId, ed25519Pub: p.ed25519Pubkey, secp256k1Pub: p.secp256k1Pubkey });
}

async function newPeer(side, opts = {}) {
  const pm = new PeerManager(side.identity, { env: CAP_ENV, ...opts });
  pm.p2pDisabled = true;
  await initSharingRuntime({
    db: side.db, identity: side.identity, peerManager: pm,
    syncManager: { initContact: async () => {}, closeContactFeeds: async () => {} },
    instanceSyncManager: { localInstanceId: side.localId, feedsDisabled: true },
    nostrManager: { subscribeToContact: async () => {}, subscribeToIncoming: async () => {}, unsubscribeFromContact: async () => {} },
  }, { applyProjectCloneBundle: async () => ({}), buildProjectCloneBundle: async () => ({}) });
  const peerData = [];
  const inner = pm.onPeerData;
  pm.onPeerData = (...a) => { peerData.push(a); return inner(...a); };
  return { pm, peerData };
}

/** A raw scripted peer facing `pm`. */
async function rawTo(t, pm) {
  const [s1, s2] = await socketPair();
  const p = new NoiseSecretStream(true, s1);
  const r = new NoiseSecretStream(false, s2);
  p.on("error", () => {}); r.on("error", () => {});
  pm._handleConnection(p, {});
  const frames = [];
  let buf = "", closed = false;
  const closedP = new Promise((res) => r.once("close", () => { closed = true; res(); }));
  r.on("data", (d) => {
    buf += d.toString();
    const ls = buf.split("\n");
    buf = ls.pop();
    for (const l of ls) if (l.trim()) { try { frames.push(JSON.parse(l)); } catch {} }
  });
  t.after(() => { p.destroy(); r.destroy(); });
  const R = {
    conn: r, frames, closedP,
    get closed() { return closed; },
    send: (...objs) => r.write(objs.map((o) => JSON.stringify(o) + "\n").join("")),
    write: (s) => r.write(s),
    async next(type, ms = 3000) {
      await until(() => frames.some((f) => f.type === type), ms, 5);
      return frames.find((f) => f.type === type) || null;
    },
  };
  return R;
}

async function closedWithin(R, ms) {
  await Promise.race([R.closedP, sleep(ms)]);
  return R.closed;
}

/** Raw peer claims `claim` (proving its real key with a cb_sig), claiming CLAIMED as its instance. */
async function admittedRaw(t, A, B, opts, { claimed = CLAIMED, auth = true, authFrame = { type: "authenticated" } } = {}) {
  await addContact(A, B);
  const pa = await newPeer(A, opts);
  const R = await rawTo(t, pa.pm);
  const ch = await R.next("challenge");
  assert.ok(ch, "pm sent its challenge");
  await R.conn.opened;
  const hh = Buffer.from(R.conn.handshakeHash).toString("hex");
  const cbSig = sign(contactCbMessage({ role: "resp", signerCrowId: B.identity.crowId, challengeHex: ch.challenge, handshakeHashHex: hh }), B.identity.ed25519Priv);
  const ask = { type: "challenge", challenge: randomBytes(32).toString("hex"), cb: 1, crowId: B.identity.crowId, pubkey: B.identity.ed25519Pubkey };
  if (claimed !== null) ask.instance_id = claimed; // null: no instance_id at all
  const frames = [ask, { type: "challenge-response", crowId: B.identity.crowId, pubkey: B.identity.ed25519Pubkey, cb_sig: cbSig }];
  if (auth) frames.push(authFrame);
  R.send(...frames);
  if (auth) assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId), 5000), "control: the contact is admitted");
  else assert.ok(await R.next("authenticated"), "pm admitted the raw peer (its authenticated frame arrived)");
  return { pa, R, B };
}

/** Write `s` in `n`-byte pieces, one write per piece, yielding between them. */
async function trickle(R, s, n) {
  for (let i = 0; i < s.length; i += n) {
    if (R.closed) return;
    R.write(s.slice(i, i + n));
    await new Promise((r) => setImmediate(r));
  }
}

/** A `data` frame whose JSON line is exactly `bytes` long (no newline). */
function dataLine(bytes) {
  const base = JSON.stringify({ type: "data", payload: { type: "noop", pad: "" } });
  const line = JSON.stringify({ type: "data", payload: { type: "noop", pad: "x".repeat(bytes - base.length) } });
  assert.equal(Buffer.byteLength(line), bytes);
  return line;
}

// @hyperswarm/secret-stream does not export it: MAX_ATOMIC_WRITE = 256 * 256 * 256 - 1
// (node_modules/@hyperswarm/secret-stream/index.js:13, enforced at :481). A
// write over it returns OK and then destroys both ends.
const SECRET_STREAM_MAX_ATOMIC_WRITE = 16_777_215;
const CEILING = SECRET_STREAM_MAX_ATOMIC_WRITE - 64 * 1024; // 16,711,679

test("the cap defaults to (and is capped at) MAX_ATOMIC_WRITE - 64 KiB; CROW_PEER_LINE_MAX_BYTES lowers it to the 1 MiB floor; clamped or ignored values warn once", () => {
  assert.equal(PEER_LINE_MAX_MAX, CEILING);
  assert.equal(PEER_LINE_MAX_DEFAULT, CEILING);
  assert.equal(PEER_LINE_MAX_MIN, 1024 * 1024);
  assert.equal(PM_ATOMIC, SECRET_STREAM_MAX_ATOMIC_WRITE, "peer-manager pins the same secret-stream limit");
  const id = deriveInstanceIdentity(randomBytes(32));
  const MiB = 1024 * 1024;
  const capOf = (v) => new PeerManager(id, { env: v === undefined ? {} : { CROW_PEER_LINE_MAX_BYTES: v } }).postAdmitLineMax;
  assert.equal(capOf(undefined), CEILING);
  assert.equal(capOf(String(5 * MiB)), 5 * MiB);
  assert.equal(capOf(` ${2 * MiB} `), 2 * MiB, "surrounding spaces are trimmed");
  // Clamped: 0 and too small → 1 MiB; too large (even past Number range) → the ceiling.
  for (const v of ["0", "1", "1024", String(MiB - 1)]) assert.equal(capOf(v), MiB, v);
  for (const v of [String(CEILING + 1), String(SECRET_STREAM_MAX_ATOMIC_WRITE), String(32 * MiB), "99999999999999", "9".repeat(400)]) {
    assert.equal(capOf(v), CEILING, v.slice(0, 20));
  }
  // Not a digit string → the default.
  for (const v of ["-5", "abc", "1e9", "1.5", "32MiB"]) assert.equal(capOf(v), CEILING, JSON.stringify(v));
  // The constructor option is clamped too.
  assert.equal(new PeerManager(id, { env: {}, postAdmitLineMax: 0 }).postAdmitLineMax, MiB);
  assert.equal(new PeerManager(id, { env: {}, postAdmitLineMax: Infinity }).postAdmitLineMax, CEILING);
  assert.equal(new PeerManager(id, { env: {}, postAdmitLineMax: 64 * MiB }).postAdmitLineMax, CEILING);
  // Whatever the env says, the effective max (plus its newline) fits one atomic write.
  for (const v of [undefined, "0", String(64 * MiB), "9".repeat(400), "junk", String(CEILING)]) {
    assert.ok(capOf(v) + 1 < SECRET_STREAM_MAX_ATOMIC_WRITE, `effective max under MAX_ATOMIC_WRITE for ${String(v).slice(0, 20)}`);
  }
  // The pre-admission caps are separate and unchanged.
  const pm = new PeerManager(id, { env: { CROW_PEER_LINE_MAX_BYTES: String(64 * MiB) } });
  assert.equal(pm.preAuthMaxBytes, 65_536);
  assert.equal(pm.preAuthMaxLines, 64);
});

test("a clamped or ignored CROW_PEER_LINE_MAX_BYTES warns once per value; a value in range does not warn", () => {
  const id = deriveInstanceIdentity(randomBytes(32));
  const lines = (from) => warnings.slice(from).filter((l) => l.startsWith("[peer-manager] CROW_PEER_LINE_MAX_BYTES "));
  let at = warnings.length;
  new PeerManager(id, { env: { CROW_PEER_LINE_MAX_BYTES: "77" } });
  new PeerManager(id, { env: { CROW_PEER_LINE_MAX_BYTES: "77" } });
  assert.equal(lines(at).length, 1, "clamped: one warning for two managers");
  assert.match(lines(at)[0], /clamped to 1048576/);
  at = warnings.length;
  new PeerManager(id, { env: { CROW_PEER_LINE_MAX_BYTES: "lots" } });
  new PeerManager(id, { env: { CROW_PEER_LINE_MAX_BYTES: "lots" } });
  assert.equal(lines(at).length, 1, "ignored: one warning");
  assert.match(lines(at)[0], /ignored/);
  at = warnings.length;
  new PeerManager(id, { env: { CROW_PEER_LINE_MAX_BYTES: String(3 * 1024 * 1024) } });
  new PeerManager(id, { env: {} });
  assert.equal(lines(at).length, 0, "in range or unset: no warning");
});

test("parsePeerLineMax: an integer is clamped to [1 MiB, the ceiling]; anything else is ignored (null)", () => {
  assert.equal(parsePeerLineMax(2 * 1024 * 1024), 2 * 1024 * 1024);
  assert.equal(parsePeerLineMax(5), 1024 * 1024);
  assert.equal(parsePeerLineMax(0), 1024 * 1024);
  assert.equal(parsePeerLineMax(-1), 1024 * 1024);
  assert.equal(parsePeerLineMax(10 ** 12), CEILING);
  for (const bad of [undefined, null, "2097152", 1.5, NaN, Infinity, {}, [], true, 2 ** 60]) {
    assert.equal(parsePeerLineMax(bad), null, String(bad));
  }
});

test("an admitted peer sending a line over the cap (no newline) is killed", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  const { pa, R } = await admittedRaw(t, A, B);
  R.write("x".repeat(CAP + 1));
  assert.equal(await closedWithin(R, 3000), true, "destroyed");
  assert.deepEqual(pa.peerData, [], "no onPeerData");
});

test("an admitted peer sending a complete data line over the cap is killed, not delivered, and logged by size only", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  const { pa, R } = await admittedRaw(t, A, B);
  const before = warnings.length;
  const line = dataLine(CAP + 1).replace('"pad":"x', '"pad":"SECRETMARKER');
  R.write(line + "\n");
  assert.equal(await closedWithin(R, 3000), true, "destroyed");
  assert.deepEqual(pa.peerData, [], "no onPeerData");
  const logged = warnings.slice(before).filter((l) => l.startsWith("[peer-manager] contact line over cap "));
  assert.ok(logged.length >= 1, "an over-cap line is logged");
  assert.match(logged[0], new RegExp(`^\\[peer-manager\\] contact line over cap ${B.identity.crowId.replace(/[:.]/g, "\\$&")} \\d+$`));
  assert.ok(Number(logged[0].split(" ").pop()) > CAP, "the size is logged");
  assert.equal(warnings.some((l) => l.includes("SECRETMARKER")), false, "never the content");
});

test("send() refuses a frame over the cap before writing anything; a frame at the cap is written", () => {
  const pm = new PeerManager(deriveInstanceIdentity(randomBytes(32)), { env: CAP_ENV });
  const writes = [];
  pm.connections.set("crow:peer", { conn: { write: (d) => writes.push(d) }, authenticated: true });
  const base = JSON.stringify({ type: "data", payload: { pad: "" } }).length;
  pm.send("crow:peer", { pad: "x".repeat(CAP - base) });
  assert.equal(writes.length, 1, "at the cap: written");
  assert.equal(Buffer.byteLength(writes[0]), CAP + 1, "the line plus its newline");
  let err = null;
  try { pm.send("crow:peer", { pad: "x".repeat(CAP - base + 1) }); } catch (e) { err = e; }
  assert.ok(err instanceof PeerLineOverCapError, "a distinct refusal");
  assert.ok(isPeerLineOverCap(err));
  assert.equal(err.bytes, CAP + 1);
  assert.equal(err.cap, CAP);
  assert.equal(writes.length, 1, "nothing written for the over-cap frame");
  assert.equal(isPeerLineOverCap(new Error("Not connected")), false);
});

test("an admitted line at the cap is delivered, with proof and the claimed instanceId", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  const { pa, R } = await admittedRaw(t, A, B);
  R.write(dataLine(CAP) + "\n");
  assert.ok(await until(() => pa.peerData.length === 1, 5000), "onPeerData called");
  const [crowId, payload, meta] = pa.peerData[0];
  assert.equal(crowId, B.identity.crowId);
  assert.equal(payload.type, "noop");
  assert.equal(payload.pad.length, CAP - JSON.stringify({ type: "data", payload: { type: "noop", pad: "" } }).length);
  assert.deepEqual(meta, { proof: "cb", instanceId: CLAIMED });
  assert.equal(R.closed, false, "still open");
});

test("CROW_PEER_LINE_MAX_BYTES inside the clamp is honoured", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  const LOW = CAP + 4096; // any value inside the clamp is honoured
  const { pa, R } = await admittedRaw(t, A, B, { env: { CROW_PEER_LINE_MAX_BYTES: String(LOW) } });
  R.write(dataLine(LOW) + "\n");
  assert.ok(await until(() => pa.peerData.length === 1, 5000), "a line at the set cap is delivered");
  R.write("x".repeat(LOW + 1));
  assert.equal(await closedWithin(R, 3000), true, "a line over the set cap is killed");
  assert.equal(pa.peerData.length, 1);
});

test("the pre-admission cap is unchanged: 65537 bytes with no newline before admission kills", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await addContact(A, B);
  {
    const pa = await newPeer(A);
    assert.equal(pa.pm.preAuthMaxBytes, 65_536);
    assert.equal(pa.pm.preAuthMaxLines, 64);
    const R = await rawTo(t, pa.pm);
    await R.next("challenge");
    R.write("x".repeat(65_537));
    assert.equal(await closedWithin(R, 3000), true, "destroyed before admission");
    assert.deepEqual(pa.peerData, []);
  }
  {
    // Control: 65535 bytes (under the pre-auth cap, far under the post-admission
    // one) stays open until the pre-auth timer.
    const pa = await newPeer(A, { preAuthMs: 10_000 });
    const R = await rawTo(t, pa.pm);
    await R.next("challenge");
    R.write("x".repeat(65_535));
    assert.equal(await closedWithin(R, 500), false, "control: under the cap stays open");
  }
});

test("a sibling (instance) connection is exempt: one replicated entry far over the cap lands and the link stays open", { timeout: 60_000 }, async (t) => {
  const identity = await makeSharedIdentity();
  const sides = [];
  for (const n of ["a", "b"]) {
    const dir = mkdtempSync(join(tmpdir(), `linecap-sib-${n}-`));
    const db = await makeRealDb(dir);
    const id = `inst-${n}-${randomBytes(3).toString("hex")}`;
    const mgr = new InstanceSyncManager(identity, db, id);
    mgr.dataDir = join(dir, "instance-sync");
    mgr.feedsDisabled = false;
    t.after(async () => { try { await mgr.close(); } catch {} try { db.close?.(); } catch {} rmSync(dir, { recursive: true, force: true }); });
    sides.push({ id, db, mgr, pairKeys: new Map() });
  }
  const [a, b] = sides;
  await addPeerRow(a.db, b.id, { crowId: SHARED_CROW_ID });
  await addPeerRow(b.db, a.id, { crowId: SHARED_CROW_ID });
  const pairKey = randomBytes(32).toString("hex");
  a.pairKeys.set(b.id, pairKey); b.pairKeys.set(a.id, pairKey);

  const node = (side) => {
    const pm = new PeerManager(identity, { env: CAP_ENV });
    pm.p2pDisabled = true;
    pm.localInstanceId = side.id;
    wireContactBinding(pm, { db: side.db, localInstanceId: () => side.id });
    wireInstanceSync(pm, { db: side.db, instanceSyncManager: side.mgr, pairKeyLookup: (id) => side.pairKeys.get(id) ?? null, mode: "auto" });
    const connected = [], keys = [];
    const ic = pm.onInstanceConnected, ik = pm.onInstanceKeyReceived;
    pm.onInstanceConnected = (...x) => { connected.push(x); return ic(...x); };
    pm.onInstanceKeyReceived = (...x) => { keys.push(x); return ik(...x); };
    return { pm, connected, keys };
  };
  const A = node(a), B = node(b);
  assert.equal(A.pm.postAdmitLineMax, CAP);
  const [s1, s2] = await socketPair();
  const x = new NoiseSecretStream(true, s1), y = new NoiseSecretStream(false, s2);
  x.on("error", () => {}); y.on("error", () => {});
  let closed = false;
  x.once("close", () => { closed = true; }); y.once("close", () => { closed = true; });
  A.pm._handleConnection(x, {});
  B.pm._handleConnection(y, {});
  t.after(() => { x.destroy(); y.destroy(); });

  assert.ok(await until(() => A.connected.length === 1 && B.connected.length === 1, 8000), "siblings admitted");
  assert.ok(await until(() => A.keys.length === 1 && B.keys.length === 1, 5000), "feed keys both ways");
  await writeAndEmit(a, 880001, "y".repeat(CAP + 200_000));
  assert.ok(await until(() => hasMemory(b.db, 880001), 10_000), "the large entry replicates");
  await sleep(300);
  assert.equal(closed, false, "the sibling link stays open");
});

test("meta.instanceId is null when the claimed id is not in the enroll-id shape (or absent)", T, async (t) => {
  for (const claimed of ["bad id!", "-leading-dash", "x".repeat(129), null]) {
    const A = await makeSide(t, "A"), B = await makeSide(t, "B");
    const { pa, R } = await admittedRaw(t, A, B, {}, { claimed });
    R.write(dataLine(100) + "\n");
    assert.ok(await until(() => pa.peerData.length === 1, 5000), `${JSON.stringify(claimed)}: delivered`);
    assert.deepEqual(pa.peerData[0][2], { proof: "cb", instanceId: null }, JSON.stringify(claimed));
  }
  // Control: the longest valid shape passes through.
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  const ok = "a" + "b".repeat(127);
  const { pa, R } = await admittedRaw(t, A, B, {}, { claimed: ok });
  R.write(dataLine(100) + "\n");
  assert.ok(await until(() => pa.peerData.length === 1, 5000));
  assert.deepEqual(pa.peerData[0][2], { proof: "cb", instanceId: ok });
});

test("a trickled line: over the cap in 64 KiB writes is killed; at the cap it is delivered", { timeout: 60_000 }, async (t) => {
  {
    const A = await makeSide(t, "A"), B = await makeSide(t, "B");
    const { pa, R } = await admittedRaw(t, A, B);
    await trickle(R, dataLine(CAP), 64 * 1024);
    await sleep(100);
    assert.equal(R.closed, false, "control: a partial line at the cap stays open");
    R.write("\n");
    assert.ok(await until(() => pa.peerData.length === 1, 5000), "the trickled line at the cap is delivered");
  }
  {
    const A = await makeSide(t, "A"), B = await makeSide(t, "B");
    const { pa, R } = await admittedRaw(t, A, B);
    await trickle(R, "x".repeat(CAP + 1), 64 * 1024);
    assert.equal(await closedWithin(R, 3000), true, "the trickled over-cap line is killed");
    assert.deepEqual(pa.peerData, []);
  }
});

test("the pre-admission cap still counts a trickled partial line: 65537 bytes in 1 KiB writes kills", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await addContact(A, B);
  const pa = await newPeer(A, { preAuthMs: 10_000 });
  const R = await rawTo(t, pa.pm);
  await R.next("challenge");
  await trickle(R, "x".repeat(65_535), 1024);
  await sleep(100);
  assert.equal(R.closed, false, "control: 65535 bytes stays open");
  R.write("xx");
  assert.equal(await closedWithin(R, 3000), true, "the byte over 65536 kills");
});

test("same-chunk transition: the peer's authenticated line and an over-cap partial line in one write is killed by the post-admission cap", T, async (t) => {
  // The pre-auth byte cap is raised far above the line cap, so only the
  // post-admission cap can fire.
  const opts = { preAuthMaxBytes: 16 * CAP, preAuthMs: 10_000 };
  {
    const A = await makeSide(t, "A"), B = await makeSide(t, "B");
    const { pa, R } = await admittedRaw(t, A, B, opts, { auth: false });
    R.write(JSON.stringify({ type: "authenticated" }) + "\n" + "x".repeat(CAP));
    assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId), 5000), "control: admitted");
    await sleep(200);
    assert.equal(R.closed, false, "control: a partial line at the cap stays open");
  }
  {
    const A = await makeSide(t, "A"), B = await makeSide(t, "B");
    const { pa, R } = await admittedRaw(t, A, B, opts, { auth: false });
    R.write(JSON.stringify({ type: "authenticated" }) + "\n" + "x".repeat(CAP + 1));
    assert.equal(await closedWithin(R, 3000), true, "the over-cap partial line in the same write is killed");
    assert.deepEqual(pa.peerData, []);
  }
});

// ---------------------------------------------------------------- line_max exchange
const MiB = 1024 * 1024;
const big = (bytes) => ({ pad: "x".repeat(bytes - JSON.stringify({ type: "data", payload: { pad: "" } }).length) });

test("line_max: our authenticated frame advertises our cap; the peer's lower line_max wins in send(); ours wins when it is lower", T, async (t) => {
  {
    // pm 2 MiB, peer advertises 1 MiB → pm sends at most 1 MiB.
    const A = await makeSide(t, "A"), B = await makeSide(t, "B");
    const { pa, R } = await admittedRaw(t, A, B, { env: { CROW_PEER_LINE_MAX_BYTES: String(2 * MiB) } },
      { authFrame: { type: "authenticated", line_max: MiB } });
    const ours = await R.next("authenticated");
    assert.equal(ours.line_max, 2 * MiB, "pm advertises its own cap");
    assert.equal(pa.pm.lineMaxFor(B.identity.crowId), MiB, "the peer's lower cap wins");
    let err = null;
    try { pa.pm.send(B.identity.crowId, big(MiB + 1)); } catch (e) { err = e; }
    assert.ok(isPeerLineOverCap(err), "over the peer's cap: refused");
    assert.equal(err.cap, MiB);
    pa.pm.send(B.identity.crowId, big(MiB)); // at the peer's cap: written
    assert.equal(R.closed, false);
  }
  {
    // pm 1 MiB, peer advertises 4 MiB → pm keeps its own 1 MiB.
    const A = await makeSide(t, "A"), B = await makeSide(t, "B");
    const { pa } = await admittedRaw(t, A, B, {}, { authFrame: { type: "authenticated", line_max: 4 * MiB } });
    assert.equal(pa.pm.lineMaxFor(B.identity.crowId), MiB, "our lower cap wins");
  }
});

test("line_max: malformed or missing is ignored (our own cap); an out-of-range integer is clamped", T, async (t) => {
  const own = 2 * MiB;
  for (const [label, frame, want] of [
    ["missing (an older peer)", { type: "authenticated" }, own],
    ["a string", { type: "authenticated", line_max: "1048576" }, own],
    ["a fraction", { type: "authenticated", line_max: 1048576.5 }, own],
    ["an object", { type: "authenticated", line_max: { n: 1 } }, own],
    ["null", { type: "authenticated", line_max: null }, own],
    ["tiny integer → the 1 MiB floor", { type: "authenticated", line_max: 10 }, MiB],
    ["huge integer → our own", { type: "authenticated", line_max: 2 ** 40 }, own],
  ]) {
    const A = await makeSide(t, "A"), B = await makeSide(t, "B");
    const { pa } = await admittedRaw(t, A, B, { env: { CROW_PEER_LINE_MAX_BYTES: String(own) } }, { authFrame: frame });
    assert.equal(pa.pm.lineMaxFor(B.identity.crowId), want, label);
  }
});

test("line_max between two real PeerManagers: the lower cap wins in each direction", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await addContact(A, B); await addContact(B, A);
  const pa = await newPeer(A, { env: { CROW_PEER_LINE_MAX_BYTES: String(MiB) } });
  const pb = await newPeer(B, { env: { CROW_PEER_LINE_MAX_BYTES: String(2 * MiB) } });
  const [s1, s2] = await socketPair();
  const x = new NoiseSecretStream(true, s1), y = new NoiseSecretStream(false, s2);
  x.on("error", () => {}); y.on("error", () => {});
  pa.pm._handleConnection(x, {}); pb.pm._handleConnection(y, {});
  t.after(() => { x.destroy(); y.destroy(); });
  assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId) && pb.pm.isConnected(A.identity.crowId), 5000), "admitted both ways");
  assert.equal(pa.pm.lineMaxFor(B.identity.crowId), MiB, "A (1 MiB) keeps its own");
  assert.equal(pb.pm.lineMaxFor(A.identity.crowId), MiB, "B (2 MiB) keeps under A's 1 MiB");
  assert.throws(() => pb.pm.send(A.identity.crowId, big(MiB + 1)), (e) => isPeerLineOverCap(e) && e.cap === MiB);
  pb.pm.send(A.identity.crowId, { type: "noop", ...big(MiB - 64) });
  assert.ok(await until(() => pa.peerData.length === 1, 5000), "a frame under both caps is delivered");
  assert.equal(x.destroyed || y.destroyed, false, "the link stays up");
});

// ---------------------------------------------------------------- multi-byte content
/** A data line of exactly `bytes` UTF-8 bytes whose pad is emoji + CJK (4 + 3 bytes per pair). */
function dataLineMB(bytes) {
  const base = JSON.stringify({ type: "data", payload: { type: "noop", pad: "" } });
  const room = bytes - Buffer.byteLength(base);
  const pairs = Math.floor(room / 7);
  const pad = "😀漢".repeat(pairs) + "y".repeat(room - pairs * 7);
  const line = JSON.stringify({ type: "data", payload: { type: "noop", pad } });
  assert.equal(Buffer.byteLength(line), bytes);
  return { line, pad };
}

test("multi-byte content near the cap: the cap counts UTF-8 bytes, not characters (receiver and send())", T, async (t) => {
  {
    const A = await makeSide(t, "A"), B = await makeSide(t, "B");
    const { pa, R } = await admittedRaw(t, A, B);
    const { line, pad } = dataLineMB(CAP);
    assert.ok(line.length < CAP, "fewer characters than bytes");
    R.write(line + "\n");
    assert.ok(await until(() => pa.peerData.length === 1, 5000), "at the cap in bytes: delivered");
    assert.equal(pa.peerData[0][1].pad, pad, "intact");
  }
  {
    const A = await makeSide(t, "A"), B = await makeSide(t, "B");
    const { pa, R } = await admittedRaw(t, A, B);
    R.write(dataLineMB(CAP + 1).line + "\n");
    assert.equal(await closedWithin(R, 3000), true, "one byte over: killed");
    assert.deepEqual(pa.peerData, []);
  }
  const pm = new PeerManager(deriveInstanceIdentity(randomBytes(32)), { env: CAP_ENV });
  pm.connections.set("crow:peer", { conn: { write: () => {} }, authenticated: true });
  const chars = "😀漢".repeat(Math.floor(CAP / 2 / 2)); // ~CAP/2 characters, ~1.75 x CAP bytes
  assert.ok(chars.length < CAP);
  assert.throws(() => pm.send("crow:peer", { pad: chars }), (e) => isPeerLineOverCap(e) && e.bytes > CAP);
});

test("a 4-byte character split across two chunks arrives intact (StringDecoder)", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  const { pa, R } = await admittedRaw(t, A, B);
  const pad = "a😀b";
  const buf = Buffer.from(JSON.stringify({ type: "data", payload: { type: "noop", pad } }) + "\n");
  const at = buf.indexOf(Buffer.from("😀")) + 2; // inside the emoji's 4 bytes
  R.write(buf.subarray(0, at));
  await sleep(100); // a separate chunk on the reader's side
  R.write(buf.subarray(at));
  assert.ok(await until(() => pa.peerData.length === 1, 5000), "delivered");
  assert.equal(pa.peerData[0][1].pad, pad, "no replacement characters");
});

// ---------------------------------------------------------------- deliverPendingShares pass
async function queuedThree(t) {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await addContact(A, B);
  const contact = (await A.db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [B.identity.crowId] })).rows[0];
  const ids = [];
  for (const content of ["first SECRETCONTENT", "second", "third"]) {
    const m = await A.db.execute({ sql: "INSERT INTO memories (content) VALUES (?)", args: [content] });
    const r = await A.db.execute({
      sql: "INSERT INTO shared_items (contact_id, share_type, item_id, direction, delivery_status) VALUES (?, 'memory', ?, 'sent', 'pending')",
      args: [contact.id, Number(m.lastInsertRowid)],
    });
    ids.push(Number(r.lastInsertRowid));
  }
  const status = async () => {
    const out = [];
    for (const id of ids) out.push((await A.db.execute({ sql: "SELECT delivery_status FROM shared_items WHERE id = ?", args: [id] })).rows[0].delivery_status);
    return out;
  };
  return { A, contact, status };
}

/** A PeerManager double with a real-looking connections map; `onSend(n)` decides per call. */
function fakePm(crowId, onSend) {
  const entry = { conn: { destroyed: false }, authenticated: true };
  const pm = { sends: 0, connections: new Map([[crowId, entry]]), entry,
    isConnected: () => true,
    send() { pm.sends++; onSend(pm.sends, pm); } };
  return pm;
}
const deliver = (A, contact, peerManager) => deliverPendingShares({
  db: A.db, peerManager, contact, identityCrowId: A.identity.crowId, buildProjectCloneBundle: async () => ({}),
});

test("deliverPendingShares: a failed write stops the pass; the rest stay pending and go out on the next connection", T, async (t) => {
  const { A, contact, status } = await queuedThree(t);
  const pm = fakePm(contact.crow_id, (n) => { if (n === 2) throw new Error("write after end"); });
  await deliver(A, contact, pm);
  assert.equal(pm.sends, 2, "nothing more is written after the failed write");
  assert.deepEqual(await status(), ["delivered", "pending", "pending"]);
  const pm2 = fakePm(contact.crow_id, () => {});
  await deliver(A, contact, pm2);
  assert.deepEqual(await status(), ["delivered", "delivered", "delivered"], "reconnect: delivered");
});

test("deliverPendingShares: a connection destroyed (or gone) mid-pass stops it; the rest stay pending", T, async (t) => {
  {
    const { A, contact, status } = await queuedThree(t);
    const pm = fakePm(contact.crow_id, (n, p) => { if (n === 1) p.entry.conn.destroyed = true; });
    await deliver(A, contact, pm);
    assert.equal(pm.sends, 1, "no write to a destroyed connection");
    assert.deepEqual(await status(), ["delivered", "pending", "pending"]);
  }
  {
    const { A, contact, status } = await queuedThree(t);
    const pm = fakePm(contact.crow_id, (n, p) => { if (n === 1) p.connections.delete(contact.crow_id); });
    await deliver(A, contact, pm);
    assert.equal(pm.sends, 1, "no write once the connection is gone");
    assert.deepEqual(await status(), ["delivered", "pending", "pending"]);
  }
});

test("deliverPendingShares: an over-cap share (refused before any write) is failed and notified; the two after it still go out in the same pass", T, async (t) => {
  const { A, contact, status } = await queuedThree(t);
  const pm = fakePm(contact.crow_id, (n) => { if (n === 1) throw new PeerLineOverCapError(CAP + 10, CAP); });
  await deliver(A, contact, pm);
  assert.equal(pm.sends, 3);
  assert.deepEqual(await status(), ["failed", "delivered", "delivered"]);
  const notes = (await A.db.execute({ sql: "SELECT title, body FROM notifications WHERE source = 'sharing:share'" })).rows;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, `Share of memory to ${contact.display_name || contact.crow_id} failed: too large (${CAP + 10} bytes, limit ${CAP})`);
  assert.equal(`${notes[0].title} ${notes[0].body ?? ""}`.includes("SECRETCONTENT"), false, "no content");
});
