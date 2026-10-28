/**
 * PT-2a, tailnet transport: both instance-sync handshakes (accept and dial)
 * prove the per-pair key with an HMAC over both sides' fresh nonces, pin the
 * peer after the first bound handshake, and run every side effect only after
 * the binding decision. Real two-instance harness (tests/fixtures/sync-fleet.mjs
 * + sync-gateway.mjs: real InstanceSyncManagers, real Hypercore feeds, real
 * http servers running setupTailnetSyncServer, real startTailnetSyncClients);
 * the impostors are hand-driven WebSocket peers that hold the shared seed.
 * Every refusal is paired with a positive control in the same harness. See
 * the private engineering notes for the design.
 *
 *   U-T1 new↔new binds and pins both ways.
 *   U-T2 impostor client (seed, no/wrong key) refused by the MAC.
 *   U-T3 impostor server refused by the dialer.
 *   U-T4 mixed versions: legacy in auto, refused in require, refused once pinned.
 *   U-T5 a refused handshake has no side effects.
 *   U-T6 the re-pair window retries at backoff, not the refused park.
 *   U-P4 (end to end) an unreadable store refuses a pinned peer.
 *   R1   getSyncStatus() reports pair_bound / pair_cleared_at.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { makeFleet, until, sleep, hasMemory, writeAndEmit } from "./fixtures/sync-fleet.mjs";
import { startGateway } from "./fixtures/sync-gateway.mjs";
import { _setAllowLoopbackAddressesForTest } from "../servers/sharing/tailnet-sync.js";
import { sign } from "../servers/sharing/identity.js";
import { getPeerDialHealth, _resetPeerDialHealth } from "../servers/shared/peer-dial-health.js";
import { getPeerTrustHealth, _resetPeerTrustHealth } from "../servers/shared/peer-trust-health.js";
import {
  pairSubkey, tailnetRespMac, tailnetProofMac, markPairPinned, defaultPairKey,
} from "../servers/shared/sync-pair-binding.js";

const WS_PATH = "/api/instance-sync/stream";

before(() => _setAllowLoopbackAddressesForTest(true));
after(() => _setAllowLoopbackAddressesForTest(false));

/* ------------------------------------------------------------- helpers */

const realWarn = console.warn;
const realLog = console.log;
let logs = [];
function capture() {
  logs = [];
  const rec = (orig) => (...args) => { logs.push(args.map(String).join(" ")); if (process.env.TEST_LOUD) orig(...args); };
  console.warn = rec(realWarn);
  console.log = rec(realLog);
}
function release() { console.warn = realWarn; console.log = realLog; }
// The accept side logs refusals through ctx.log; route it to the patched console.
const LOG = { warn: (...a) => console.warn(...a) };

function reset() { _resetPeerDialHealth(); _resetPeerTrustHealth(); }

const linked = (a, b) => a.mgr.hasDedicatedStream(b.id) && b.mgr.hasDedicatedStream(a.id);
const unlinked = (a, b) => !a.mgr.hasDedicatedStream(b.id) && !b.mgr.hasDedicatedStream(a.id);
const dialErr = (peerId) => getPeerDialHealth()[peerId]?.lastError || "";

