/**
 * PT-3 (private engineering notes): a Hyperswarm contact is admitted only on
 * its PINNED key, a new node never signs a bare nonce for an asker that has
 * not proven itself (it never answers on another peer's behalf), and every admission side effect
 * happens inside PeerManager._admit.
 *
 * Harness: real PeerManagers, each with its own identity and its own real
 * init-db scratch DB, linked over loopback NoiseSecretStream socket pairs
 * (never the public DHT). Contacts come from the real accept core
 * (upsertFullContact over a parsed invite). The sharing runtime
 * (initSharingRuntime) wires each side's real onPeerConnected / onPeerData and
 * contact binding. "Old" nodes import PeerManager from a worktree at the base
 * commit (tests/fixtures/old-tree.mjs). Non-conforming peers are raw scripted streams.
 *
 * Every negative leg follows a positive control in the same harness.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import NoiseSecretStream from "@hyperswarm/secret-stream";

import { makeRealDb, socketPair, until, sleep } from "./fixtures/sync-fleet.mjs";
import { oldTree } from "./fixtures/old-tree.mjs";
import { PeerManager } from "../servers/sharing/peer-manager.js";
import { deriveInstanceIdentity, generateInviteCode, parseInviteCode, sign } from "../servers/sharing/identity.js";
import { upsertFullContact } from "../servers/sharing/contact-promote.js";
import { contactCbMessage, markCbPinned, CB_PIN_PREFIX } from "../servers/sharing/contact-binding.js";
import { initSharingRuntime } from "../servers/sharing/boot.js";
import { wireInstanceSync } from "../servers/sharing/instance-connect.js";

const PT3_BASE_SHA = "697d5d07ba915994b3d591d55dbce820c2274b14";
const PEER_MANAGER_PATH = new URL("../servers/sharing/peer-manager.js", import.meta.url).pathname;
const T = { timeout: 30_000 };

// ---------------------------------------------------------------- logs
// Refusal and legacy lines are asserted on; everything else is kept quiet.
const logs = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };
const capture = (...a) => { logs.push(a.map(String).join(" ")); };
const refusals = (crowId) => logs
  .filter((l) => l.startsWith(`[peer-manager] contact refused ${crowId}: `))
  .map((l) => l.slice(`[peer-manager] contact refused ${crowId}: `.length));
const legacyLines = (crowId) => logs.filter((l) => l.includes(`contact ${crowId} is on older Crow: no channel binding`));

let OldPeerManager = null;
let old = null;
before(async () => {
  console.log = capture; console.warn = capture;
  old = await oldTree(PT3_BASE_SHA);
  ({ PeerManager: OldPeerManager } = await old.importModule("servers/sharing/peer-manager.js"));
}, { timeout: 300_000 });
after(() => {
  Object.assign(console, realConsole);
  old?.cleanup();
});

// ---------------------------------------------------------------- sides
const id = () => deriveInstanceIdentity(randomBytes(32));

async function makeSide(t, name, identity = id()) {
  const dir = mkdtempSync(join(tmpdir(), `pt3-${name}-`));
  const db = await makeRealDb(dir);
  const side = { name, identity, db, dir, localId: `inst-${name}-${randomBytes(3).toString("hex")}` };
  t.after(() => { try { db.close?.(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return side;
}

/** `side` adds `other` through the real accept core (invite → upsertFullContact). */
async function addContact(side, other) {
  const p = parseInviteCode(generateInviteCode(other.identity ?? other));
  return upsertFullContact(side.db, {}, { crowId: p.crowId, ed25519Pub: p.ed25519Pubkey, secp256k1Pub: p.secp256k1Pubkey });
}
async function befriend(x, y) { await addContact(x, y); await addContact(y, x); }

async function contactId(side, crowId) {
  return (await side.db.execute({ sql: "SELECT id FROM contacts WHERE crow_id = ?", args: [crowId] })).rows[0]?.id;
}

/** A pending memory share from `side` to `toCrowId`; returns the shared_items id. */
async function queueMemoryShare(side, toCrowId, content) {
  const m = await side.db.execute({ sql: "INSERT INTO memories (content) VALUES (?)", args: [content] });
  const r = await side.db.execute({
    sql: "INSERT INTO shared_items (contact_id, share_type, item_id, direction, delivery_status) VALUES (?, 'memory', ?, 'sent', 'pending')",
    args: [await contactId(side, toCrowId), Number(m.lastInsertRowid)],
  });
  return Number(r.lastInsertRowid);
}
async function shareStatus(side, shareId) {
  return (await side.db.execute({ sql: "SELECT delivery_status FROM shared_items WHERE id = ?", args: [shareId] })).rows[0]?.delivery_status;
}
async function hasMemoryContent(side, content) {
  return (await side.db.execute({ sql: "SELECT COUNT(*) AS n FROM memories WHERE content = ?", args: [content] })).rows[0].n > 0;
}
async function pinOf(side, crowId) {
  return (await side.db.execute({
    sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?",
    args: [CB_PIN_PREFIX + crowId, side.localId],
  })).rows[0]?.value ?? null;
}
async function pinCount(side) {
  return (await side.db.execute({ sql: "SELECT COUNT(*) AS n FROM dashboard_settings_overrides WHERE key LIKE 'contact_hs_cb:%'" })).rows[0].n;
}
const memShare = (content) => ({ type: "data", payload: { type: "share", share_type: "memory", payload: { content } } });

// ---------------------------------------------------------------- peers
/**
 * A new PeerManager on `side`. boot: run the real sharing runtime on it (real
 * onPeerConnected / onPeerData, wireContactBinding). Callbacks are wrapped by
 * spies that still call through.
 */
async function newPeer(side, { boot = true, opts = {}, PM = PeerManager } = {}) {
  const pm = new PM(side.identity, { env: {}, ...opts });
  pm.p2pDisabled = true; // never start a swarm: links are loopback socket pairs
  const spies = { peerConnected: [], peerData: [], instanceConnected: [], keyReceived: [] };
  if (boot) {
    const managers = {
      db: side.db, identity: side.identity, peerManager: pm,
      syncManager: { initContact: async () => {}, closeContactFeeds: async () => {} },
      instanceSyncManager: { localInstanceId: side.localId, feedsDisabled: true },
      nostrManager: { subscribeToContact: async () => {}, subscribeToIncoming: async () => {}, unsubscribeFromContact: async () => {} },
    };
    await initSharingRuntime(managers, { applyProjectCloneBundle: async () => ({}), buildProjectCloneBundle: async () => ({}) });
  } else {
    pm.localInstanceId = side.localId;
  }
  const wrap = (name, list) => {
    const inner = pm[name];
    pm[name] = (...a) => { list.push(a); return inner ? inner(...a) : undefined; };
  };
  wrap("onPeerConnected", spies.peerConnected);
  wrap("onPeerData", spies.peerData);
  wrap("onInstanceConnected", spies.instanceConnected);
  wrap("onInstanceKeyReceived", spies.keyReceived);
  return { pm, spies, side };
}

/** Record every frame written on `conn`, plus a snapshot taken at write time. */
function tapWrites(conn, snap = () => null) {
  const frames = [];
  const orig = conn.write.bind(conn);
  conn.write = (data, ...rest) => {
    for (const l of String(data).split("\n")) {
      if (!l.trim()) continue;
      let f; try { f = JSON.parse(l); } catch { f = { raw: l }; }
      frames.push({ ...f, _snap: snap(f) });
    }
    return orig(data, ...rest);
  };
  return frames;
}

async function streams(xInitiator = true) {
  const [s1, s2] = await socketPair();
  const x = new NoiseSecretStream(xInitiator, s1);
  const y = new NoiseSecretStream(!xInitiator, s2);
  x.on("error", () => {}); y.on("error", () => {});
  return [x, y];
}
const hashHex = async (conn) => { await conn.opened; return Buffer.from(conn.handshakeHash).toString("hex"); };

/** Link two PeerManagers. */
async function link(t, pa, pb, { aInitiator = true, snapA, snapB } = {}) {
  const [a, b] = await streams(aInitiator);
  const wa = tapWrites(a, snapA), wb = tapWrites(b, snapB);
  pa._handleConnection(a, {});
  pb._handleConnection(b, {});
  t.after(() => { a.destroy(); b.destroy(); });
  return { a, b, wa, wb };
}

/** A raw scripted peer facing `pm`. */
async function rawTo(t, pm, { pmInitiator = true } = {}) {
  const [p, r] = await streams(pmInitiator);
  const pmWrites = tapWrites(p);
  pm._handleConnection(p, {});
  const frames = [];
  let buf = "";
  let closed = false;
  const closedP = new Promise((res) => r.once("close", () => { closed = true; res(); }));
  r.on("data", (d) => {
    buf += d.toString();
    const ls = buf.split("\n");
    buf = ls.pop();
    for (const l of ls) if (l.trim()) { try { frames.push(JSON.parse(l)); } catch {} }
  });
  t.after(() => { p.destroy(); r.destroy(); });
  return {
    pmConn: p, conn: r, frames, pmWrites, closedP,
    get closed() { return closed; },
    send: (...objs) => r.write(objs.map((o) => JSON.stringify(o) + "\n").join("")),
    write: (s) => r.write(s),
    async next(type, ms = 3000) {
      await until(() => frames.some((f) => f.type === type), ms, 5);
      return frames.find((f) => f.type === type) || null;
    },
    hash: () => hashHex(r),
  };
}

