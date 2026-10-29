/**
 * Crow-to-Crow plan 1, task 1: once a contact is admitted, the pre-admission
 * caps stop counting and each line is held to postAdmitLineMax (262144 bytes,
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
import { PeerManager } from "../servers/sharing/peer-manager.js";
import { deriveInstanceIdentity, generateInviteCode, parseInviteCode, sign } from "../servers/sharing/identity.js";
import { upsertFullContact } from "../servers/sharing/contact-promote.js";
import { contactCbMessage, wireContactBinding } from "../servers/sharing/contact-binding.js";
import { initSharingRuntime } from "../servers/sharing/boot.js";

const T = { timeout: 30_000 };
const CAP = 262_144;
const CLAIMED = "inst-claimed-by-peer";

const realWarn = console.warn, realLog = console.log;
console.warn = () => {}; console.log = () => {};
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
  const pm = new PeerManager(side.identity, { env: {}, ...opts });
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
async function admittedRaw(t, A, B, opts) {
  await addContact(A, B);
  const pa = await newPeer(A, opts);
  const R = await rawTo(t, pa.pm);
  const ch = await R.next("challenge");
  assert.ok(ch, "pm sent its challenge");
  await R.conn.opened;
  const hh = Buffer.from(R.conn.handshakeHash).toString("hex");
  const cbSig = sign(contactCbMessage({ role: "resp", signerCrowId: B.identity.crowId, challengeHex: ch.challenge, handshakeHashHex: hh }), B.identity.ed25519Priv);
  R.send(
    { type: "challenge", challenge: randomBytes(32).toString("hex"), cb: 1, crowId: B.identity.crowId, pubkey: B.identity.ed25519Pubkey, instance_id: CLAIMED },
    { type: "challenge-response", crowId: B.identity.crowId, pubkey: B.identity.ed25519Pubkey, cb_sig: cbSig },
    { type: "authenticated" },
  );
  assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId), 5000), "control: the contact is admitted");
  return { pa, R };
}

/** A `data` frame whose JSON line is exactly `bytes` long (no newline). */
function dataLine(bytes) {
  const base = JSON.stringify({ type: "data", payload: { type: "noop", pad: "" } });
  const line = JSON.stringify({ type: "data", payload: { type: "noop", pad: "x".repeat(bytes - base.length) } });
  assert.equal(Buffer.byteLength(line), bytes);
  return line;
}

test("the default cap is 262144 bytes; CROW_PEER_LINE_MAX_BYTES overrides; junk falls back", () => {
  const id = deriveInstanceIdentity(randomBytes(32));
  assert.equal(new PeerManager(id, { env: {} }).postAdmitLineMax, CAP);
  assert.equal(new PeerManager(id, { env: { CROW_PEER_LINE_MAX_BYTES: "1024" } }).postAdmitLineMax, 1024);
  for (const bad of ["0", "-5", "abc", "1e3", ""]) {
    assert.equal(new PeerManager(id, { env: { CROW_PEER_LINE_MAX_BYTES: bad } }).postAdmitLineMax, CAP, JSON.stringify(bad));
  }
});

test("an admitted peer sending a line over the cap (no newline) is killed", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  const { pa, R } = await admittedRaw(t, A, B);
  R.write("x".repeat(CAP + 1));
  assert.equal(await closedWithin(R, 3000), true, "destroyed");
  assert.deepEqual(pa.peerData, [], "no onPeerData");
});

test("an admitted peer sending a complete data line over the cap is killed, not delivered", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  const { pa, R } = await admittedRaw(t, A, B);
  R.write(dataLine(CAP + 1) + "\n");
  assert.equal(await closedWithin(R, 3000), true, "destroyed");
  assert.deepEqual(pa.peerData, [], "no onPeerData");
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

test("CROW_PEER_LINE_MAX_BYTES lowers the post-admission cap", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  const { pa, R } = await admittedRaw(t, A, B, { env: { CROW_PEER_LINE_MAX_BYTES: "2048" } });
  R.write(dataLine(2048) + "\n");
  assert.ok(await until(() => pa.peerData.length === 1, 5000), "a line at the lowered cap is delivered");
  R.write("x".repeat(2049));
  assert.equal(await closedWithin(R, 3000), true, "a line over the lowered cap is killed");
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
    const pm = new PeerManager(identity, { env: { CROW_PEER_LINE_MAX_BYTES: "4096" } });
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
  assert.equal(A.pm.postAdmitLineMax, 4096);
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
  await writeAndEmit(a, 880001, "y".repeat(20_000));
  assert.ok(await until(() => hasMemory(b.db, 880001), 10_000), "the large entry replicates");
  await sleep(300);
  assert.equal(closed, false, "the sibling link stays open");
});