async function pointAt(side, peer, port) {
  await side.db.execute({ sql: "UPDATE crow_instances SET gateway_url = ? WHERE id = ?", args: [`http://127.0.0.1:${port}`, peer.id] });
}
async function override(side, key) {
  const { rows } = await side.db.execute({ sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?", args: [key, side.id] });
  return rows[0]?.value ?? null;
}
const pinRow = (side, peerId) => override(side, `sync_pair_bound:${peerId}`);
async function peerRow(side, peerId) {
  const { rows } = await side.db.execute({ sql: "SELECT gateway_url, tailscale_ip, sync_url, last_seen_at, status FROM crow_instances WHERE id = ?", args: [peerId] });
  return { ...rows[0] };
}

/** Run one leg: the dialer's clients start, the link forms, markers flow both ways, the link is torn down. */
let markerSeq = 6000;
async function flowLeg(dialerG, x, y, label) {
  await dialerG.startClients();
  assert.ok(await until(() => linked(x, y), 10_000), `${label}: link forms`);
  const m1 = ++markerSeq; const m2 = ++markerSeq;
  await writeAndEmit(x, m1, `${label} x→y`);
  await writeAndEmit(y, m2, `${label} y→x`);
  assert.ok(await until(() => hasMemory(y.db, m1), 8000), `${label}: marker flows x→y`);
  assert.ok(await until(() => hasMemory(x.db, m2), 8000), `${label}: marker flows y→x`);
  dialerG.stopClients();
  assert.ok(await until(() => unlinked(x, y), 5000), `${label}: link torn down`);
}

function addrSig(identity, asId, nonce, addr) {
  const canon = JSON.stringify({ gateway_url: addr.gateway_url ?? null, tailscale_ip: addr.tailscale_ip ?? null, sync_port: addr.sync_port ?? null });
  return sign(`addr:${asId}:${nonce}:${canon}`, identity.ed25519Priv);
}

function hello(identity, asId, { cr = true, pb = true, addr = null } = {}) {
  const nonce = randomBytes(16).toString("hex");
  const h = { instance_id: asId, nonce_hex: nonce, sig_hex: sign(`${asId}:${nonce}`, identity.ed25519Priv) };
  if (cr) h.cr = 1;
  if (cr && pb) h.pb = 1;
  if (addr) { h.addr = addr; h.addr_sig = addrSig(identity, asId, nonce, addr); }
  return h;
}

/** A hand-driven client connection that records every text frame. */
async function openRaw(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
  const frames = [];
  let closeCode = null; let closeReason = "";
  const waiters = [];
  ws.on("message", (d, bin) => {
    if (bin) return;
    frames.push(JSON.parse(d.toString()));
    for (const w of waiters.splice(0)) w();
  });
  ws.on("error", () => {});
  const closed = new Promise((r) => ws.on("close", (c, why) => { closeCode = c; closeReason = String(why || ""); r(); for (const w of waiters.splice(0)) w(); }));
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  const nextFrame = async (n, ms = 3000) => {
    const t0 = Date.now();
    while (frames.length < n && closeCode === null && Date.now() - t0 < ms) await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
    return frames[n - 1];
  };
  return { ws, frames, closed, nextFrame, close: () => ws.terminate(), code: () => closeCode, reason: () => closeReason };
}

/**
 * An impostor CLIENT holding the seed: a genuine CR handshake as `asId`, with
 * a pb_proof under `key` (none when key is null).
 */
async function impostorClient(port, identity, { asId, serverId, key = null, addr = null }) {
  const c = await openRaw(port);
  const h = hello(identity, asId, { addr });
  c.ws.send(JSON.stringify(h));
  const s = await c.nextFrame(1);
  assert.ok(s?.nonce_hex, "the server answered the hello (the gate is not an earlier check)");
  const proof = { cr_proof: sign(`cr-proof:${asId}:${serverId}:${s.nonce_hex}:${h.nonce_hex}`, identity.ed25519Priv) };
  if (key) proof.pb_proof = tailnetProofMac(pairSubkey(key), { client: asId, server: serverId, sN: s.nonce_hex, cN: h.nonce_hex });
  c.ws.send(JSON.stringify(proof));
  const k = await c.nextFrame(2);
  const gotFeedKey = Boolean(k && "feed_key_hex" in k);
  if (gotFeedKey) c.ws.send(JSON.stringify({ feed_key_hex: null }));
  else await Promise.race([c.closed, sleep(3000)]);
  return { c, h, s, gotFeedKey, code: c.code(), reason: c.reason() };
}

/**
 * An impostor SERVER holding the seed, answering as `asId` with a valid
 * cr_sig and a pb_mac that is "missing", "invalid" or "valid" (under `key`).
 */
async function impostorServer(identity, { asId, key, addr = null, feedKey = null }) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: WS_PATH });
  const got = [];
  const opts = { pbMac: "missing" };
  wss.on("connection", (ws) => {
    ws.on("message", (d, bin) => {
      if (bin) return;
      const m = JSON.parse(d.toString());
      got.push(m);
      if (m.instance_id) {
        const sh = hello(identity, asId, { cr: false, addr });
        sh.cr_sig = sign(`cr-resp:${asId}:${m.instance_id}:${m.nonce_hex}:${sh.nonce_hex}`, identity.ed25519Priv);
        if (opts.pbMac === "valid") sh.pb_mac = tailnetRespMac(pairSubkey(key), { server: asId, client: m.instance_id, cN: m.nonce_hex, sN: sh.nonce_hex });
        if (opts.pbMac === "invalid") sh.pb_mac = "ab".repeat(32);
        ws.send(JSON.stringify(sh));
      } else if ("cr_proof" in m) {
        ws.send(JSON.stringify({ feed_key_hex: feedKey }));
      }
    });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  return {
    port: http.address().port, got, opts,
    drop() { for (const c of wss.clients) c.terminate(); },
    async close() { for (const c of wss.clients) c.terminate(); await new Promise((r) => http.close(r)); },
  };
}

/* ----------------------------------------------------------- U-T1 */

test("U-T1 new↔new: the handshake binds both ways, markers flow both ways, and both sides pin the peer and report it", async () => {
  reset();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const A = await startGateway(fleet, a, { log: LOG });
  const B = await startGateway(fleet, b, { log: LOG });
  capture();
  try {
    assert.equal(await pinRow(a, b.id), null, "control: no pin before the first handshake");
    await pointAt(a, b, B.port);
    await A.startClients();
    assert.ok(await until(() => linked(a, b), 10_000), "the link forms");
    const m1 = ++markerSeq; const m2 = ++markerSeq;
    await writeAndEmit(a, m1, "a→b");
    await writeAndEmit(b, m2, "b→a");
    assert.ok(await until(() => hasMemory(b.db, m1), 8000), "a→b flows");
    assert.ok(await until(() => hasMemory(a.db, m2), 8000), "b→a flows");
    assert.equal(await pinRow(a, b.id), "1", "the dialer pinned the server");
    assert.equal(await pinRow(b, a.id), "1", "the server pinned the dialer");
    assert.ok(logs.some((l) => /pair-bound/.test(l) && l.includes(b.id.slice(0, 5)) && /client side/.test(l)), "the dialer logs pair-bound");
    assert.ok(logs.some((l) => /pair-bound/.test(l) && /server side/.test(l)), "the server logs pair-bound");
    assert.ok(!logs.some((l) => /pair binding failed/.test(l)), "no refusal on the way");
    const health = getPeerTrustHealth();
    assert.equal(health.unboundPeers[a.id], undefined);
    assert.equal(health.unboundPeers[b.id], undefined);
    // R1: getSyncStatus shows the pin.
    const sa = (await a.mgr.getSyncStatus()).find((s) => s.instanceId === b.id);
    const sb = (await b.mgr.getSyncStatus()).find((s) => s.instanceId === a.id);
    assert.equal(sa?.pair_bound, true);
    assert.equal(sb?.pair_bound, true);
    assert.equal(sa?.pair_cleared_at, null);
  } finally {
    release();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

/* ----------------------------------------------------------- U-T2 */

test("U-T2 impostor client with the seed: no key → pb_required (require, unpinned) and pb_required_pinned (after the pin); wrong key → pb_invalid; positive control: B's real key is accepted", async () => {
  reset();
  // b sorts first, so B is the elected dialer and A the server.
  const fleet = await makeFleet({ ids: ["inst2", "inst1"] });
  const { a, b, identity, pairKey } = fleet;
  const A = await startGateway(fleet, a, { log: LOG, pairBindingMode: "require" });
  const B = await startGateway(fleet, b, { log: LOG });
  capture();
  const raws = [];
  try {
    // M1: require, nothing pinned yet, no key → pb_required.
    let r = await impostorClient(A.port, identity, { asId: b.id, serverId: a.id });
    raws.push(r.c);
    assert.equal(r.code, 1008);
    assert.equal(r.reason, "pair binding failed");
    assert.equal(r.gotFeedKey, false, "no feed key");
    assert.ok(logs.some((l) => /pair binding failed/.test(l) && /pb_required(?!_)/.test(l)), logs.join("\n"));
    assert.equal(await pinRow(a, b.id), null);

    // The genuine elected dialer binds; A pins it.
    A.ctx.pairBindingMode = "auto";
    await pointAt(b, a, A.port);
    await B.startClients();
    assert.ok(await until(() => linked(a, b), 10_000), "the genuine sibling links");
    assert.equal(await pinRow(a, b.id), "1");
    B.stopClients();
    assert.ok(await until(() => unlinked(a, b), 5000));

    // No key, A has pinned B → pb_required_pinned (auto does not matter).
    logs = [];
    r = await impostorClient(A.port, identity, { asId: b.id, serverId: a.id });
    raws.push(r.c);
    assert.equal(r.code, 1008);
    assert.equal(r.reason, "pair binding failed");
    assert.equal(r.gotFeedKey, false);
    assert.ok(logs.some((l) => /pair binding failed/.test(l) && /pb_required_pinned/.test(l)), logs.join("\n"));
    assert.ok(!logs.some((l) => /bad sig|unknown peer|bad proof/.test(l)), "the gate is the MAC, not an earlier check");

    // Wrong key → pb_invalid.
    logs = [];
    r = await impostorClient(A.port, identity, { asId: b.id, serverId: a.id, key: randomBytes(32).toString("hex") });
    raws.push(r.c);
    assert.equal(r.code, 1008);
    assert.equal(r.reason, "pair binding failed");
    assert.equal(r.gotFeedKey, false);
    assert.ok(logs.some((l) => /pair binding failed/.test(l) && /pb_invalid/.test(l)), logs.join("\n"));
    assert.ok(!logs.some((l) => /bad sig|unknown peer|bad proof/.test(l)));

    // Positive control, same harness: B's real key is accepted, and A's
    // pb_mac verifies under it.
    logs = [];
    r = await impostorClient(A.port, identity, { asId: b.id, serverId: a.id, key: pairKey });
    raws.push(r.c);
    assert.equal(r.gotFeedKey, true, "the real key unlocks the feed key");
    assert.equal(r.s.pb_mac, tailnetRespMac(pairSubkey(pairKey), { server: a.id, client: b.id, cN: r.h.nonce_hex, sN: r.s.nonce_hex }), "A's pb_mac is bound to both nonces");
    assert.ok(!logs.some((l) => /pair binding failed/.test(l)));
  } finally {
    release();
    for (const c of raws) c.close();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

/* ----------------------------------------------------------- U-T3 */

test("U-T3 impostor server with the seed: the dialer refuses a missing pb_mac (pinned) and an invalid one, leaking no proof and no feed key; positive control: a valid pb_mac gets cr_proof + pb_proof", async () => {
  reset();
  const fleet = await makeFleet();
  const { a, b, identity, pairKey } = fleet;
  const A = await startGateway(fleet, a, { log: LOG });
  const B = await startGateway(fleet, b, { log: LOG });
  const imp = await impostorServer(identity, { asId: b.id, key: pairKey });
  capture();
  try {
    await pointAt(a, b, B.port);
    await A.startClients();
    assert.ok(await until(() => linked(a, b), 10_000));
    assert.equal(await pinRow(a, b.id), "1");
    A.stopClients();
    assert.ok(await until(() => unlinked(a, b), 5000));

    await pointAt(a, b, imp.port);
    for (const [mode, reason] of [["missing", "pb_required_pinned"], ["invalid", "pb_invalid"]]) {
      imp.opts.pbMac = mode;
      imp.got.length = 0;
      _resetPeerDialHealth();
      await A.startClients();
      assert.ok(await until(() => dialErr(b.id).includes(`pair binding failed (${reason})`), 5000), `${mode}: ${dialErr(b.id)}`);
      await sleep(150);
      A.stopClients();
      imp.drop();
      assert.ok(imp.got.some((m) => m.instance_id === a.id && m.cr === 1 && m.pb === 1), `${mode}: the dialer reached the impostor and offered pb`);
      assert.ok(!imp.got.some((m) => "cr_proof" in m || "pb_proof" in m || "feed_key_hex" in m), `${mode}: no proof and no feed key leaked`);
      assert.ok(logs.some((l) => /pair binding failed/.test(l) && l.includes(reason)), logs.join("\n"));
    }

    // Positive control: a valid pb_mac → the dialer proves both factors.
    imp.opts.pbMac = "valid";
    imp.got.length = 0;
    _resetPeerDialHealth();
    await A.startClients();
    assert.ok(await until(() => imp.got.some((m) => "cr_proof" in m), 5000), "proof sent to a server with a valid pb_mac");
    const proof = imp.got.find((m) => "cr_proof" in m);
    assert.equal(typeof proof.pb_proof, "string", "pb_proof rides with cr_proof");
    A.stopClients();
    imp.drop();
  } finally {
    release();
    await A.close();
    await B.close();
    await imp.close();
    await fleet.cleanup();
  }
});

/* ----------------------------------------------------------- U-T4 */

test("U-T4 mixed versions: an old sibling (legacy handshake, or CR without pb) syncs both ways as legacy in auto with a Nest item; refused in require; refused once pinned", async () => {
  reset();
  const fleet = await makeFleet(); // a sorts first: A is the elected dialer, B fallback-dials
  const { a, b } = fleet;
  const A = await startGateway(fleet, a, { log: LOG, pairBindingMode: "auto" });
  const B = await startGateway(fleet, b, { log: LOG });
  capture();
  try {
    await pointAt(a, b, B.port);
    await pointAt(b, a, A.port);

    for (const [flag, label] of [[{ legacyHandshake: true }, "legacy handshake"], [{ pairBindingOffer: false }, "CR without pb"]]) {
      Object.assign(B.ctx, { legacyHandshake: false, pairBindingOffer: true }, flag);
      _resetPeerTrustHealth();
      await flowLeg(A, a, b, `${label}, A dials`);
      assert.match(getPeerTrustHealth().unboundPeers[b.id]?.message || "", /without pair binding/, `${label}: A raises the Nest item`);
      await flowLeg(B, b, a, `${label}, B dials`);
      assert.match(getPeerTrustHealth().unboundPeers[b.id]?.message || "", /without pair binding/);
      assert.equal(await pinRow(a, b.id), null, `${label}: a legacy link never pins`);
    }

    // require: the same old sibling is refused, in both directions.
    A.ctx.pairBindingMode = "require";
    _resetPeerDialHealth();
    await A.startClients();
    assert.ok(await until(() => dialErr(b.id).includes("pair binding failed (pb_required)"), 5000), dialErr(b.id));
    assert.equal(a.mgr.hasDedicatedStream(b.id), false);
    A.stopClients();
    await B.startClients();
    assert.ok(await until(() => /closed by peer \(1008 pair binding failed\)/.test(dialErr(a.id)), 5000), dialErr(a.id));
    assert.equal(getPeerTrustHealth().pairBindingRefusals[b.id]?.reason, "pb_required");
    assert.equal(a.mgr.hasDedicatedStream(b.id), false);
    B.stopClients();

    // Positive control: B upgrades → bound and pinned.
    A.ctx.pairBindingMode = "auto";
    B.ctx.pairBindingOffer = true;
    await flowLeg(A, a, b, "both new");
    assert.equal(await pinRow(a, b.id), "1");
    assert.equal(getPeerTrustHealth().unboundPeers[b.id], undefined, "the bound handshake clears the Nest item");

    // Pinned, then B downgrades: refused both ways even in auto.
    B.ctx.pairBindingOffer = false;
    _resetPeerDialHealth();
    await A.startClients();
    assert.ok(await until(() => dialErr(b.id).includes("pair binding failed (pb_required_pinned)"), 5000), dialErr(b.id));
    A.stopClients();
    await B.startClients();
    assert.ok(await until(() => /closed by peer \(1008 pair binding failed\)/.test(dialErr(a.id)), 5000), dialErr(a.id));
    assert.equal(getPeerTrustHealth().pairBindingRefusals[b.id]?.reason, "pb_required_pinned");
    B.stopClients();
    assert.equal(a.mgr.hasDedicatedStream(b.id), false);
  } finally {
    release();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

/* ----------------------------------------------------------- U-T5 */

test("U-T5 side-effect ordering, accept side: a refused handshake leaves the CR pin, port memo, sync_url, last_seen_at and gateway_url unchanged and never calls initInstance; positive control: the bound one writes them", async () => {
  reset();
  const fleet = await makeFleet({ ids: ["inst2", "inst1"] });
  const { a, b, identity, pairKey } = fleet;
  const A = await startGateway(fleet, a, { log: LOG });
  await markPairPinned(a.db, a.id, b.id);
  const calls = [];
  const realInit = a.mgr.initInstance.bind(a.mgr);
  a.mgr.initInstance = (id, key) => { calls.push({ id, key }); return realInit(id, key); };
  const addr = { gateway_url: "http://127.0.0.1:4999", tailscale_ip: "127.0.0.1", sync_port: 4999 };
  capture();
  const raws = [];
  try {
    const before = await peerRow(a, b.id);
    assert.equal(before.gateway_url, null, "precondition: an empty row the address backfill would fill");
    const r = await impostorClient(A.port, identity, { asId: b.id, serverId: a.id, addr });
    raws.push(r.c);
    assert.equal(r.reason, "pair binding failed");
    await sleep(200);
    assert.deepEqual(await peerRow(a, b.id), before, "row unchanged (gateway_url, tailscale_ip, sync_url, last_seen_at)");
    assert.equal(await override(a, `tailnet_sync_cr:${b.id}`), null, "no CR pin");
    assert.equal(await override(a, `tailnet_sync_port:${b.id}`), null, "no port memo");
    assert.equal(calls.length, 0, "initInstance never called");

    // Positive control: the same handshake with the real key writes them all.
    const ok = await impostorClient(A.port, identity, { asId: b.id, serverId: a.id, addr, key: pairKey });
    raws.push(ok.c);
    assert.equal(ok.gotFeedKey, true);
    assert.ok(await until(async () => (await peerRow(a, b.id)).last_seen_at !== before.last_seen_at, 3000), "last_seen_at moves");
    const after = await peerRow(a, b.id);
    assert.equal(after.gateway_url, addr.gateway_url, "address backfilled");
    assert.equal(await override(a, `tailnet_sync_cr:${b.id}`), "1");
    assert.equal(await override(a, `tailnet_sync_port:${b.id}`), "4999");
    assert.ok(calls.length >= 1, "initInstance called after the decision");
  } finally {
    release();
    for (const c of raws) c.close();
    await A.close();
    await fleet.cleanup();
  }
});

test("U-T5 side-effect ordering, dial side: a refused server leaves the CR pin, port memo, tailscale_ip and last_seen_at unchanged and never calls initInstance; positive control: the bound one writes them", async () => {
  reset();
  const fleet = await makeFleet();
  const { a, b, identity, pairKey } = fleet;
  const addr = { gateway_url: null, tailscale_ip: "127.0.0.1", sync_port: 4998 };
  const imp = await impostorServer(identity, { asId: b.id, key: pairKey, addr, feedKey: randomBytes(32).toString("hex") });
  const A = await startGateway(fleet, a, { log: LOG });
  await markPairPinned(a.db, a.id, b.id);
  await pointAt(a, b, imp.port);
  // The refresh loop's heal calls initInstance(peer, null) on its own; the
  // handshake's call is the one that carries the peer's feed key.
  const keyed = [];
  const realInit = a.mgr.initInstance.bind(a.mgr);
  a.mgr.initInstance = (id, key) => { if (key) keyed.push({ id, key }); return realInit(id, key); };
  capture();
  try {
    const before = await peerRow(a, b.id);
    imp.opts.pbMac = "missing";
    await A.startClients();
    assert.ok(await until(() => dialErr(b.id).includes("pair binding failed (pb_required_pinned)"), 5000), dialErr(b.id));
    await sleep(200);
    A.stopClients();
    imp.drop();
    assert.deepEqual(await peerRow(a, b.id), before, "row unchanged (tailscale_ip, sync_url, last_seen_at)");
    assert.equal(await override(a, `tailnet_sync_cr:${b.id}`), null, "no CR pin");
    assert.equal(await override(a, `tailnet_sync_port:${b.id}`), null, "no port memo");
    assert.equal(keyed.length, 0, "initInstance never called with a key");

    imp.opts.pbMac = "valid";
    await A.startClients();
    assert.ok(await until(async () => (await peerRow(a, b.id)).last_seen_at !== before.last_seen_at, 5000), "last_seen_at moves");
    assert.equal((await peerRow(a, b.id)).tailscale_ip, "127.0.0.1", "address backfilled");
    assert.equal(await override(a, `tailnet_sync_cr:${b.id}`), "1");
    assert.equal(await override(a, `tailnet_sync_port:${b.id}`), "4998");
    assert.ok(keyed.length >= 1, "initInstance called with the feed key after the decision");
    assert.notEqual((await peerRow(a, b.id)).sync_url, before.sync_url, "sync_url persisted");
    A.stopClients();
  } finally {
    release();
    await A.close();
    await imp.close();
    await fleet.cleanup();
  }
});

/* ----------------------------------------------------------- U-T6 */

test("U-T6 re-pair window: keys that differ for 2 s are refused (pb_invalid), retried at normal backoff (not the 10-min refused park), and the link forms within 15 s", async () => {
  reset();
  const fleet = await makeFleet();
  const { a, b, pairKey } = fleet;
  const A = await startGateway(fleet, a, { log: LOG, refusedRecheckMs: 600_000 });
  const B = await startGateway(fleet, b, { log: LOG });
  capture();
  try {
    await pointAt(a, b, B.port);
    a.pairKeys.set(b.id, randomBytes(32).toString("hex"));
    const fix = setTimeout(() => a.pairKeys.set(b.id, pairKey), 2000);
    const t0 = Date.now();
    await A.startClients();
    assert.ok(await until(() => dialErr(b.id).includes("pair binding failed (pb_invalid)"), 3000), dialErr(b.id));
    assert.ok(await until(() => linked(a, b), 15_000), `link within 15 s (${Date.now() - t0} ms)`);
    clearTimeout(fix);
    assert.equal(await pinRow(a, b.id), "1");
    assert.equal(await pinRow(b, a.id), "1");
  } finally {
    release();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

test("U-T6 re-pair window, peer refusal: a pinned server refuses a dialer with no key yet (1008 pair binding failed); the dialer retries at backoff, not the refused park, and links within 15 s", async () => {
  reset();
  const fleet = await makeFleet();
  const { a, b, pairKey } = fleet;
  const A = await startGateway(fleet, a, { log: LOG, refusedRecheckMs: 600_000 });
  const B = await startGateway(fleet, b, { log: LOG });
  await markPairPinned(b.db, b.id, a.id);
  capture();
  try {
    await pointAt(a, b, B.port);
    a.pairKeys.delete(b.id);
    const fix = setTimeout(() => a.pairKeys.set(b.id, pairKey), 2000);
    const t0 = Date.now();
    await A.startClients();
    assert.ok(await until(() => /closed by peer \(1008 pair binding failed\)/.test(dialErr(b.id)), 3000), dialErr(b.id));
    assert.ok(await until(() => linked(a, b), 15_000), `link within 15 s (${Date.now() - t0} ms)`);
    clearTimeout(fix);
    assert.equal(await pinRow(a, b.id), "1");
  } finally {
    release();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

/* ----------------------------------------------------------- U-P4 e2e */

test("U-P4 end to end: the production key lookup with a store at mode 0644 holds no key, so a pinned sibling is refused pb_required_pinned with a 're-pair to fix' Nest item; positive control: at 0600 it binds", async () => {
  reset();
  const fleet = await makeFleet(); // A (the production lookup) is the elected dialer
  const { a, b, pairKey } = fleet;
  const dir = mkdtempSync(join(tmpdir(), "tailnet-pb-store-"));
  const store = join(dir, "peer-tokens.json");
  writeFileSync(store, JSON.stringify({ [b.id]: { signing_key: pairKey } }), { mode: 0o600 });
  chmodSync(store, 0o600);
  const prev = process.env.CROW_PEER_TOKENS_PATH;
  process.env.CROW_PEER_TOKENS_PATH = store;
  const A = await startGateway(fleet, a, { log: LOG, pairKeyLookup: defaultPairKey });
  const B = await startGateway(fleet, b, { log: LOG });
  capture();
  try {
    await pointAt(a, b, B.port);
    await A.startClients();
    assert.ok(await until(() => linked(a, b), 10_000), "binds at 0600");
    assert.equal(await pinRow(a, b.id), "1");
    A.stopClients();
    assert.ok(await until(() => unlinked(a, b), 5000));

    chmodSync(store, 0o644);
    assert.equal(defaultPairKey(b.id), null, "a loose store reads as empty");
    _resetPeerDialHealth();
    await A.startClients();
    assert.ok(await until(() => dialErr(b.id).includes("pair binding failed (pb_required_pinned)"), 5000), dialErr(b.id));
    const refusal = getPeerTrustHealth().pairBindingRefusals[b.id];
    assert.equal(refusal?.reason, "pb_required_pinned");
    assert.match(refusal?.message || "", /no pair key for .*re-pair to fix/);
    assert.equal(a.mgr.hasDedicatedStream(b.id), false);
    A.stopClients();

    // The same loose store on the SERVER side: A refuses B's dial before it
    // answers, and raises the same item (B pinned A in the first leg).
    _resetPeerDialHealth();
    _resetPeerTrustHealth();
    await pointAt(b, a, A.port);
    await B.startClients(); // B is not elected: it fallback-dials A
    assert.ok(await until(() => /closed by peer \(1008 pair binding failed\)/.test(dialErr(a.id)), 5000), dialErr(a.id));
    const serverRefusal = getPeerTrustHealth().pairBindingRefusals[b.id];
    assert.equal(serverRefusal?.reason, "pb_required_pinned");
    assert.match(serverRefusal?.message || "", /no pair key for .*re-pair to fix/);
    B.stopClients();
  } finally {
    release();
    if (prev === undefined) delete process.env.CROW_PEER_TOKENS_PATH; else process.env.CROW_PEER_TOKENS_PATH = prev;
    await A.close();
    await B.close();
    await fleet.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------- R1 */

test("R1 getSyncStatus(): pair_bound and pair_cleared_at per peer, from the LOCAL pin and clear-marker rows", async () => {
  const fleet = await makeFleet();
  const { a, b } = fleet;
  try {
    await a.mgr.initInstance(b.id, null);
    const row = async () => (await a.mgr.getSyncStatus()).find((s) => s.instanceId === b.id);
    assert.equal((await row()).pair_bound, false);
    assert.equal((await row()).pair_cleared_at, null);
    // Another instance's rows do not count: LOCAL scope only.
    await a.db.execute({ sql: "INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at) VALUES (?, ?, '1', datetime('now'))", args: [`sync_pair_bound:${b.id}`, b.id] });
    assert.equal((await row()).pair_bound, false, "a row under another instance id is not our pin");
    const iso = "2026-10-28T12:00:00.000Z";
    await a.db.execute({ sql: "INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at) VALUES (?, ?, ?, datetime('now'))", args: [`sync_pair_cleared:${b.id}`, a.id, iso] });
    assert.equal((await row()).pair_cleared_at, iso);
    await markPairPinned(a.db, a.id, b.id);
    assert.equal((await row()).pair_bound, true);
    assert.equal((await row()).pair_cleared_at, null, "a new pin removes the clear marker");
  } finally {
    await fleet.cleanup();
  }
});