/**
 * Raw responder: answer pm's challenge claiming `claim`, proving with
 * `signer`'s key, as a bare signature ("sig") or a channel binding ("cb").
 */
async function rawLeg(t, pm, { claim, signer, mode = "sig", pubkey = signer.ed25519Pubkey, extra = [], pre = [], challenge = null, auth = true }) {
  const R = await rawTo(t, pm);
  const ch = await R.next("challenge");
  assert.ok(ch, "pm sent its challenge");
  const resp = { type: "challenge-response", crowId: claim.crowId };
  if (pubkey !== undefined) resp.pubkey = pubkey;
  if (mode === "sig") resp.signature = sign(ch.challenge, signer.ed25519Priv);
  if (mode === "cb") {
    const handshakeHashHex = await R.hash();
    resp.cb_sig = sign(contactCbMessage({ role: R.conn.isInitiator ? "init" : "resp", signerCrowId: claim.crowId, challengeHex: ch.challenge, handshakeHashHex }), signer.ed25519Priv);
  }
  const out = [];
  if (challenge) out.push(challenge);
  out.push(...pre, resp);
  if (auth) out.push({ type: "authenticated" }); // the raw peer "admits" pm too (mutual admission)
  out.push(...extra);
  R.send(...out);
  return { R, nonce: ch.challenge };
}

async function closedWithin(R, ms) {
  await Promise.race([R.closedP, sleep(ms)]);
  return R.closed;
}

// ================================================================ H-C1
test("H-C1 a contact is admitted new<->new: bound by cb_sig (no bare signature on the wire), pending share delivered and marked, the peer's share lands, both pins written", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await befriend(A, B);
  const sAB = await queueMemoryShare(A, B.identity.crowId, "c1 from A");
  const sBA = await queueMemoryShare(B, A.identity.crowId, "c1 from B");
  const pa = await newPeer(A), pb = await newPeer(B);
  const L = await link(t, pa.pm, pb.pm);

  assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId) && pb.pm.isConnected(A.identity.crowId), 5000), "admitted both ways");
  const responses = [...L.wa, ...L.wb].filter((f) => f.type === "challenge-response");
  assert.equal(responses.length, 2);
  for (const r of responses) {
    assert.equal(typeof r.cb_sig, "string", "bound by cb_sig");
    assert.equal("signature" in r, false, "no challenge-response carried a bare signature");
  }
  assert.ok(await until(async () => (await hasMemoryContent(B, "c1 from A")) && (await hasMemoryContent(A, "c1 from B")), 5000), "both shares land");
  assert.equal(await shareStatus(A, sAB), "delivered");
  assert.equal(await shareStatus(B, sBA), "delivered");
  assert.ok(await until(async () => (await pinOf(A, B.identity.crowId)) === "1" && (await pinOf(B, A.identity.crowId)) === "1", 3000), "both pins written");
});

// ================================================================ H-C2
for (const mode of ["sig", "cb"]) {
  test(`H-C2 (${mode}) a non-conforming peer claiming a contact with its own key is refused key_mismatch: destroyed, not connected, the share stays pending, its share is not applied, onPeerConnected not called`, T, async (t) => {
    // Positive control, same harness: the real key (raw, same script) is admitted.
    {
      const A = await makeSide(t, "A"), B = await makeSide(t, "B");
      await befriend(A, B);
      const s = await queueMemoryShare(A, B.identity.crowId, "c2 pending");
      const pa = await newPeer(A);
      const { R } = await rawLeg(t, pa.pm, { claim: B.identity, signer: B.identity, mode, extra: [memShare("c2 from real B")] });
      assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId), 3000), "control: real key admitted");
      assert.ok(await until(() => hasMemoryContent(A, "c2 from real B"), 3000), "control: its share lands");
      assert.ok(await until(async () => (await shareStatus(A, s)) === "delivered", 3000), "control: pending share delivered");
      assert.equal(R.closed, false);
    }
    const A = await makeSide(t, "A"), B = await makeSide(t, "B");
    const M = id();
    await befriend(A, B);
    const s = await queueMemoryShare(A, B.identity.crowId, "c2 pending");
    const pa = await newPeer(A);
    const { R } = await rawLeg(t, pa.pm, { claim: B.identity, signer: M, mode, extra: [memShare("c2 from M")] });
    assert.equal(await closedWithin(R, 3000), true, "destroyed");
    await sleep(100);
    assert.equal(pa.pm.isConnected(B.identity.crowId), false);
    assert.equal(await shareStatus(A, s), "pending", "the pending share stays pending");
    assert.equal(await hasMemoryContent(A, "c2 from M"), false, "M's share is absent");
    assert.deepEqual(pa.spies.peerConnected, []);
    assert.deepEqual(pa.spies.peerData, []);
    assert.deepEqual(refusals(B.identity.crowId).slice(-1), ["key_mismatch"]);
    assert.equal(R.frames.some((f) => f.type === "data"), false, "M received nothing");
  });
}

// ================================================================ H-C3
test("H-C3 a non-conforming peer while the real contact is connected leaves the real entry, live sends still reach it, and M's close does not disconnect it", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  const M = id();
  await befriend(A, B);
  const pa = await newPeer(A), pb = await newPeer(B);
  const L = await link(t, pa.pm, pb.pm);
  assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId), 5000), "control: real B admitted");
  const entry = pa.pm.connections.get(B.identity.crowId);
  assert.equal(entry.conn, L.a);

  for (const leg of [{ signer: M }, { signer: M, pubkey: B.identity.ed25519Pubkey }]) {
    const { R } = await rawLeg(t, pa.pm, { claim: B.identity, ...leg });
    assert.equal(await closedWithin(R, 3000), true, "the non-conforming peer is destroyed");
    await sleep(50);
    assert.equal(pa.pm.connections.get(B.identity.crowId)?.conn, L.a, "B's entry stays");
    assert.equal(pa.pm.isConnected(B.identity.crowId), true, "B still connected after M closed");
  }
  pa.pm.send(B.identity.crowId, memShare("c3 live").payload);
  assert.ok(await until(() => hasMemoryContent(B, "c3 live"), 3000), "a live send reaches B");

  // B reconnects: the newer connection takes the entry, and the older one
  // closing afterwards must not remove it.
  const L2 = await link(t, pa.pm, pb.pm);
  assert.ok(await until(() => pa.pm.connections.get(B.identity.crowId)?.conn === L2.a, 3000), "the reconnect takes the entry");
  L.a.destroy(); L.b.destroy();
  await sleep(150);
  assert.equal(pa.pm.connections.get(B.identity.crowId)?.conn, L2.a, "the superseded connection's close leaves the live entry");
  assert.equal(pa.pm.isConnected(B.identity.crowId), true);
});

// ================================================================ H-C4
test("H-C4a pubkey = the pin with M's signature is refused bad_sig", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await befriend(A, B);
  const pa = await newPeer(A);
  await rawLeg(t, pa.pm, { claim: B.identity, signer: B.identity });
  assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId), 3000), "control: B's own signature admits (legacy)");
  const A2 = await makeSide(t, "A2"); await befriend(A2, B);
  const p2 = await newPeer(A2);
  const { R } = await rawLeg(t, p2.pm, { claim: B.identity, signer: id(), pubkey: B.identity.ed25519Pubkey });
  assert.equal(await closedWithin(R, 3000), true);
  assert.deepEqual(refusals(B.identity.crowId).slice(-1), ["bad_sig"]);
  assert.equal(p2.pm.isConnected(B.identity.crowId), false);
});

test("H-C4b B's bare signature from connection 1, replayed on connection 2, is refused bad_sig", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await befriend(A, B);
  const pa = await newPeer(A);
  const leg1 = await rawLeg(t, pa.pm, { claim: B.identity, signer: B.identity });
  assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId), 3000), "control: connection 1 admitted");
  const captured = sign(leg1.nonce, B.identity.ed25519Priv);
  leg1.R.conn.destroy();
  await until(() => !pa.pm.isConnected(B.identity.crowId), 2000);

  const R = await rawTo(t, pa.pm);
  const ch = await R.next("challenge");
  assert.notEqual(ch.challenge, leg1.nonce);
  R.send({ type: "challenge-response", crowId: B.identity.crowId, pubkey: B.identity.ed25519Pubkey, signature: captured });
  assert.equal(await closedWithin(R, 3000), true);
  assert.deepEqual(refusals(B.identity.crowId).slice(-1), ["bad_sig"]);
  assert.equal(pa.pm.isConnected(B.identity.crowId), false);
});

test("H-C4c a cb_sig copied from connection 1 is refused cb_invalid (the two handshake hashes differ)", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await befriend(A, B);
  const pa = await newPeer(A), pb = await newPeer(B);
  const L = await link(t, pa.pm, pb.pm);
  assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId), 5000), "control: connection 1 bound");
  const copied = L.wb.find((f) => f.type === "challenge-response")?.cb_sig;
  assert.equal(typeof copied, "string");
  const h1 = await hashHex(L.a);

  const R = await rawTo(t, pa.pm);
  await R.next("challenge");
  const h2 = await hashHex(R.pmConn);
  assert.notEqual(h1, h2, "each connection has its own handshake hash");
  R.send({ type: "challenge-response", crowId: B.identity.crowId, pubkey: B.identity.ed25519Pubkey, cb_sig: copied });
  assert.equal(await closedWithin(R, 3000), true);
  assert.deepEqual(refusals(B.identity.crowId).slice(-1), ["cb_invalid"]);
  assert.equal(pa.pm.connections.get(B.identity.crowId)?.conn, L.a, "the real connection is untouched");
});

test("H-C4d a malformed signature or cb_sig is refused (bad_sig / cb_invalid) and the connection destroyed, not left open", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await befriend(A, B);
  {
    const pa = await newPeer(A);
    await rawLeg(t, pa.pm, { claim: B.identity, signer: B.identity, mode: "cb" });
    assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId), 3000), "control: a well-formed cb_sig admits");
  }
  for (const [field, reason] of [["signature", "bad_sig"], ["cb_sig", "cb_invalid"]]) {
    for (const bad of ["zz", "", 42, null, { x: 1 }]) {
      const pa = await newPeer(A);
      const R = await rawTo(t, pa.pm);
      await R.next("challenge");
      const resp = { type: "challenge-response", crowId: B.identity.crowId, pubkey: B.identity.ed25519Pubkey, [field]: bad };
      R.send(resp);
      assert.equal(await closedWithin(R, 3000), true, `${field}=${JSON.stringify(bad)}: destroyed`);
      // null is "absent": with neither proof the reason is bad_sig.
      const want = bad === null ? "bad_sig" : reason;
      assert.deepEqual(refusals(B.identity.crowId).slice(-1), [want], `${field}=${JSON.stringify(bad)}`);
      assert.equal(pa.pm.isConnected(B.identity.crowId), false);
    }
  }
});

// ================================================================ H-C5
test("H-C5 row state: not a contact, blocked after admission (then reconnect), 'accepted', '' key, lookup throws, no binding wired: each is refused", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await befriend(A, B);
  const pa = await newPeer(A);
  const leg = await rawLeg(t, pa.pm, { claim: B.identity, signer: B.identity });
  assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId), 3000), "control: B admitted");

  const expectRefused = async (pm, who, reason) => {
    const { R } = await rawLeg(t, pm, { claim: who, signer: who });
    assert.equal(await closedWithin(R, 3000), true, `${reason}: destroyed`);
    assert.deepEqual(refusals(who.crowId).slice(-1), [reason]);
  };

  // not a contact
  await expectRefused(pa.pm, id(), "not_contact");

  // blocked after admission, then reconnect
  await A.db.execute({ sql: "UPDATE contacts SET is_blocked = 1 WHERE crow_id = ?", args: [B.identity.crowId] });
  leg.R.conn.destroy();
  await until(() => !pa.pm.isConnected(B.identity.crowId), 2000);
  await expectRefused(pa.pm, B.identity, "not_contact");

  // request_status = 'accepted' (a partial row with a real key)
  const C = id();
  await A.db.execute({
    sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, request_status) VALUES (?, ?, ?, 'accepted')",
    args: [C.crowId, C.ed25519Pubkey, C.secp256k1Pubkey],
  });
  await expectRefused(pa.pm, C, "not_contact");

  // '' key
  const D = id();
  await A.db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (?, '', ?)", args: [D.crowId, D.secp256k1Pubkey] });
  await expectRefused(pa.pm, D, "not_contact");

  // lookup throws
  const E = id();
  await addContact(A, E);
  const realLookup = pa.pm.contactBinding.lookupKey;
  pa.pm.contactBinding.lookupKey = async () => { throw new Error("database is locked"); };
  await expectRefused(pa.pm, E, "lookup_failed");
  pa.pm.contactBinding.lookupKey = realLookup;

  // no binding wired
  const bare = await newPeer(A, { boot: false });
  bare.pm.contactBinding = null;
  const F = id();
  await addContact(A, F);
  await expectRefused(bare.pm, F, "no_binding");
  assert.deepEqual(bare.spies.peerConnected, []);
});

// ================================================================ H-C6
test("H-C6 a legacy row whose key does not derive its Crow ID (crow_id = B, key = M's), with M signing correctly, is refused pin_crowid_mismatch", T, async (t) => {
  const A = await makeSide(t, "A"), C = await makeSide(t, "C");
  await befriend(A, C);
  const pa = await newPeer(A);
  await rawLeg(t, pa.pm, { claim: C.identity, signer: C.identity });
  assert.ok(await until(() => pa.pm.isConnected(C.identity.crowId), 3000), "control: a consistent row admits");

  const B = id(), M = id();
  await A.db.execute({
    sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (?, ?, ?)",
    args: [B.crowId, M.ed25519Pubkey, M.secp256k1Pubkey],
  });
  const { R } = await rawLeg(t, pa.pm, { claim: B, signer: M });
  assert.equal(await closedWithin(R, 3000), true);
  assert.deepEqual(refusals(B.crowId).slice(-1), ["pin_crowid_mismatch"]);
  assert.equal(pa.pm.isConnected(B.crowId), false);
});

// ================================================================ H-C7
test("H-C7 race: an old contact's share sent in the same tick as its response is applied after admission (lookup delayed 300 ms); the refused variant is never applied", T, async (t) => {
  const delay = (pm) => {
    const real = pm.contactBinding.lookupKey;
    pm.contactBinding.lookupKey = async (c) => { await sleep(300); return real(c); };
  };
  {
    const A = await makeSide(t, "A"), B = await makeSide(t, "B");
    await befriend(A, B);
    const pa = await newPeer(A);
    delay(pa.pm);
    await rawLeg(t, pa.pm, { claim: B.identity, signer: B.identity, pre: [memShare("c7 zero")], extra: [memShare("c7 one"), memShare("c7 two")] });
    await sleep(100);
    assert.equal(pa.pm.isConnected(B.identity.crowId), false, "still deciding");
    assert.equal(await hasMemoryContent(A, "c7 zero"), false, "a frame sent before the response waits for the decision");
    assert.ok(await until(async () => (await hasMemoryContent(A, "c7 one")) && (await hasMemoryContent(A, "c7 two")), 5000), "applied after admission");
    const rows = (await A.db.execute({ sql: "SELECT content FROM memories WHERE content LIKE 'c7 %' ORDER BY id" })).rows.map((r) => r.content);
    assert.deepEqual(rows, ["c7 zero", "c7 one", "c7 two"], "in order");
  }
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await befriend(A, B);
  const pa = await newPeer(A);
  delay(pa.pm);
  const { R } = await rawLeg(t, pa.pm, { claim: B.identity, signer: id(), pre: [memShare("c7 M early")], extra: [memShare("c7 M")] });
  assert.equal(await closedWithin(R, 3000), true);
  await sleep(200);
  assert.equal(await hasMemoryContent(A, "c7 M"), false, "never applied");
  assert.equal(await hasMemoryContent(A, "c7 M early"), false, "a frame sent before the response is never applied either");
  assert.deepEqual(pa.spies.peerData, []);
});

// ================================================================ H-C8
test("H-C8 pre-admission caps (4 lines, 1024 bytes, 200 ms): 5 lines, 1025 bytes with no newline, or silence each destroy; a normal handshake under the same caps is admitted", T, async (t) => {
  const caps = { preAuthMaxLines: 4, preAuthMaxBytes: 1024, preAuthMs: 200 };
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await befriend(A, B);
  {
    const pa = await newPeer(A, { opts: caps }), pb = await newPeer(B, { opts: caps });
    await link(t, pa.pm, pb.pm);
    assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId) && pb.pm.isConnected(A.identity.crowId), 3000), "control: admitted under the caps");
  }
  // The caps fire on their own (not the timer): checked with a long timer too.
  for (const ms of [200, 10_000]) {
    const capsMs = { ...caps, preAuthMs: ms };
    {
      const pa = await newPeer(A, { opts: capsMs });
      const R = await rawTo(t, pa.pm);
      await R.next("challenge");
      R.write('{"type":"noise"}\n'.repeat(5));
      assert.equal(await closedWithin(R, 2000), true, `5 lines (timer ${ms})`);
    }
    {
      const pa = await newPeer(A, { opts: capsMs });
      const R = await rawTo(t, pa.pm);
      await R.next("challenge");
      R.write("x".repeat(1025));
      assert.equal(await closedWithin(R, 2000), true, `1025 bytes, no newline (timer ${ms})`);
    }
  }
  {
    const pa = await newPeer(A, { opts: caps });
    const R = await rawTo(t, pa.pm);
    await R.next("challenge");
    assert.equal(await closedWithin(R, 2000), true, "silence");
  }
});

// ================================================================ H-C9
/** M sits between A (claiming B) and B: it relays A's nonce to B as its own challenge. */
async function oracleRelay(t, pa, pbPm, { cb, strip }) {
  const toA = await rawTo(t, pa.pm);
  const chA = await toA.next("challenge");
  assert.equal(chA.cb, 1, "A asks for a channel binding");
  const toB = await rawTo(t, pbPm);
  await toB.next("challenge");
  const M = id();
  const ask = { type: "challenge", challenge: chA.challenge, crowId: M.crowId, pubkey: M.ed25519Pubkey };
  if (cb) ask.cb = 1;
  toB.send(ask);
  const got = await toB.next("challenge-response", 600);
  if (got) {
    const fwd = { ...got };
    if (strip) delete fwd.cb_sig;
    toA.send(fwd, { type: "authenticated" }); // M also completes the mutual step

  }
  return { toA, toB, got };
}

test("H-C9a relayed proof, B new, with cb:1: B returns only a cb_sig (over the M<->B hash); forwarded or stripped, A refuses (cb_invalid / bad_sig)", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await befriend(A, B);
  {
    const pa = await newPeer(A), pb = await newPeer(B);
    await link(t, pa.pm, pb.pm);
    assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId), 3000), "control: real B admitted");
  }
  for (const [strip, reason] of [[false, "cb_invalid"], [true, "bad_sig"]]) {
    const A2 = await makeSide(t, "A2"); await addContact(A2, B);
    const pa = await newPeer(A2), pb = await newPeer(B, { boot: false });
    const { toA, got } = await oracleRelay(t, pa, pb.pm, { cb: true, strip });
    assert.ok(got, "B answered the cb:1 challenge");
    assert.equal(typeof got.cb_sig, "string");
    assert.equal("signature" in got, false, "B signed no bare nonce");
    assert.equal(await closedWithin(toA, 3000), true, `strip=${strip}: refused`);
    assert.deepEqual(refusals(B.identity.crowId).slice(-1), [reason]);
    assert.equal(pa.pm.isConnected(B.identity.crowId), false);
  }
});

test("H-C9b relayed proof, B new, without cb: B never replies (deferred) and A's pre-admission timer closes M", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await befriend(A, B);
  {
    const pa = await newPeer(A, { opts: { preAuthMs: 400 } }), pb = await newPeer(B);
    await link(t, pa.pm, pb.pm);
    assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId), 3000), "control: real B admitted under the same timer");
  }
  const A2 = await makeSide(t, "A2"); await addContact(A2, B);
  const pa = await newPeer(A2, { opts: { preAuthMs: 400 } }), pb = await newPeer(B, { boot: false });
  const { toA, toB, got } = await oracleRelay(t, pa, pb.pm, { cb: false, strip: false });
  assert.equal(got, null, "B deferred: nothing signed");
  assert.equal(toB.pmWrites.some((f) => f.type === "challenge-response"), false);
  assert.equal(await closedWithin(toA, 2000), true, "A's timer closed M");
  assert.equal(pa.pm.isConnected(B.identity.crowId), false);
});

test("H-C9c relayed proof, B OLD, A unpinned: an older-version B's relayed proof is accepted (the documented residual)", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await befriend(A, B);
  {
    const pa = await newPeer(A);
    const ob = new OldPeerManager(B.identity, { env: {} });
    await link(t, pa.pm, ob);
    assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId) && ob.isConnected(A.identity.crowId), 3000), "control: old B and new A connect (legacy)");
    assert.equal(await pinOf(A, B.identity.crowId), null, "a legacy proof writes no pin");
  }
  const A2 = await makeSide(t, "A2"); await addContact(A2, B);
  const pa = await newPeer(A2);
  const ob = new OldPeerManager(B.identity, { env: {} });
  const { got } = await oracleRelay(t, pa, ob, { cb: true, strip: true });
  assert.equal(typeof got?.signature, "string", "old B signed the relayed nonce");
  assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId), 3000),
    "§3.2: someone can pose as a contact only while that contact still runs Crow older than PT-3 on a machine that is online, and only until we have once seen it bind");
  assert.ok(legacyLines(B.identity.crowId).length >= 1, "legacy is logged");
});

test("H-C9d relayed proof, B OLD, A pinned (by a bound handshake with B's updated machine): refused cb_required_pinned", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await befriend(A, B);
  const pa = await newPeer(A);
  {
    const pbNew = await newPeer(B);
    const L = await link(t, pa.pm, pbNew.pm);
    assert.ok(await until(async () => pa.pm.isConnected(B.identity.crowId) && (await pinOf(A, B.identity.crowId)) === "1", 3000), "control: B's updated machine binds and is pinned");
    L.a.destroy(); L.b.destroy();
    await until(() => !pa.pm.isConnected(B.identity.crowId), 2000);
  }
  const ob = new OldPeerManager(B.identity, { env: {} });
  const { toA, got } = await oracleRelay(t, pa, ob, { cb: true, strip: true });
  assert.equal(typeof got?.signature, "string");
  assert.equal(await closedWithin(toA, 3000), true);
  assert.deepEqual(refusals(B.identity.crowId).slice(-1), ["cb_required_pinned"]);
  assert.equal(pa.pm.isConnected(B.identity.crowId), false);
});

test("H-C9e relayed proof, B OLD, A pinned with no prior handshake (as the Nostr advert does): refused", T, async (t) => {
  // Task 3's N-6 drives the real advert handler; here the pin is written directly.
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await befriend(A, B);
  const pa = await newPeer(A);
  {
    const ob = new OldPeerManager(B.identity, { env: {} });
    const L = await link(t, pa.pm, ob);
    assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId), 3000), "control: unpinned, old B connects");
    L.a.destroy(); L.b.destroy();
    await until(() => !pa.pm.isConnected(B.identity.crowId), 2000);
  }
  assert.equal(await markCbPinned(A.db, A.localId, B.identity.crowId), true);
  const ob = new OldPeerManager(B.identity, { env: {} });
  const { toA } = await oracleRelay(t, pa, ob, { cb: true, strip: true });
  assert.equal(await closedWithin(toA, 3000), true);
  assert.deepEqual(refusals(B.identity.crowId).slice(-1), ["cb_required_pinned"]);
});

// ================================================================ H-C10
// PT-2a: a sibling is admitted only through the pair-binding guard, so a new
// sibling is wired as boot.js wires it (wireInstanceSync), with no pair key
// and an empty pin store: it binds as legacy in auto, which is the PT-3
// behaviour these tests pin. Its callbacks are then replaced by spies.
const NO_PINS_DB = { execute: async () => ({ rows: [], rowsAffected: 0 }) };
function sibling(identity, localId, { PM = PeerManager, db = null } = {}) {
  const pm = new PM(identity, { env: {} });
  pm.p2pDisabled = true; // never start a swarm: links are loopback socket pairs
  pm.localInstanceId = localId;
  if (PM === PeerManager) {
    wireInstanceSync(pm, { db: db ?? NO_PINS_DB, instanceSyncManager: { localInstanceId: localId }, pairKeyLookup: () => null, mode: "auto" });
  }
  const feed = randomBytes(32).toString("hex");
  const calls = { keyReceived: [], instanceConnected: [], peerConnected: [] };
  pm.getFeedKeyForInstance = async () => feed;
  pm.onInstanceKeyReceived = (i, k) => { calls.keyReceived.push([i, k]); };
  pm.onInstanceConnected = (c, _conn, i) => { calls.instanceConnected.push([c, i]); };
  pm.onPeerConnected = (c) => { calls.peerConnected.push(c); };
  return { pm, calls, feed, localId, db };
}

test("H-C10a new<->new siblings: an own-Crow-ID cb_sig admits as instance, no contact_hs_cb: write, feed keys only through instance-key", T, async (t) => {
  const S = await makeSide(t, "S");
  const me = S.identity;
  const s1 = sibling(me, "inst-s1"), s2 = sibling(me, "inst-s2");
  const { wireContactBinding } = await import("../servers/sharing/contact-binding.js");
  wireContactBinding(s1.pm, { db: S.db, localInstanceId: "inst-s1" });
  wireContactBinding(s2.pm, { db: S.db, localInstanceId: "inst-s2" });
  const L = await link(t, s1.pm, s2.pm);
  assert.ok(await until(() => s1.calls.instanceConnected.length && s2.calls.instanceConnected.length, 3000), "admitted as instance both ways");
  assert.deepEqual(s1.calls.instanceConnected, [[me.crowId, "inst-s2"]]);
  assert.deepEqual(s2.calls.instanceConnected, [[me.crowId, "inst-s1"]]);
  assert.ok(await until(() => s1.calls.keyReceived.length && s2.calls.keyReceived.length, 3000));
  assert.deepEqual(s1.calls.keyReceived, [["inst-s2", s2.feed]]);
  assert.deepEqual(s2.calls.keyReceived, [["inst-s1", s1.feed]]);
  for (const f of [...L.wa, ...L.wb].filter((x) => x.type === "challenge-response")) {
    assert.equal(typeof f.cb_sig, "string");
    assert.equal("feed_key_hex" in f, false, "no piggyback on any challenge-response");
    assert.equal("instance_id" in f, false);
    assert.equal("signature" in f, false);
  }
  assert.equal([...L.wa, ...L.wb].filter((x) => x.type === "instance-key").length, 2);
  assert.equal(await pinCount(S), 0, "no contact_hs_cb: write for a sibling");
  assert.deepEqual(s1.calls.peerConnected, []);
});

test("H-C10b an old sibling gets the deferred bare reply, with the piggyback, only after its own proof", T, async (t) => {
  const me = id();
  for (const newInitiator of [true, false]) {
    const sNew = sibling(me, "inst-new");
    const sOld = sibling(me, "inst-old", { PM: OldPeerManager });
    const L = await link(t, sNew.pm, sOld.pm, { aInitiator: newInitiator, snapA: () => sNew.pm.isConnected(me.crowId) });
    assert.ok(await until(() => sNew.calls.instanceConnected.length && sOld.calls.instanceConnected.length, 3000), "admitted both ways");
    const order = L.wa.map((f) => f.type);
    const iAuth = order.indexOf("authenticated"), iResp = order.indexOf("challenge-response");
    assert.ok(iAuth >= 0 && iResp > iAuth, `the reply follows admission: ${order.join(",")}`);
    const resp = L.wa[iResp];
    assert.equal(typeof resp.signature, "string");
    assert.equal(resp.instance_id, "inst-new");
    assert.equal(resp.feed_key_hex, sNew.feed);
    assert.equal(resp._snap, false, "the reply precedes mutual admission: the old side admits us only after it");
    assert.ok(await until(() => sOld.calls.keyReceived.length && sNew.calls.keyReceived.length, 3000));
    assert.deepEqual(sOld.calls.keyReceived, [["inst-new", sNew.feed]]);
    assert.deepEqual(sNew.calls.keyReceived, [["inst-old", sOld.feed]]);
    assert.deepEqual(sNew.calls.instanceConnected, [[me.crowId, "inst-old"]]);
  }
});

// ================================================================ H-C11
const SIDE_EFFECTS = [
  // _completeAdmit is _admit's second half (mutual admission), reached only from _admit or the peer's `authenticated` after ours.
  { what: "connections.set(", re: /\.connections\s*\.\s*set\s*\(/g, allowed: ["_completeAdmit"] },
  { what: "onPeerConnected(", re: /\.onPeerConnected\s*\(/g, allowed: ["_completeAdmit"] },
  { what: "onInstanceConnected(", re: /\.onInstanceConnected\s*\(/g, allowed: ["_completeAdmit"] },
  { what: "onInstanceKeyReceived(", re: /\.onInstanceKeyReceived\s*\(/g, allowed: ["_completeAdmit", "_dispatchAdmitted"] },
  { what: "_completeAdmit(", re: /\._completeAdmit\s*\(/g, allowed: ["_admit", "_handleMessage"] },
  { what: "onPeerData(", re: /\.onPeerData\s*\(/g, allowed: ["_dispatchAdmitted"] },
  { what: '{ type: "authenticated" }', re: /\{\s*type\s*:\s*"authenticated"\s*\}/g, allowed: ["_admit"] },
  { what: '"instance-key" send', re: /type\s*:\s*"instance-key"/g, allowed: ["_admit"] },
  { what: "bare sign(", re: /\bsign\s*\((?!\s*contactCbMessage\s*\()/g, allowed: ["_sendDeferredReply"] },
  { what: "_sendDeferredReply(", re: /\._sendDeferredReply\s*\(/g, allowed: ["_admit"] },
  { what: "_dispatchAdmitted(", re: /\._dispatchAdmitted\s*\(/g, allowed: ["_completeAdmit", "_handleMessage"] },
  { what: "verify(... msg.pubkey", re: /\bverify\s*\([^;]*?msg\.pubkey/g, allowed: [] },
];

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));
}

/** Class methods of PeerManager by span: [{ name, start, end }]. */
function methodSpans(src) {
  const cls = src.indexOf("export class PeerManager");
  const spans = [];
  const re = /^ {2}(?:async\s+)?(?:static\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;
  re.lastIndex = cls;
  let m;
  while ((m = re.exec(src))) {
    const endRe = /^ {2}\}/gm;
    endRe.lastIndex = m.index + m[0].length;
    const e = endRe.exec(src);
    spans.push({ name: m[1], start: m.index, end: e ? e.index : src.length });
  }
  return spans;
}

function scanSideEffects(file) {
  const src = stripComments(readFileSync(file, "utf8"));
  const spans = methodSpans(src);
  const where = (i) => spans.find((s) => i >= s.start && i < s.end)?.name ?? "<top level>";
  const violations = [];
  for (const rule of SIDE_EFFECTS) {
    for (const m of src.matchAll(rule.re)) {
      const w = where(m.index);
      if (!rule.allowed.includes(w)) violations.push(`${rule.what} in ${w}`);
    }
  }
  const disp = spans.find((s) => s.name === "_dispatchAdmitted");
  if (disp) {
    const body = src.slice(disp.start, disp.end);
    const firstStmt = body.slice(body.indexOf("{") + 1).trim();
    if (!/^if\s*\(\s*!\s*state\s*\.\s*mutual\b/.test(firstStmt)) violations.push("_dispatchAdmitted does not start with a mutual-admission guard");
  }
  const comp = spans.find((s) => s.name === "_completeAdmit");
  if (comp) {
    const body = src.slice(comp.start, comp.end);
    const firstStmt = body.slice(body.indexOf("{") + 1).trim();
    if (!/^if\s*\(\s*state\s*\.\s*mutual\s*\|\|\s*!\s*state\s*\.\s*authenticated\s*\|\|\s*!\s*state\s*\.\s*peerAuthed\b/.test(firstStmt)) violations.push("_completeAdmit does not start with its both-halves guard");
  }
  if (!spans.some((s) => s.name === "_admit")) violations.push("no _admit method");
  return violations;
}

test("H-C11 inventory: every admission side effect occurs only inside _admit (or the post-admission helpers it gates)", T, () => {
  const v = scanSideEffects(PEER_MANAGER_PATH);
  assert.deepEqual(v, []);
});

test("H-C11 positive control: a planted side effect in a temp copy fails the scan", T, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pt3-scan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = readFileSync(PEER_MANAGER_PATH, "utf8");
  const anchor = src.indexOf("  _handleConnection(conn, info) {");
  assert.ok(anchor > 0);
  const insertAt = src.indexOf("\n", anchor) + 1;
  const plants = [
    ["connections.set(", '    this.connections.set("x", { conn, authenticated: true });\n'],
    ["bare sign(", "    const s = sign(msg.challenge, this.identity.ed25519Priv);\n"],
    ['{ type: "authenticated" }', '    conn.write(JSON.stringify({ type: "authenticated" }) + "\\n");\n'],
    ["onPeerConnected(", "    this.onPeerConnected(remoteCrowId, conn);\n"],
    ["_completeAdmit(", "    this._completeAdmit(conn, state);\n"],
    ["verify(... msg.pubkey", "    verify(nonce, msg.signature, msg.pubkey);\n"],
  ];
  for (const [what, line] of plants) {
    const f = join(dir, "peer-manager.js");
    writeFileSync(f, src.slice(0, insertAt) + line + src.slice(insertAt));
    const v = scanSideEffects(f);
    assert.ok(v.some((x) => x.startsWith(what)), `planted ${what} is caught: ${JSON.stringify(v)}`);
  }
  // And a plant inside a comment is not code: not caught.
  const f = join(dir, "peer-manager.js");
  writeFileSync(f, src.slice(0, insertAt) + "    // this.connections.set(x)\n" + src.slice(insertAt));
  assert.deepEqual(scanSideEffects(f), []);
});

// ================================================================ H-C12
test("H-C12a an old asker and a new responder, both directions: admitted both ways, shares flow, and B's bare reply is written only after B admitted A", T, async (t) => {
  for (const newInitiator of [true, false]) {
    const A = await makeSide(t, "A"), B = await makeSide(t, "B");
    await befriend(B, A);
    const s = await queueMemoryShare(B, A.identity.crowId, `c12 B->A ${newInitiator}`);
    const pb = await newPeer(B);
    const oa = new OldPeerManager(A.identity, { env: {} });
    const oldGot = [];
    oa.onPeerData = (c, p) => { oldGot.push([c, p]); };
    const L = await link(t, pb.pm, oa, { aInitiator: newInitiator, snapA: () => pb.pm.isConnected(A.identity.crowId) });
    assert.ok(await until(() => pb.pm.isConnected(A.identity.crowId) && oa.isConnected(B.identity.crowId), 3000), "admitted both ways");
    const order = L.wa.map((f) => f.type);
    const iAuth = order.indexOf("authenticated"), iResp = order.indexOf("challenge-response");
    assert.ok(iAuth >= 0 && iResp > iAuth, `frame order: ${order.join(",")}`);
    assert.equal(L.wa[iResp]._snap, false, "B decided (authenticated first) but is not yet connected: old A admits B only after this reply");
    assert.equal(typeof L.wa[iResp].signature, "string");
    assert.ok(await until(() => oldGot.some(([, p]) => p?.payload?.content === `c12 B->A ${newInitiator}`), 3000), "B's share reaches old A");
    assert.equal(await shareStatus(B, s), "delivered");
    oa.send(B.identity.crowId, memShare(`c12 A->B ${newInitiator}`).payload);
    assert.ok(await until(() => hasMemoryContent(B, `c12 A->B ${newInitiator}`), 3000), "old A's share reaches B");
    assert.ok(legacyLines(A.identity.crowId).length >= 1, "B logs the old contact as legacy");
  }
});

test("H-C12b a new responder never writes its reply to an asker that never proves", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await befriend(B, A);
  {
    const pb = await newPeer(B, { opts: { preAuthMs: 300 } });
    const leg = await rawLeg(t, pb.pm, { claim: A.identity, signer: A.identity, challenge: { type: "challenge", challenge: randomBytes(32).toString("hex"), crowId: A.identity.crowId } });
    assert.ok(await leg.R.next("challenge-response", 3000), "control: a proving old asker gets its reply");
  }
  const pb = await newPeer(B, { opts: { preAuthMs: 300 } });
  const R = await rawTo(t, pb.pm);
  await R.next("challenge");
  R.send({ type: "challenge", challenge: randomBytes(32).toString("hex"), crowId: A.identity.crowId, pubkey: A.identity.ed25519Pubkey });
  assert.equal(await closedWithin(R, 2000), true, "closed by the pre-admission timer");
  assert.equal(R.pmWrites.some((f) => f.type === "challenge-response"), false, "the transcript has no challenge-response");
  assert.equal(R.frames.some((f) => f.type === "challenge-response"), false);
});

// ================================================================ H-C13
test("H-C13 admitGuards: a refusing guard refuses guard:<reason> with no side effects; an ok guard admits", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await befriend(A, B);
  {
    const pa = await newPeer(A);
    pa.pm.admitGuards.contact = async () => ({ ok: true });
    await rawLeg(t, pa.pm, { claim: B.identity, signer: B.identity });
    assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId), 3000), "control: an ok guard admits");
  }
  const A2 = await makeSide(t, "A2"); await befriend(A2, B);
  await queueMemoryShare(A2, B.identity.crowId, "c13 pending");
  const seen = [];
  const refuse = async (ctx) => { seen.push(ctx); return { ok: false, reason: "x" }; };

  // A legacy asker: its deferred reply must not be written.
  const pa = await newPeer(A2);
  pa.pm.admitGuards.contact = refuse;
  const { R } = await rawLeg(t, pa.pm, {
    claim: B.identity, signer: B.identity, extra: [memShare("c13 B")],
    challenge: { type: "challenge", challenge: randomBytes(32).toString("hex"), crowId: B.identity.crowId },
  });
  assert.equal(await closedWithin(R, 3000), true);
  assert.deepEqual(refusals(B.identity.crowId).slice(-1), ["guard:x"]);
  assert.equal(seen.length, 1);
  assert.equal(typeof seen[0].conn, "object");
  assert.equal(seen[0].msg.crowId, B.identity.crowId);
  assert.deepEqual(pa.spies.peerConnected, []);
  assert.deepEqual(pa.spies.peerData, []);
  assert.equal(pa.pm.connections.size, 0);
  assert.equal(R.pmWrites.some((f) => f.type === "challenge-response" || f.type === "authenticated"), false, "no deferred reply, no authenticated frame");
  assert.equal(await hasMemoryContent(A2, "c13 B"), false);

  // A binding asker: no pin is written.
  const pa2 = await newPeer(A2);
  pa2.pm.admitGuards.contact = refuse;
  const pb = await newPeer(B, { boot: false });
  await link(t, pa2.pm, pb.pm);
  await sleep(300);
  assert.equal(pa2.pm.isConnected(B.identity.crowId), false);
  assert.equal(await pinOf(A2, B.identity.crowId), null, "no pin written");
  assert.deepEqual(pa2.spies.peerConnected, []);

  // The instance kind has its own seam.
  const me = id();
  const s1 = sibling(me, "inst-g1"), s2 = sibling(me, "inst-g2");
  s1.pm.admitGuards.instance = async () => ({ ok: false, reason: "pair" });
  await link(t, s1.pm, s2.pm);
  await sleep(300);
  assert.deepEqual(s1.calls.instanceConnected, []);
  assert.deepEqual(s1.calls.keyReceived, []);
});

// ================================================================ pin lifecycle
test("H-C14 deleting a contact clears its channel-binding pin (a re-added person starts unpinned); blocking keeps it", T, async (t) => {
  const { deleteContactLocal, unwireContact } = await import("../servers/sharing/contact-delete.js");
  const A = await makeSide(t, "A");
  const B = id(), C = id();
  await addContact(A, B); await addContact(A, C);
  assert.equal(await markCbPinned(A.db, A.localId, B.crowId), true);
  assert.equal(await markCbPinned(A.db, A.localId, C.crowId), true);
  assert.equal(await pinOf(A, B.crowId), "1", "control: pinned");

  // Block (the unwire path shared with block) keeps the pin.
  await A.db.execute({ sql: "UPDATE contacts SET is_blocked = 1 WHERE crow_id = ?", args: [C.crowId] });
  await unwireContact({}, { id: await contactId(A, C.crowId), crow_id: C.crowId });
  assert.equal(await pinOf(A, C.crowId), "1", "block keeps the pin");

  const row = (await A.db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [B.crowId] })).rows[0];
  const r = await deleteContactLocal(A.db, { peerManager: { localInstanceId: A.localId, leaveContact: async () => {} } }, row);
  assert.equal(r.ok, true);
  assert.equal(await pinOf(A, B.crowId), null, "delete clears the pin");
  assert.equal(await pinOf(A, C.crowId), "1", "only that contact's pin");

  // The id can also come from the instance-sync manager.
  const rowC = (await A.db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [C.crowId] })).rows[0];
  await deleteContactLocal(A.db, { instanceSyncManager: { localInstanceId: A.localId } }, rowC);
  assert.equal(await pinOf(A, C.crowId), null);
});

// ================================================================ fix round 1
test("H-C15 (R7) a peer admitted via cb_sig never gets a deferred bare reply (contact and sibling); a legacy-admitted peer still does", T, async (t) => {
  const A = await makeSide(t, "A");
  const C = id();
  await addContact(A, C);
  const foreign = () => ({ type: "challenge", challenge: randomBytes(32).toString("hex"), crowId: C.crowId });
  {
    const pa = await newPeer(A);
    const { R } = await rawLeg(t, pa.pm, { claim: C, signer: C, mode: "sig", challenge: foreign() });
    assert.ok(await R.next("challenge-response", 3000), "control: a legacy-admitted contact gets its reply");
  }
  const pa = await newPeer(A);
  const { R } = await rawLeg(t, pa.pm, { claim: C, signer: C, mode: "cb", challenge: foreign() });
  assert.ok(await until(() => pa.pm.isConnected(C.crowId), 3000), "C is admitted via cb_sig");
  await sleep(300);
  assert.equal(R.pmWrites.some((f) => f.type === "challenge-response"), false, "no challenge-response is ever written to C");
  assert.equal(R.frames.some((f) => f.type === "challenge-response"), false);

  const me = id();
  const sibAsk = () => ({ type: "challenge", challenge: randomBytes(32).toString("hex"), crowId: me.crowId, instance_id: "inst-x" });
  {
    const s1 = sibling(me, "inst-s1");
    const { R: R1 } = await rawLeg(t, s1.pm, { claim: me, signer: me, mode: "sig", challenge: sibAsk() });
    assert.ok(await R1.next("challenge-response", 3000), "control: an old own-key sibling gets its reply");
  }
  const s1 = sibling(me, "inst-s1");
  const { R: R2 } = await rawLeg(t, s1.pm, { claim: me, signer: me, mode: "cb", challenge: sibAsk() });
  assert.ok(await until(() => s1.calls.instanceConnected.length === 1, 3000), "the cb sibling is admitted");
  await sleep(300);
  assert.equal(R2.pmWrites.some((f) => f.type === "challenge-response"), false, "no bare reply to a cb-proved sibling");
});

test("H-C16 (R8) new<->new: a share over 64 KiB pending on the side that decides first is delivered and applied under default caps", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await befriend(A, B);
  const big = "L".repeat(70 * 1024);
  const sBA = await queueMemoryShare(B, A.identity.crowId, big);
  const pa = await newPeer(A), pb = await newPeer(B);
  const real = pa.pm.contactBinding.lookupKey;
  pa.pm.contactBinding.lookupKey = async (c) => { await sleep(300); return real(c); }; // B decides first
  const L = await link(t, pa.pm, pb.pm);
  let closed = false;
  L.a.once("close", () => { closed = true; });
  assert.ok(await until(() => hasMemoryContent(A, big), 5000), "the large share is applied");
  assert.equal(await shareStatus(B, sBA), "delivered");
  assert.equal(closed, false, "not destroyed");
  assert.equal(pa.pm.isConnected(B.identity.crowId), true);
});

test("H-C17 (R8) a peer that proves itself but never sends authenticated gets no onPeerConnected and is destroyed after preAuthMs", T, async (t) => {
  const A = await makeSide(t, "A");
  const B = id();
  await addContact(A, B);
  {
    const pa = await newPeer(A, { opts: { preAuthMs: 300 } });
    await rawLeg(t, pa.pm, { claim: B, signer: B, mode: "cb" });
    assert.ok(await until(() => pa.spies.peerConnected.length === 1, 3000), "control: with authenticated it connects");
  }
  const pa = await newPeer(A, { opts: { preAuthMs: 300 } });
  const { R } = await rawLeg(t, pa.pm, { claim: B, signer: B, mode: "cb", auth: false, extra: [memShare("c17")] });
  assert.ok(await R.next("authenticated", 2000), "we admitted it (our authenticated was sent)");
  assert.equal(pa.pm.isConnected(B.crowId), false, "not connected before mutual admission");
  assert.equal(await closedWithin(R, 2000), true, "destroyed after preAuthMs");
  assert.deepEqual(pa.spies.peerConnected, []);
  assert.equal(await hasMemoryContent(A, "c17"), false);
});

// ================================================================ fix round 2
/**
 * M is a full contact of a current node B (unpinned at B, never binds). It
 * asks B, without cb, to answer A's nonce, proves itself to B with a bare
 * signature under its own key, and forwards B's reply to A as B.
 */
async function contactRelay(t, pa, pb, M) {
  const toA = await rawTo(t, pa.pm);
  const chA = await toA.next("challenge");
  const toB = await rawTo(t, pb.pm);
  const chB = await toB.next("challenge");
  toB.send(
    { type: "challenge", challenge: chA.challenge, crowId: M.crowId, pubkey: M.ed25519Pubkey },
    { type: "challenge-response", crowId: M.crowId, pubkey: M.ed25519Pubkey, signature: sign(chB.challenge, M.ed25519Priv) },
    { type: "authenticated" },
  );
  const got = await toB.next("challenge-response", 1000);
  if (got) toA.send({ ...got }, { type: "authenticated" });
  return { toA, toB, got };
}

test("H-C18 a contact of a current node relays a bare reply: (a) an unpinned A admits it (documented residual), (b) A pinned for B refuses, (c) B pinned for M never replies", T, async (t) => {
  const M = id();
  const mk = async () => {
    const A = await makeSide(t, "A"), B = await makeSide(t, "B");
    await befriend(A, B);
    await addContact(B, M);
    return { A, B, pa: await newPeer(A), pb: await newPeer(B) };
  };
  {
    const w = await mk();
    await link(t, w.pa.pm, w.pb.pm);
    assert.ok(await until(() => w.pa.pm.isConnected(w.B.identity.crowId), 3000), "control: the real B connects");
  }
  // (a)
  {
    const w = await mk();
    const { got } = await contactRelay(t, w.pa, w.pb, M);
    assert.equal(typeof got?.signature, "string", "B admitted M (legacy) and released its bare reply");
    assert.ok(await until(() => w.pa.pm.isConnected(w.B.identity.crowId), 3000),
      "documented residual: a node that has never seen a contact bind accepts a bare signature for it, here one relayed by another contact of that contact that never binds; pinning (the Nostr notice or one bound handshake) closes it");
  }
  // (b)
  {
    const w = await mk();
    await markCbPinned(w.A.db, w.A.localId, w.B.identity.crowId);
    const { toA, got } = await contactRelay(t, w.pa, w.pb, M);
    assert.equal(typeof got?.signature, "string");
    assert.equal(await closedWithin(toA, 3000), true);
    assert.deepEqual(refusals(w.B.identity.crowId).slice(-1), ["cb_required_pinned"]);
    assert.equal(w.pa.pm.isConnected(w.B.identity.crowId), false);
  }
  // (c)
  {
    const w = await mk();
    await markCbPinned(w.B.db, w.B.localId, M.crowId);
    const { toB, got } = await contactRelay(t, w.pa, w.pb, M);
    assert.equal(got, null);
    assert.equal(await closedWithin(toB, 3000), true);
    assert.deepEqual(refusals(M.crowId).slice(-1), ["cb_required_pinned"]);
    assert.equal(toB.pmWrites.some((f) => f.type === "challenge-response"), false, "B never writes a challenge-response to M");
  }
});

test("H-C19 a non-string Crow ID is refused before lookup: no entry, nothing logged as legacy", T, async (t) => {
  const A = await makeSide(t, "A"), B = await makeSide(t, "B");
  await befriend(A, B);
  {
    const pa = await newPeer(A);
    await rawLeg(t, pa.pm, { claim: B.identity, signer: B.identity });
    assert.ok(await until(() => pa.pm.isConnected(B.identity.crowId), 3000), "control: the string id admits");
  }
  const C = id(); // a fresh, unpinned contact: the legacy log line would be its first
  await addContact(A, C);
  const pa = await newPeer(A);
  const looked = [];
  const real = pa.pm.contactBinding.lookupKey;
  pa.pm.contactBinding.lookupKey = (c) => { looked.push(c); return real(c); };
  for (const bad of [[C.crowId], { toString: () => C.crowId }, 42, "", "crow: bad id"]) {
    const { R } = await rawLeg(t, pa.pm, { claim: { crowId: bad }, signer: C });
    assert.equal(await closedWithin(R, 3000), true, `crowId=${JSON.stringify(bad)}: refused`);
  }
  assert.deepEqual(looked, [], "no lookup for a malformed id");
  assert.equal(pa.pm.connections.size, 0, "no entry");
  assert.deepEqual(pa.spies.peerConnected, []);
  assert.equal(legacyLines(C.crowId).length, 0, "nothing logged as legacy");
});

test("H-C20 between our decision and the peer's authenticated, the pre-admission caps still apply", T, async (t) => {
  const caps = { preAuthMaxLines: 4, preAuthMaxBytes: 1024, preAuthMs: 10_000 };
  const A = await makeSide(t, "A");
  const B = id();
  await addContact(A, B);
  {
    const pa = await newPeer(A, { opts: caps });
    // A compliant peer sends data only after our authenticated.
    const { R } = await rawLeg(t, pa.pm, { claim: B, signer: B, mode: "cb", auth: false });
    assert.ok(await R.next("authenticated", 2000));
    R.send({ type: "authenticated" }, memShare("c20 a"), memShare("c20 b"), memShare("c20 c"), memShare("x".repeat(2048)));
    assert.ok(await until(() => hasMemoryContent(A, "c20 c"), 3000), "control: once both sides admitted, frames are not capped");
    assert.ok(await until(() => hasMemoryContent(A, "x".repeat(2048)), 3000), "control: nor bytes");
    assert.equal(R.closed, false);
  }
  for (const [label, junk] of [["5 lines", '{"type":"noise"}\n'.repeat(5)], ["1025 bytes", "x".repeat(1025)]]) {
    const pa = await newPeer(A, { opts: caps });
    const { R } = await rawLeg(t, pa.pm, { claim: B, signer: B, mode: "cb", auth: false });
    assert.ok(await R.next("authenticated", 2000), `${label}: we decided`);
    R.write(junk);
    assert.equal(await closedWithin(R, 2000), true, `${label} before the peer's authenticated: destroyed`);
    assert.deepEqual(pa.spies.peerConnected, []);
  }
});

// ================================================================ security fix round
const instancePin = async (side, crowId) => (await side.db.execute({
  sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?",
  args: ["instance_hs_cb:" + crowId, side.localId],
})).rows[0]?.value ?? null;

/** A raw peer bounces pm's own challenge back to it, then forwards whatever pm signed. */
async function reflect(t, pm, claimCrowId, { cb = true } = {}) {
  const R = await rawTo(t, pm);
  const ch = await R.next("challenge");
  const ask = { type: "challenge", challenge: ch.challenge, crowId: claimCrowId };
  if (cb) ask.cb = 1;
  R.send(ask);
  const got = await R.next("challenge-response", 600);
  if (got) R.send({ ...got, crowId: claimCrowId }, { type: "authenticated" });
  return { R, got };
}

test("H-C21 (S1b) a peer that returns our own challenge as its own is refused before anything is signed (sibling and contact claims, with and without cb)", T, async (t) => {
  const me = id();
  {
    const s1 = sibling(me, "inst-r1"), s2 = sibling(me, "inst-r2");
    await link(t, s1.pm, s2.pm);
    assert.ok(await until(() => s1.calls.instanceConnected.length === 1, 3000), "control: a real sibling is admitted");
  }
  for (const cb of [true, false]) {
    const s1 = sibling(me, "inst-r1");
    const { R, got } = await reflect(t, s1.pm, me.crowId, { cb });
    assert.equal(got, null, `cb=${cb}: nothing signed for a reflected challenge`);
    assert.equal(R.pmWrites.some((f) => f.type === "challenge-response"), false);
    assert.equal(await closedWithin(R, 2000), true, `cb=${cb}: destroyed`);
    assert.deepEqual(s1.calls.instanceConnected, [], `cb=${cb}: not admitted`);
  }
  // Contact claim: the same reflection, claiming a contact.
  const A = await makeSide(t, "A");
  const B = id();
  await addContact(A, B);
  const pa = await newPeer(A);
  const { R, got } = await reflect(t, pa.pm, B.crowId);
  assert.equal(got, null);
  assert.equal(await closedWithin(R, 2000), true);
  assert.deepEqual(pa.spies.peerConnected, []);
  assert.ok(logs.some((l) => l.includes("challenge_reflected")), "logged as challenge_reflected");
});

test("H-C22 (S1a, white-box) role separation: our own cb_sig, reflected on the same connection, does not pass our sibling check", T, async () => {
  // White-box: these frames are fed straight to _handleMessage with a state
  // that does not carry our sent challenge, so the reflection check (S1b)
  // cannot fire and the role tag is the only layer under test.
  const me = id();
  const H = randomBytes(32);
  const X = randomBytes(32);
  const mkConn = () => ({ isInitiator: true, handshakeHash: H, written: [], destroyed: false,
    write(s) { for (const l of String(s).split("\n")) if (l.trim()) this.written.push(JSON.parse(l)); }, destroy() { this.destroyed = true; } });
  const s = sibling(me, "inst-w1");
  const conn = mkConn();
  await s.pm._handleMessage(conn, { type: "challenge", challenge: X.toString("hex"), cb: 1, crowId: me.crowId }, randomBytes(32), {});
  const ours = conn.written.find((f) => f.type === "challenge-response");
  assert.equal(typeof ours?.cb_sig, "string", "we signed the cb challenge");

  // Positive control: the OTHER end's role ("resp", since we are the initiator) admits.
  {
    const s2 = sibling(me, "inst-w2");
    const c2 = mkConn();
    const peerSig = sign(contactCbMessage({ role: "resp", signerCrowId: me.crowId, challengeHex: X.toString("hex"), handshakeHashHex: H.toString("hex") }), me.ed25519Priv);
    const st = {};
    await s2.pm._handleMessage(c2, { type: "challenge-response", crowId: me.crowId, pubkey: me.ed25519Pubkey, cb_sig: peerSig, instance_id: "inst-x" }, X, st);
    await s2.pm._handleMessage(c2, { type: "authenticated" }, X, st);
    assert.equal(c2.destroyed, false, "control: the opposite role admits");
    assert.deepEqual(s2.calls.instanceConnected, [[me.crowId, "inst-x"]]);
  }
  const s3 = sibling(me, "inst-w3");
  const c3 = mkConn();
  const st = {};
  await s3.pm._handleMessage(c3, { type: "challenge-response", crowId: me.crowId, pubkey: me.ed25519Pubkey, cb_sig: ours.cb_sig, instance_id: "inst-x" }, X, st);
  await s3.pm._handleMessage(c3, { type: "authenticated" }, X, st);
  assert.equal(c3.destroyed, true, "our own role's cb_sig is refused");
  assert.deepEqual(s3.calls.instanceConnected, []);
});

test("H-C23 (S2, white-box) the deferred bare reply is an allowlist: only a bare-signature proof gets it", T, async () => {
  const me = id();
  const pm = sibling(me, "inst-d").pm;
  const send = async (proof) => {
    const conn = { written: [], write(s) { this.written.push(JSON.parse(s)); }, destroy() {} };
    const state = { authenticated: true, kind: "contact", proof, deferredReply: { challengeHex: randomBytes(32).toString("hex"), sent: false } };
    await pm._sendDeferredReply(conn, state);
    return conn.written.filter((f) => f.type === "challenge-response");
  };
  assert.equal((await send("sig")).length, 1, "control: a bare-signature proof gets the reply");
  for (const proof of ["cb", undefined, null, "", "SIG", "legacy"]) {
    assert.deepEqual(await send(proof), [], `proof=${JSON.stringify(proof)}: nothing signed`);
  }
});

test("H-C24 (S3) once a sibling binds, the sibling pin is written; an old sibling is then refused and gets no feed key", T, async (t) => {
  const { wireContactBinding } = await import("../servers/sharing/contact-binding.js");
  const me = id();
  const mk = async (name) => {
    const side = await makeSide(t, name, me);
    const s = sibling(me, side.localId);
    wireContactBinding(s.pm, { db: side.db, localInstanceId: side.localId });
    return { side, ...s };
  };
  // Positive control: before the pin, an old sibling works.
  {
    const n = await mk("N0");
    const o = sibling(me, "inst-old0", { PM: OldPeerManager });
    await link(t, n.pm, o.pm);
    assert.ok(await until(() => n.calls.instanceConnected.length === 1 && o.calls.keyReceived.length === 1, 3000), "control: unpinned, the old sibling connects and gets the key");
    assert.equal(await instancePin(n.side, me.crowId), null, "a bare-signature sibling writes no pin");
  }
  const n = await mk("N1"), n2 = await mk("N2");
  await link(t, n.pm, n2.pm);
  assert.ok(await until(async () => (await instancePin(n.side, me.crowId)) === "1", 3000), "a cb sibling writes the sibling pin");
  assert.equal(await pinCount(n.side), 0, "no contact pin for a sibling");

  const o = sibling(me, "inst-old1", { PM: OldPeerManager });
  const L = await link(t, n.pm, o.pm);
  await sleep(400);
  assert.equal(n.calls.instanceConnected.filter(([, i]) => i === "inst-old1").length, 0, "the old sibling is refused");
  assert.deepEqual(o.calls.keyReceived, [], "no feed key reaches it");
  assert.equal(L.wa.some((f) => f.type === "challenge-response" || "feed_key_hex" in f), false, "nothing signed, no piggyback");
  assert.deepEqual(n.calls.keyReceived.filter(([i]) => i === "inst-old1"), [], "its piggyback is not accepted");
  assert.ok(logs.some((l) => l.includes("instance-sync connection refused: cb_required_pinned")));
});

test("H-C25 (S3) a proof relayed through an older-version sibling to a pinned new node is refused", T, async (t) => {
  const { wireContactBinding, markInstanceCbPinned } = await import("../servers/sharing/contact-binding.js");
  const me = id();
  const oracle = async (n) => {
    const toN = await rawTo(t, n.pm);
    const chN = await toN.next("challenge");
    const o = new OldPeerManager(me, { env: {} });
    const toO = await rawTo(t, o);
    await toO.next("challenge");
    toO.send({ type: "challenge", challenge: chN.challenge, crowId: "crow:relay" });
    const got = await toO.next("challenge-response", 1000);
    if (got) toN.send({ type: "challenge-response", crowId: me.crowId, pubkey: me.ed25519Pubkey, signature: got.signature }, { type: "authenticated" });
    return { toN, got };
  };
  {
    const side = await makeSide(t, "U", me);
    const n = sibling(me, side.localId);
    wireContactBinding(n.pm, { db: side.db, localInstanceId: side.localId });
    const { got } = await oracle(n);
    assert.equal(typeof got?.signature, "string");
    assert.ok(await until(() => n.calls.instanceConnected.length === 1, 3000),
      "documented residual: before any sibling has bound, a node accepts a bare signature for its own Crow ID, here one relayed from an older sibling");
  }
  const side = await makeSide(t, "P", me);
  const n = sibling(me, side.localId);
  wireContactBinding(n.pm, { db: side.db, localInstanceId: side.localId });
  assert.equal(await markInstanceCbPinned(side.db, side.localId, me.crowId), true);
  const { toN, got } = await oracle(n);
  assert.equal(typeof got?.signature, "string", "the old sibling signed");
  assert.equal(await closedWithin(toN, 3000), true, "refused");
  assert.deepEqual(n.calls.instanceConnected, []);
});

test("H-C26 (S1a, white-box, contact path) a cb_sig naming the verifier's own end is refused cb_invalid under the real pinned key; the opposite end admits", T, async () => {
  const me = id(), B = id();
  const H = randomBytes(32), X = randomBytes(32);
  const mkConn = () => ({ isInitiator: true, handshakeHash: H, written: [], destroyed: false,
    write(s) { for (const l of String(s).split("\n")) if (l.trim()) this.written.push(JSON.parse(l)); }, destroy() { this.destroyed = true; } });
  const mkPm = () => {
    const pm = new PeerManager(me, { env: {} });
    pm.p2pDisabled = true;
    const calls = { peerConnected: [], pinned: [] };
    pm.contactBinding = {
      lookupKey: async (c) => (c === B.crowId ? B.ed25519Pubkey : null),
      isCbPinned: async () => false,
      markCbPinned: async (c) => { calls.pinned.push(c); return true; },
    };
    pm.onPeerConnected = (c) => { calls.peerConnected.push(c); };
    return { pm, calls };
  };
  const cbFor = (role) => sign(contactCbMessage({ role, signerCrowId: B.crowId, challengeHex: X.toString("hex"), handshakeHashHex: H.toString("hex") }), B.ed25519Priv);
  const respond = async (pm, conn, cb_sig) => {
    const st = {};
    await pm._handleMessage(conn, { type: "challenge-response", crowId: B.crowId, pubkey: B.ed25519Pubkey, cb_sig }, X, st);
    await pm._handleMessage(conn, { type: "authenticated" }, X, st);
  };
  // Positive control: we are the initiator, so B (the responder) signs "resp".
  {
    const { pm, calls } = mkPm();
    const conn = mkConn();
    await respond(pm, conn, cbFor("resp"));
    assert.equal(conn.destroyed, false, "control: the opposite end's role admits");
    assert.deepEqual(calls.peerConnected, [B.crowId]);
    assert.deepEqual(calls.pinned, [B.crowId]);
  }
  const { pm, calls } = mkPm();
  const conn = mkConn();
  await respond(pm, conn, cbFor("init"));
  assert.equal(conn.destroyed, true, "the verifier's own role is refused");
  assert.deepEqual(refusals(B.crowId).slice(-1), ["cb_invalid"]);
  assert.deepEqual(calls.peerConnected, []);
  assert.deepEqual(calls.pinned, [], "no pin written");
  assert.equal(conn.written.some((f) => f.type === "authenticated"), false);
});
