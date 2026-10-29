/**
 * PT-2a, Hyperswarm transport (private engineering notes, §3.2, §3.3, §3.5):
 * a sibling handshake on the instance-sync path also proves the PER-PAIR key.
 *
 *   challenge            {..., cb: 1, pb: 1, instance_id}
 *   challenge-response   {..., cb_sig}              (the same for everyone)
 *   pair-binding         {pb_mac = HMAC(K_pb,
 *                          "hs-pb\n<responder>\n<challenger>\n<challengeHex>\n<handshakeHashHex>") | null}
 *                        sent only after the peer's cb_sig verified, and
 *                        only to a peer whose challenge offered pb
 *
 * The MAC covers the Noise handshake hash, so it cannot be relayed to another
 * connection. The verifier (admitGuards.instance, installed by
 * wireInstanceSync) decides with decidePairBinding BEFORE anything the
 * admission does (instance-key, feed-key lookup, onInstanceConnected,
 * initInstance, replicate), and uses the same LOCAL pin as the tailnet
 * transport (sync_pair_bound:<id>): one pin covers both.
 *
 * Harness: real init-db scratch DBs, real InstanceSyncManagers with real
 * Hypercore feeds (tests/fixtures/sync-fleet.mjs), real PeerManagers linked
 * over loopback NoiseSecretStream socket pairs (never the public DHT). New
 * nodes are wired through wireInstanceSync, the function boot.js calls. Old
 * nodes are wired ONLY from their own tree (tests/fixtures/old-tree.mjs):
 * their PeerManager, instance-connect, instance-sync, peer-trust and (PT-3)
 * contact-binding modules, plus a verbatim copy of that tree's boot.js
 * instance closures (below). Non-conforming peers are raw scripted streams
 * that hold the shared seed.
 *
 *   U-H1  new↔new binds and pins both ways; feed keys only in instance-key; markers flow.
 *   U-H2  a seed holder without the pair key claiming B.
 *   U-H3  mixed versions (PT-3 and pre-PT-3 trees), both Noise role orders, mutual.
 *   U-H4  a relay between two new siblings (regression: PT-3's cb_sig).
 *   U-H5  the guard runs inside the frame chain: an early instance-key waits for it.
 *   U-H6  a sibling without an instance id: unpinned rows only (auto), refused (require).
 *   U-H7c/d (carried from Task 0, real guard): "constructor"; self-loopback.
 *   U-H8  no guard wired: refused guard:unwired.
 *   U-X1  pinned by a bound TAILNET handshake → refused unbound on Hyperswarm.
 *   U-H10 stranger probes cannot tell which ids we hold pair keys for.
 *   U-H11 a sibling that offers pb and never sends its frame: pb_timeout.
 *   U-H12 a bare-signature prover never gets a pair-binding frame.
 *   U-H9  every refusal above left the wired callbacks and replicate untouched.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import NoiseSecretStream from "@hyperswarm/secret-stream";

import {
  makeSharedIdentity, makeRealDb, addPeerRow, socketPair, until, sleep, hasMemory, writeAndEmit, makeFleet, SHARED_CROW_ID,
} from "./fixtures/sync-fleet.mjs";
import { startGateway } from "./fixtures/sync-gateway.mjs";
import { oldTree } from "./fixtures/old-tree.mjs";
import { PeerManager } from "../servers/sharing/peer-manager.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import * as IC from "../servers/sharing/instance-connect.js";
import { sign, deriveInstanceIdentity } from "../servers/sharing/identity.js";
import { contactCbMessage, wireContactBinding, markInstanceCbPinned } from "../servers/sharing/contact-binding.js";
import { pairSubkey, hyperswarmMac, markPairPinned, defaultPairKey } from "../servers/shared/sync-pair-binding.js";
import { getPeerTrustHealth, _resetPeerTrustHealth } from "../servers/shared/peer-trust-health.js";
import { _setAllowLoopbackAddressesForTest } from "../servers/sharing/tailnet-sync.js";
import { _dbKeepers, _walTripwires } from "../servers/db.js";

const PRE_PT3_SHA = "8afbabaf5cacc1b1c590451218d46eff43692072"; // PT-2.0: bare signature
const PT3_SHA = "d733b582bbbc977a377c60bf95893cf2d5902635";     // PT-3: channel-bound, pre-PT-2a
const T = { timeout: 180_000 };

// ---------------------------------------------------------------- logs
const logs = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };
const capture = (...a) => { logs.push(a.map(String).join(" ")); if (process.env.TEST_LOUD) realConsole.log(...a); };
const refusedFor = (reason) => logs.some((l) => l === `[peer-manager] instance-sync connection refused: ${reason}`);
/** The captured peer-manager / sharing lines, for an assertion message. */
const pmLogs = () => logs.filter((l) => l.startsWith("[peer-manager]") || l.startsWith("[sharing]")).slice(-20).join(" | ") || "(none)";

// ---------------------------------------------------------------- waits
// Every positive wait is a bounded until(): it returns as soon as the event
// happens, so a generous bound costs nothing on a fast box and keeps a
// starved CI runner (small runner, the whole suite in parallel) from failing
// on time alone. PT2A_WAIT_SCALE overrides the factor.
const SCALE = Math.max(1, Number(process.env.PT2A_WAIT_SCALE) || 4);
const W = (ms) => ms * SCALE;

// ---------------------------------------------------------------- teardown
/*
 * Every resource a test opens (streams and their sockets, PeerManagers,
 * InstanceSyncManagers, DBs and their WAL keepers, scratch dirs, fleets) is
 * registered here. A test's steps run LIFO in its t.after, so links close
 * before the managers that replicate over them, managers before their DBs,
 * DBs before their dirs, and they run when an assertion throws too. Each
 * step is capped (STEP_CAP_MS) so a stuck close cannot hang the file; the
 * file-level after() runs anything a test left behind.
 *
 * Why the order matters: an admission that just happened still has its
 * key exchange in flight (getFeedKeyForInstance / onInstanceKeyReceived →
 * initInstance opens a Hypercore). Removing the side's dir under that open
 * either throws ENOTEMPTY from rmSync (a failed after-hook) or crashes the
 * process (rocksdb-native SIGSEGVs in its open callback when the open
 * fails). So a side refuses new opens once its teardown starts, waits for
 * the opens in flight, closes, and only then is its dir removed.
 */
const STEP_CAP_MS = 15_000;
const pendingSteps = new Set();
const perTestSteps = new WeakMap();
async function runStep(step) {
  if (!pendingSteps.delete(step)) return;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(step.fn),
      new Promise((r) => { timer = setTimeout(() => { realConsole.error(`[teardown] ${step.label}: not done after ${STEP_CAP_MS} ms, moving on`); r(); }, STEP_CAP_MS); }),
    ]);
  } catch (err) {
    realConsole.error(`[teardown] ${step.label}: ${err?.message ?? err}`);
  } finally {
    clearTimeout(timer);
  }
}
function onTeardown(t, label, fn) {
  const step = { label, fn };
  pendingSteps.add(step);
  let list = perTestSteps.get(t);
  if (!list) {
    list = [];
    perTestSteps.set(t, list);
    t.after(async () => { while (list.length) await runStep(list.pop()); });
  }
  list.push(step);
}
/** Close this process's WAL keeper and tripwire for every DB under `dir` (db.js keeps one per path). */
function releaseDbFiles(dir) {
  for (const [path, keeper] of [..._dbKeepers]) {
    if (!path.startsWith(dir)) continue;
    try { keeper.close(); } catch {}
    _dbKeepers.delete(path);
  }
  for (const [path, tw] of [..._walTripwires]) {
    if (!path.startsWith(dir)) continue;
    clearInterval(tw.timer);
    _walTripwires.delete(path);
  }
}
const removeDir = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
/** From now on `side`'s manager opens no feed; the opens in flight are awaited, then it closes. */
function guardSideOpens(side) {
  side.closed = false;
  side.inflight = new Set();
  const init = side.mgr.initInstance.bind(side.mgr);
  side.mgr.initInstance = (...a) => {
    if (side.closed) return Promise.reject(new Error("side torn down"));
    const p = init(...a);
    side.inflight.add(p);
    p.then(() => side.inflight.delete(p), () => side.inflight.delete(p));
    return p;
  };
}
async function closeSide(side) {
  side.closed = true;
  for (let i = 0; i < 3; i++) {
    await Promise.allSettled([...side.inflight]);
    try { await side.mgr.close(); } catch {}
    if (side.inflight.size === 0 && !side.mgr.outFeeds?.size && !side.mgr.inFeeds?.size) break;
  }
  side.quiet = side.inflight.size === 0;
}
/** Remove a side's dir only once its manager is quiet: never under an open in flight (see above). */
function removeSideDir(side) {
  if (!side.quiet) { realConsole.error(`[teardown] ${side.dir}: left in place, feed opens still in flight`); return; }
  removeDir(side.dir);
}

// ---------------------------------------------------------------- old trees
const trees = {};
before(async () => {
  console.log = capture; console.warn = capture; console.error = capture;
  for (const [name, sha] of [["pre", PRE_PT3_SHA], ["pt3", PT3_SHA]]) {
    const tree = await oldTree(sha);
    trees[name] = {
      tree,
      PeerManager: (await tree.importModule("servers/sharing/peer-manager.js")).PeerManager,
      InstanceSyncManager: (await tree.importModule("servers/sharing/instance-sync.js")).InstanceSyncManager,
      handleInstanceConnection: (await tree.importModule("servers/sharing/instance-connect.js")).handleInstanceConnection,
      TRUSTED_PEER_SQL: (await tree.importModule("servers/shared/peer-trust.js")).TRUSTED_PEER_SQL,
      wireContactBinding: name === "pt3" ? (await tree.importModule("servers/sharing/contact-binding.js")).wireContactBinding : null,
      wireClosures: name === "pt3" ? wireBootClosuresPT3 : wireBootClosuresPrePT3,
    };
  }
}, { timeout: 900_000 });
after(async () => {
  for (const step of [...pendingSteps].reverse()) await runStep(step);
  Object.assign(console, realConsole);
  for (const t of Object.values(trees)) t.tree?.cleanup();
});

/*
 * Verbatim copy of servers/sharing/boot.js at PRE_PT3_SHA (8afbabaf), lines
 * 779-847: the three instance closures (and the localInstanceId line between
 * them). Only the enclosing function and its parameters are added, so the
 * old tree's own imports are in scope.
 */
function wireBootClosuresPrePT3({ peerManager, db, instanceSyncManager, handleInstanceConnection, TRUSTED_PEER_SQL }) {
  // Wire instance-to-instance connections for Hypercore replication
  peerManager.onInstanceConnected = async (crowId, conn, remoteInstanceId = null) => {
    console.log(`[sharing] Instance peer connected: ${crowId}`);

    // One connection = one instance when the peer advertised its id
    // (servers/sharing/instance-connect.js, review I2).
    try {
      await handleInstanceConnection({ db, instanceSyncManager, crowId, conn, remoteInstanceId });
    } catch (err) {
      console.warn(`[sharing] Instance connection handling failed for ${crowId}:`, err.message);
    }
  };

  // Advertise our own local instance_id to peer-manager so it can include
  // the id on the challenge/challenge-response JSON (disambiguates peers
  // when all instances of one user share one crow_id).
  peerManager.localInstanceId = instanceSyncManager.localInstanceId;

  // peer-manager asks us for OUR outgoing feed key to a specific peer
  // instance (remoteInstanceId is the peer's local id, which matches the
  // `id` column in our crow_instances table for that peer's row).
  peerManager.getFeedKeyForInstance = async (remoteInstanceId) => {
    try {
      // Only return a key if we actually have a paired row for this instance.
      const { rows } = await db.execute({
        sql: `SELECT id FROM crow_instances WHERE id = ? AND ${TRUSTED_PEER_SQL} AND id != ? LIMIT 1`,
        args: [remoteInstanceId, instanceSyncManager.localInstanceId],
      });
      if (rows.length === 0) return null;
      // Ensure our outbound feed to this peer exists before asking for the key.
      await instanceSyncManager.initInstance(remoteInstanceId, null);
      const key = instanceSyncManager.getOutFeedKey(remoteInstanceId);
      return key ? key.toString("hex") : null;
    } catch (err) {
      console.warn(`[sharing] getFeedKeyForInstance for ${remoteInstanceId}:`, err.message);
      return null;
    }
  };

  // Persist a peer-advertised feed key so we can open their incoming feed.
  // Called when the peer piggybacks (instance_id, feed_key_hex) on the
  // challenge-response JSON message (see peer-manager.js).
  peerManager.onInstanceKeyReceived = async (remoteInstanceId, feedKeyHex) => {
    try {
      const { rows } = await db.execute({
        sql: `SELECT sync_url FROM crow_instances WHERE id = ? AND ${TRUSTED_PEER_SQL} AND id != ?`,
        args: [remoteInstanceId, instanceSyncManager.localInstanceId],
      });
      if (rows.length === 0) return; // Not paired with this instance_id — drop
      const keyBuf = instanceSyncManager.validateIncomingFeedKey(remoteInstanceId, feedKeyHex);
      if (!keyBuf) return; // malformed or self-echoed — skip persist AND init
      if (rows[0].sync_url === feedKeyHex) return; // unchanged — skip
      await db.execute({
        sql: "UPDATE crow_instances SET sync_url = ?, updated_at = datetime('now') WHERE id = ? AND status != 'revoked'",
        args: [feedKeyHex, remoteInstanceId],
      });
      console.log(`[sharing] Stored feed key for instance ${remoteInstanceId.slice(0, 12)}…`);
      // Open the incoming feed now that we have the key. initInstance is
      // idempotent — re-calling with a non-null feedKey adds the inFeed
      // without disturbing the already-open outFeed.
      try {
        await instanceSyncManager.initInstance(remoteInstanceId, keyBuf);
      } catch (err) {
        console.warn(`[sharing] Failed to open inbound feed after key exchange: ${err.message}`);
      }
    } catch (err) {
      console.warn(`[sharing] onInstanceKeyReceived for ${remoteInstanceId}:`, err.message);
    }
  };
}

/*
 * Verbatim copy of servers/sharing/boot.js at PT3_SHA (d733b582), lines
 * 872-946: the three instance closures (with the localInstanceId and
 * wireContactBinding lines between them). Only the enclosing function and
 * its parameters are added. The closure bodies equal PRE_PT3_SHA's; only
 * comments and the wireContactBinding call differ.
 */
function wireBootClosuresPT3({ peerManager, db, instanceSyncManager, handleInstanceConnection, TRUSTED_PEER_SQL, wireContactBinding }) {
  // Wire instance-to-instance connections for Hypercore replication
  peerManager.onInstanceConnected = async (crowId, conn, remoteInstanceId = null) => {
    console.log(`[sharing] Instance peer connected: ${crowId}`);

    // One connection = one instance when the peer advertised its id
    // (servers/sharing/instance-connect.js, review I2).
    try {
      await handleInstanceConnection({ db, instanceSyncManager, crowId, conn, remoteInstanceId });
    } catch (err) {
      console.warn(`[sharing] Instance connection handling failed for ${crowId}:`, err.message);
    }
  };

  // Advertise our own local instance_id to peer-manager so it can include
  // the id on the challenge/challenge-response JSON (disambiguates peers
  // when all instances of one user share one crow_id).
  peerManager.localInstanceId = instanceSyncManager.localInstanceId;

  // PT-3: the Hyperswarm verifier admits a contact only on the key pinned in
  // its contact row, and records which contacts have bound (the pin, LOCAL
  // scope). The local id is read at call time, never captured.
  wireContactBinding(peerManager, { db, localInstanceId: () => instanceSyncManager.localInstanceId });

  // peer-manager asks us for OUR outgoing feed key to a specific peer
  // instance (remoteInstanceId is the peer's local id, which matches the
  // `id` column in our crow_instances table for that peer's row).
  peerManager.getFeedKeyForInstance = async (remoteInstanceId) => {
    try {
      // Only return a key if we actually have a paired row for this instance.
      const { rows } = await db.execute({
        sql: `SELECT id FROM crow_instances WHERE id = ? AND ${TRUSTED_PEER_SQL} AND id != ? LIMIT 1`,
        args: [remoteInstanceId, instanceSyncManager.localInstanceId],
      });
      if (rows.length === 0) return null;
      // Ensure our outbound feed to this peer exists before asking for the key.
      await instanceSyncManager.initInstance(remoteInstanceId, null);
      const key = instanceSyncManager.getOutFeedKey(remoteInstanceId);
      return key ? key.toString("hex") : null;
    } catch (err) {
      console.warn(`[sharing] getFeedKeyForInstance for ${remoteInstanceId}:`, err.message);
      return null;
    }
  };

  // Persist a peer-advertised feed key so we can open their incoming feed.
  // Called only after the sibling proved our key: from a new sibling's
  // `instance-key` frame, or an old sibling's challenge-response piggyback
  // (instance_id, feed_key_hex). See peer-manager.js.
  peerManager.onInstanceKeyReceived = async (remoteInstanceId, feedKeyHex) => {
    try {
      const { rows } = await db.execute({
        sql: `SELECT sync_url FROM crow_instances WHERE id = ? AND ${TRUSTED_PEER_SQL} AND id != ?`,
        args: [remoteInstanceId, instanceSyncManager.localInstanceId],
      });
      if (rows.length === 0) return; // Not paired with this instance_id — drop
      const keyBuf = instanceSyncManager.validateIncomingFeedKey(remoteInstanceId, feedKeyHex);
      if (!keyBuf) return; // malformed or self-echoed — skip persist AND init
      if (rows[0].sync_url === feedKeyHex) return; // unchanged — skip
      await db.execute({
        sql: "UPDATE crow_instances SET sync_url = ?, updated_at = datetime('now') WHERE id = ? AND status != 'revoked'",
        args: [feedKeyHex, remoteInstanceId],
      });
      console.log(`[sharing] Stored feed key for instance ${remoteInstanceId.slice(0, 12)}…`);
      // Open the incoming feed now that we have the key. initInstance is
      // idempotent — re-calling with a non-null feedKey adds the inFeed
      // without disturbing the already-open outFeed.
      try {
        await instanceSyncManager.initInstance(remoteInstanceId, keyBuf);
      } catch (err) {
        console.warn(`[sharing] Failed to open inbound feed after key exchange: ${err.message}`);
      }
    } catch (err) {
      console.warn(`[sharing] onInstanceKeyReceived for ${remoteInstanceId}:`, err.message);
    }
  };
}

// ---------------------------------------------------------------- sides
let seq = 0;
const newId = (n) => `inst-${n}-${randomBytes(3).toString("hex")}`;

/** One instance: real DB, real InstanceSyncManager (from `ISM`'s tree), its pair keys. */
async function makeSide(t, identity, id, { ISM = InstanceSyncManager } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pt2a-hs-"));
  const db = await makeRealDb(dir);
  const mgr = new ISM(identity, db, id);
  mgr.dataDir = join(dir, "instance-sync"); // keep feeds out of ~/.crow
  mgr.feedsDisabled = false;                // the suite env disables feeds
  const pairKeys = new Map();
  const side = { t, id, db, mgr, dir, identity, pairKeys, pairKeyLookup: (peerId) => pairKeys.get(peerId) ?? null };
  guardSideOpens(side);
  onTeardown(t, `rm ${dir}`, () => removeSideDir(side));
  onTeardown(t, `db ${id}`, () => { try { db.close?.(); } catch {} releaseDbFiles(dir); });
  onTeardown(t, `mgr ${id}`, () => closeSide(side));
  return side;
}

/**
 * Two paired siblings of one identity. `shape` picks the crow_id of each
 * side's row for the other: "crow" (the shared Crow ID, enroll-created rows)
 * or "instance" (the peer's own id, CLI-paired rows).
 */
async function makePair(t, { aISM, bISM, shape = "crow", identity = null } = {}) {
  identity ??= await makeSharedIdentity();
  const a = await makeSide(t, identity, newId("a"), { ISM: aISM });
  const b = await makeSide(t, identity, newId("b"), { ISM: bISM });
  await addPeerRow(a.db, b.id, { crowId: shape === "crow" ? SHARED_CROW_ID : b.id });
  await addPeerRow(b.db, a.id, { crowId: shape === "crow" ? SHARED_CROW_ID : a.id });
  const pairKey = randomBytes(32).toString("hex");
  a.pairKeys.set(b.id, pairKey);
  b.pairKeys.set(a.id, pairKey);
  return { identity, a, b, pairKey };
}

// ---------------------------------------------------------------- nodes
/** Spy the wired callbacks and replicate; every spy calls through. */
function spy(pm, side, kind) {
  const s = { instanceConnected: [], keyReceived: [], feedKeyAsked: [], replicate: [], kills: [] };
  // Who closed which stream, and why (diagnostics; U-H8 also asserts on it).
  if (typeof pm._kill === "function") {
    const kill = pm._kill.bind(pm);
    pm._kill = (conn, state) => { s.kills.push({ conn, via: state?._refuseWhy ? `refuse:${state._refuseWhy}` : "kill" }); return kill(conn, state); };
  }
  if (typeof pm._refuseInstance === "function") {
    const refuse = pm._refuseInstance.bind(pm);
    pm._refuseInstance = (conn, state, why) => { if (state) state._refuseWhy = why; return refuse(conn, state, why); };
  }
  onTeardown(side.t, `pm ${side.id}`, () => pm.destroy?.());
  const wrap = (name, list) => {
    const inner = pm[name];
    if (typeof inner !== "function") return;
    pm[name] = (...a) => { list.push(a.slice(0, 1).concat(name === "onInstanceConnected" ? [a[2]] : a.slice(1, 2))); return inner(...a); };
  };
  wrap("onInstanceConnected", s.instanceConnected);
  wrap("onInstanceKeyReceived", s.keyReceived);
  wrap("getFeedKeyForInstance", s.feedKeyAsked);
  // replicate is the side's (shared by every node built on it): count only
  // calls for streams this node handled.
  const mine = new WeakSet();
  const handle = pm._handleConnection.bind(pm);
  pm._handleConnection = (conn, info) => { mine.add(conn); return handle(conn, info); };
  const rep = side.mgr.replicate.bind(side.mgr);
  side.mgr.replicate = (id, stream, o) => { if (mine.has(stream)) s.replicate.push(id); return rep(id, stream, o); };
  return { pm, side, kind, spies: s };
}

/** A new node, wired as boot.js wires it (wireContactBinding + wireInstanceSync). */
function newNode(side, { mode = "auto", pairKeyLookup = side.pairKeyLookup, db = side.db, wire = true, pairBindingWaitMs } = {}) {
  const pm = new PeerManager(side.identity, { env: {} });
  pm.p2pDisabled = true; // links are loopback socket pairs
  pm.localInstanceId = side.id;
  wireContactBinding(pm, { db: side.db, localInstanceId: () => side.id });
  if (wire) IC.wireInstanceSync(pm, { db, instanceSyncManager: side.mgr, pairKeyLookup, mode, pairBindingWaitMs });
  return spy(pm, side, "new");
}

/** An old node, wired only from its own tree (N1). */
function oldNode(side, which) {
  const tr = trees[which];
  const pm = new tr.PeerManager(side.identity, { env: {} });
  pm.p2pDisabled = true;
  tr.wireClosures({
    peerManager: pm, db: side.db, instanceSyncManager: side.mgr,
    handleInstanceConnection: tr.handleInstanceConnection, TRUSTED_PEER_SQL: tr.TRUSTED_PEER_SQL,
    wireContactBinding: tr.wireContactBinding,
  });
  return spy(pm, side, which);
}

// ---------------------------------------------------------------- links
/** Record the JSON frames written on `conn` (binary replication frames pass through). */
function tapWrites(conn) {
  const frames = [];
  const orig = conn.write.bind(conn);
  conn.write = (data, ...rest) => {
    if (typeof data === "string") {
      for (const l of data.split("\n")) {
        if (!l.trim()) continue;
        try { const f = JSON.parse(l); if (f && typeof f.type === "string") frames.push(f); } catch {}
      }
    }
    return orig(data, ...rest);
  };
  return frames;
}

async function streams(t, xInitiator) {
  const [s1, s2] = await socketPair();
  const x = new NoiseSecretStream(xInitiator, s1);
  const y = new NoiseSecretStream(!xInitiator, s2);
  x.on("error", () => {}); y.on("error", () => {});
  onTeardown(t, "stream pair", () => { for (const s of [x, y, s1, s2]) { try { s.destroy(); } catch {} } });
  return [x, y];
}
const killsOn = (N, conn) => N.spies.kills.filter((k) => k.conn === conn).map((k) => k.via);

/** Link node X and node Y; X is the Noise initiator when `xInitiator`. */
async function link(t, X, Y, { xInitiator = true } = {}) {
  const [x, y] = await streams(t, xInitiator);
  const wx = tapWrites(x), wy = tapWrites(y);
  const st = { xClosed: false, yClosed: false };
  x.once("close", () => { st.xClosed = true; });
  y.once("close", () => { st.yClosed = true; });
  x.on("error", (e) => { st.xErr = e?.message ?? String(e); });
  y.on("error", (e) => { st.yErr = e?.message ?? String(e); });
  X.pm._handleConnection(x, {});
  Y.pm._handleConnection(y, {});
  /** Why the link is in the state it is (assertion messages). */
  const why = () => `x closed=${st.xClosed}${st.xErr ? ` (error: ${st.xErr})` : ""} by X:[${killsOn(X, x)}] Y:[${killsOn(Y, y)}]; y closed=${st.yClosed}${st.yErr ? ` (error: ${st.yErr})` : ""}; x sent [${wx.map((f) => f.type)}]; y sent [${wy.map((f) => f.type)}]; logs: ${pmLogs()}`;
  return { x, y, wx, wy, st, why };
}

/**
 * A raw peer holding the seed, facing node N. It answers N's challenge as
 * `responseId`. With `pb` it offers pair binding and, unless `pbFrame` is
 * false, sends a `pair-binding` frame (pb_mac from `pbKeyHex`, or
 * `pbMacOverride`, else null) right after its response.
 */
async function rawSibling(t, N, identity, {
  challengeId, responseId = undefined, pb = true, pbKeyHex = null, pbMacOverride = undefined, pbFrame = true, after = [], pmInitiator = true, proof = "cb",
} = {}) {
  const [p, r] = await streams(t, pmInitiator);
  const pmFrames = tapWrites(p);
  let closed = false;
  r.once("close", () => { closed = true; });
  const got = [];
  let buf = "";
  r.on("data", (d) => {
    buf += d.toString();
    const ls = buf.split("\n");
    buf = ls.pop();
    for (const l of ls) if (l.trim()) { try { got.push(JSON.parse(l)); } catch {} }
  });
  N.pm._handleConnection(p, {});
  const ask = { type: "challenge", challenge: randomBytes(32).toString("hex"), cb: 1, pubkey: identity.ed25519Pubkey, crowId: identity.crowId };
  if (pb) ask.pb = 1;
  if (challengeId !== undefined) ask.instance_id = challengeId;
  r.write(JSON.stringify(ask) + "\n");
  assert.ok(await until(() => got.some((f) => f.type === "challenge"), W(3000), 5), "the node sent its challenge");
  const theirs = got.find((f) => f.type === "challenge");
  await r.opened;
  const hh = Buffer.from(r.handshakeHash).toString("hex");
  const resp = { type: "challenge-response", crowId: identity.crowId, pubkey: identity.ed25519Pubkey };
  if (responseId !== undefined) resp.instance_id = responseId;
  if (proof === "sig") resp.signature = sign(theirs.challenge, identity.ed25519Priv);
  else resp.cb_sig = sign(contactCbMessage({ role: r.isInitiator ? "init" : "resp", signerCrowId: identity.crowId, challengeHex: theirs.challenge, handshakeHashHex: hh }), identity.ed25519Priv);
  const out = [resp];
  if (pb && pbFrame) {
    let pbMac = null;
    if (pbKeyHex) {
      pbMac = hyperswarmMac(pairSubkey(pbKeyHex), {
        responder: challengeId ?? responseId, challenger: theirs.instance_id, challenge: theirs.challenge, handshakeHash: hh,
      });
    }
    if (pbMacOverride !== undefined) pbMac = pbMacOverride;
    out.push({ type: "pair-binding", pb_mac: pbMac });
  }
  r.write([...out, { type: "authenticated" }, ...after].map((o) => JSON.stringify(o) + "\n").join(""));
  return { pmFrames, got, ask, theirs, conn: r, get closed() { return closed; } };
}

// ---------------------------------------------------------------- observations
async function pairPin(side, peerId) {
  const { rows } = await side.db.execute({
    sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?",
    args: [`sync_pair_bound:${peerId}`, side.id],
  });
  return rows[0]?.value ?? null;
}
const framesOf = (w, type) => w.filter((f) => f.type === type);
/** How a node's frames carried its feed key: "instance-key", "piggyback", or null. */
function feedKeyVia(w) {
  if (framesOf(w, "instance-key").some((f) => typeof f.feed_key_hex === "string")) return "instance-key";
  if (framesOf(w, "challenge-response").some((f) => typeof f.feed_key_hex === "string")) return "piggyback";
  return null;
}
const outKeyHex = (side, peerId) => side.mgr.getOutFeedKey(peerId)?.toString("hex") ?? null;

let marker = 9000;
/** Markers both ways over the live link (or, with `expect: false`, none). */
async function markers(x, y, { expect = true, label = "", link: L = null } = {}) {
  const m1 = ++marker, m2 = ++marker;
  await writeAndEmit(x, m1, `${label} x→y`);
  await writeAndEmit(y, m2, `${label} y→x`);
  if (expect) {
    // Per feed: peer, key prefix, length, replicating peers; per side: live
    // streams per peer. peers=0 with a live stream, or a link closed with
    // "Invalid open message", means one side's replication muxer was attached
    // after the peer's first replication frames had gone by (replicate()
    // runs only after async admission work): that link never replicates.
    const one = (dir, k, f) => `${dir} ${k.slice(0, 10)} key=${f.key?.toString("hex").slice(0, 8)} len=${f.length} peers=${f.peers?.length ?? "?"}`;
    const feeds = (s) => [...(s.mgr.outFeeds?.entries?.() ?? [])].map(([k, f]) => one("out", k, f))
      .concat([...(s.mgr.inFeeds?.entries?.() ?? [])].map(([k, f]) => one("in", k, f)))
      .concat([...(s.mgr._activeStreams?.entries?.() ?? [])].map(([k, set]) => `streams ${k.slice(0, 10)}=${set.size}`)).join(", ");
    const diag = () => `x feeds [${feeds(x)}], y feeds [${feeds(y)}]; ${L ? `link: ${L.why()}` : `logs: ${pmLogs()}`}`;
    assert.ok(await until(() => hasMemory(y.db, m1), W(10_000)), `${label}: marker x→y (${diag()})`);
    assert.ok(await until(() => hasMemory(x.db, m2), W(10_000)), `${label}: marker y→x (${diag()})`);
    return { xy: true, yx: true };
  }
  await sleep(1000);
  const r = { xy: await hasMemory(y.db, m1), yx: await hasMemory(x.db, m2) };
  assert.deepEqual(r, { xy: false, yx: false }, `${label}: no marker either way`);
  return r;
}

// U-H9: every refusal registers the refusing node; the last test re-checks them.
const refusalRegistry = [];
function assertInert(N, label, { frames = null } = {}) {
  const s = N.spies;
  assert.deepEqual(s.instanceConnected, [], `${label}: onInstanceConnected not called`);
  assert.deepEqual(s.keyReceived, [], `${label}: onInstanceKeyReceived not called`);
  assert.deepEqual(s.feedKeyAsked, [], `${label}: getFeedKeyForInstance not called`);
  assert.deepEqual(s.replicate, [], `${label}: replicate not called`);
  if (frames) {
    assert.deepEqual(framesOf(frames, "instance-key"), [], `${label}: no instance-key sent`);
    assert.deepEqual(framesOf(frames, "authenticated"), [], `${label}: no authenticated sent`);
  }
  refusalRegistry.push({ label, N, frames });
}

const legs = [];
function recordLeg(row) {
  legs.push(row);
  if (process.env.PT2A_LEGS_OUT) writeFileSync(process.env.PT2A_LEGS_OUT, JSON.stringify(legs, null, 1));
}

// ================================================================ U-H1
test("U-H1 new↔new: both offer pb, both send a pair-binding frame with pb_mac (none in the cb reply), both pin, feed keys only in instance-key, markers flow (both role orders, both crow_id row shapes)", T, async (t) => {
  for (const shape of ["crow", "instance"]) {
    for (const aInit of [true, false]) {
      const label = `${shape}/${aInit ? "A-init" : "B-init"}`;
      _resetPeerTrustHealth();
      logs.length = 0;
      const { a, b } = await makePair(t, { shape });
      const A = newNode(a), B = newNode(b);
      const L = await link(t, A, B, { xInitiator: aInit });
      assert.ok(await until(() => A.spies.instanceConnected.length === 1 && B.spies.instanceConnected.length === 1, W(8000)), `${label}: admitted both ways`);
      for (const [w, who] of [[L.wx, "A"], [L.wy, "B"]]) {
        assert.equal(framesOf(w, "challenge")[0]?.pb, 1, `${label}: ${who} offers pb`);
        const resp = framesOf(w, "challenge-response");
        assert.equal(resp.length, 1);
        assert.equal(typeof resp[0].cb_sig, "string", `${label}: ${who} replies with cb_sig`);
        assert.equal("pb_mac" in resp[0], false, `${label}: ${who}'s cb reply carries no MAC`);
        const pbf = framesOf(w, "pair-binding");
        assert.equal(pbf.length, 1, `${label}: ${who} sends one pair-binding frame`);
        assert.match(pbf[0].pb_mac ?? "", /^[0-9a-f]{64}$/, `${label}: ${who}'s pair-binding frame carries pb_mac`);
        assert.equal("feed_key_hex" in resp[0], false, `${label}: ${who}'s reply carries no feed key`);
        assert.equal("signature" in resp[0], false);
      }
      assert.deepEqual(A.spies.instanceConnected, [[SHARED_CROW_ID, b.id]]);
      assert.deepEqual(B.spies.instanceConnected, [[SHARED_CROW_ID, a.id]]);
      assert.ok(await until(async () => (await pairPin(a, b.id)) === "1" && (await pairPin(b, a.id)) === "1", W(3000)), `${label}: both pinned`);
      assert.ok(await until(() => A.spies.keyReceived.length === 1 && B.spies.keyReceived.length === 1, W(5000)), `${label}: feed keys both ways`);
      assert.equal(feedKeyVia(L.wx), "instance-key");
      assert.equal(feedKeyVia(L.wy), "instance-key");
      assert.deepEqual(A.spies.keyReceived, [[b.id, outKeyHex(b, a.id)]]);
      assert.deepEqual(B.spies.keyReceived, [[a.id, outKeyHex(a, b.id)]]);
      assert.ok(logs.some((l) => l.includes("pair-bound") && l.includes(b.id)), `${label}: A logs pair-bound`);
      const h = getPeerTrustHealth();
      assert.equal(h.unboundPeers[a.id], undefined);
      assert.equal(h.unboundPeers[b.id], undefined);
      // The binding does not depend on the row shape; replication does
      // (handleInstanceConnection filters crow_id = the claimed Crow ID).
      if (shape === "crow") await markers(a, b, { label, link: L });
    }
  }
});

// ================================================================ U-H2
test("U-H2 a seed holder without B's pair key, claiming B: refused guard:pb_required_pinned once A pinned B, guard:pb_required in require, guard:pb_invalid with a wrong key; positive control: the same raw node with B's real key is admitted and bound", T, async (t) => {
  const { identity, a, b, pairKey } = await makePair(t);
  {
    _resetPeerTrustHealth();
    const A = newNode(a);
    const R = await rawSibling(t, A, identity, { challengeId: b.id, responseId: b.id, pbKeyHex: pairKey });
    assert.ok(await until(() => A.spies.instanceConnected.length === 1, W(5000)), "control: B's real key is admitted");
    assert.equal(R.closed, false);
    assert.equal(await pairPin(a, b.id), "1", "control: A pinned B");
    // A answered the raw node's pb:1 offer, after its proof, with a MAC under the pair key.
    const reply = framesOf(R.pmFrames, "pair-binding")[0];
    assert.equal("pb_mac" in framesOf(R.pmFrames, "challenge-response")[0], false);
    assert.equal(reply.pb_mac, hyperswarmMac(pairSubkey(pairKey), { responder: a.id, challenger: b.id, challenge: R.ask.challenge, handshakeHash: Buffer.from(R.conn.handshakeHash).toString("hex") }));
  }
  {
    logs.length = 0;
    const A = newNode(a);
    const R = await rawSibling(t, A, identity, { challengeId: b.id, responseId: b.id });
    assert.ok(await until(() => R.closed, W(5000)), "pinned: destroyed");
    await sleep(100);
    assert.ok(refusedFor("guard:pb_required_pinned"), "pinned: guard:pb_required_pinned");
    assertInert(A, "U-H2 pinned", { frames: R.pmFrames });
    assert.equal(getPeerTrustHealth().pairBindingRefusals[b.id]?.reason, "pb_required_pinned");
  }
  {
    logs.length = 0;
    const A = newNode(a);
    const R = await rawSibling(t, A, identity, { challengeId: b.id, responseId: b.id, pbKeyHex: randomBytes(32).toString("hex") });
    assert.ok(await until(() => R.closed, W(5000)), "wrong key: destroyed");
    await sleep(100);
    assert.ok(refusedFor("guard:pb_invalid"), "wrong key: guard:pb_invalid");
    assertInert(A, "U-H2 wrong key", { frames: R.pmFrames });
  }
  {
    // require, unpinned (a fresh pair): the same raw node without a key.
    const p2 = await makePair(t);
    logs.length = 0;
    const A = newNode(p2.a, { mode: "require" });
    const R = await rawSibling(t, A, p2.identity, { challengeId: p2.b.id, responseId: p2.b.id });
    assert.ok(await until(() => R.closed, W(5000)), "require: destroyed");
    await sleep(100);
    assert.ok(refusedFor("guard:pb_required"), "require: guard:pb_required");
    assertInert(A, "U-H2 require", { frames: R.pmFrames });
    // Control, same harness: the real key is admitted in require.
    const A2 = newNode(p2.a, { mode: "require" });
    await rawSibling(t, A2, p2.identity, { challengeId: p2.b.id, responseId: p2.b.id, pbKeyHex: p2.pairKey });
    assert.ok(await until(() => A2.spies.instanceConnected.length === 1, W(5000)), "require control: the real key is admitted");
  }
});

// ================================================================ U-H3
/**
 * One mixed-version leg. `which`: "pt3" | "pre". `newInit`: the new node is
 * the Noise initiator. `setup`: "auto" | "pinned" (the new side has the pair
 * pin) | "cbPinned" (the new side has PT-3's instance_hs_cb: pin) | "require".
 * `expect`: "admit" or the new side's refusal reason.
 */
async function mixedLeg(t, { which, newInit, setup, expect }) {
  const label = `U-H3 ${which} ${newInit ? "new-init" : "old-init"} ${setup}`;
  _resetPeerTrustHealth();
  logs.length = 0;
  const { a: n, b: o } = await makePair(t, { bISM: trees[which].InstanceSyncManager });
  const N = newNode(n, { mode: setup === "require" ? "require" : "auto" });
  const O = oldNode(o, which);

  // Fidelity control: the old node really is the old code.
  if (which === "pt3") {
    assert.equal(O.pm.admitGuards?.instance, null, `${label}: PT-3 has an empty instance guard slot`);
  } else {
    assert.equal(O.pm.admitGuards, undefined, `${label}: pre-PT-3 has no admitGuards`);
  }
  assert.equal(O.pm.instanceBinding, undefined, `${label}: the old node has no instanceBinding`);
  assert.equal(typeof N.pm.admitGuards.instance, "function", `${label}: the new node is wired`);

  if (setup === "pinned") await markPairPinned(n.db, n.id, o.id);
  if (setup === "cbPinned") await markInstanceCbPinned(n.db, n.id, n.identity.crowId);

  const L = await link(t, N, O, { xInitiator: newInit });
  const row = { leg: label, which, order: newInit ? "new=initiator" : "old=initiator", setup };
  if (expect === "admit") {
    assert.ok(await until(() => N.spies.instanceConnected.length === 1 && O.spies.instanceConnected.length === 1, W(8000)), `${label}: admitted both ways`);
    assert.ok(await until(() => N.spies.keyReceived.length === 1 && O.spies.keyReceived.length === 1, W(5000)), `${label}: feed keys both ways`);
    const viaNew = feedKeyVia(L.wx), viaOld = feedKeyVia(L.wy);
    assert.equal(viaNew, which === "pt3" ? "instance-key" : "piggyback", `${label}: new→old feed key`);
    assert.equal(viaOld, which === "pt3" ? "instance-key" : "piggyback", `${label}: old→new feed key`);
    assert.deepEqual(N.spies.keyReceived, [[o.id, outKeyHex(o, n.id)]]);
    assert.deepEqual(O.spies.keyReceived, [[n.id, outKeyHex(n, o.id)]]);
    assert.equal(framesOf(L.wx, "challenge-response")[0]?.pb_mac, undefined, `${label}: no pb_mac in the cb reply`);
    assert.deepEqual(framesOf(L.wx, "pair-binding"), [], `${label}: the old node asked without pb, so no pair-binding frame`);
    const m = await markers(n, o, { label, link: L });
    assert.match(getPeerTrustHealth().unboundPeers[o.id]?.message || "", /without pair binding/, `${label}: the new side raises "without pair binding"`);
    assert.equal(await pairPin(n, o.id), null, `${label}: no pair pin for a legacy peer`);
    Object.assign(row, { newSide: "admitted (legacy)", oldSide: "admitted", keyNewToOld: viaNew, keyOldToNew: viaOld, markerNewToOld: m.xy, markerOldToNew: m.yx });
  } else {
    assert.ok(await until(() => L.st.xClosed, W(8000)), `${label}: the new side destroys the connection`);
    await sleep(300);
    assert.ok(refusedFor(expect), `${label}: refused ${expect} (${logs.filter((l) => l.includes("refused")).join(" | ")})`);
    assertInert(N, label, { frames: L.wx });
    assert.deepEqual(O.spies.instanceConnected, [], `${label}: the old side never reaches onInstanceConnected`);
    assert.deepEqual(O.spies.keyReceived, [], `${label}: no feed key reaches the old side`);
    assert.equal(feedKeyVia(L.wx), null, `${label}: the new side sends no feed key`);
    const oldSentKey = feedKeyVia(L.wy);
    const m = await markers(n, o, { expect: false, label });
    Object.assign(row, {
      newSide: `refused ${expect}`,
      oldSide: framesOf(L.wy, "authenticated").length ? "sent authenticated, never mutual" : "never admitted",
      keyNewToOld: "none",
      keyOldToNew: oldSentKey ? `${oldSentKey} written by old, not applied` : "none",
      markerNewToOld: m.xy, markerOldToNew: m.yx,
    });
  }
  recordLeg(row);
}

for (const newInit of [true, false]) {
  test(`U-H3 PT-3 ↔ new (${newInit ? "new" : "old"} is the Noise initiator): auto unpinned → admitted both ways with instance-key both ways and markers; new side pinned → refused; new side require → refused`, T, async (t) => {
    await mixedLeg(t, { which: "pt3", newInit, setup: "auto", expect: "admit" });
    await mixedLeg(t, { which: "pt3", newInit, setup: "pinned", expect: "guard:pb_required_pinned" });
    await mixedLeg(t, { which: "pt3", newInit, setup: "require", expect: "guard:pb_required" });
  });
  test(`U-H3 pre-PT-3 ↔ new (${newInit ? "new" : "old"} is the Noise initiator): admitted while instance_hs_cb: is unset (deferred piggyback both ways, markers); pin set → refused (PT-3 behaviour, m7); require → refused`, T, async (t) => {
    await mixedLeg(t, { which: "pre", newInit, setup: "auto", expect: "admit" });
    await mixedLeg(t, { which: "pre", newInit, setup: "cbPinned", expect: "cb_required_pinned" });
    await mixedLeg(t, { which: "pre", newInit, setup: "require", expect: "guard:pb_required" });
  });
}

// ================================================================ U-H4
test("U-H4 relay (regression, closed by PT-3's cb_sig): a non-seed relay between two new siblings is refused on both sides; the two handshake hashes differ", T, async (t) => {
  {
    // Positive control: the same two nodes directly.
    const { a, b } = await makePair(t);
    const A = newNode(a), B = newNode(b);
    await link(t, A, B);
    assert.ok(await until(() => A.spies.instanceConnected.length === 1 && B.spies.instanceConnected.length === 1, W(8000)), "control: direct link admitted");
  }
  logs.length = 0;
  const { a, b } = await makePair(t);
  const A = newNode(a), B = newNode(b);
  const [a1, m1] = await socketPair();
  const [m2, b1] = await socketPair();
  const sa = new NoiseSecretStream(true, a1), ma = new NoiseSecretStream(false, m1);
  const mb = new NoiseSecretStream(true, m2), sb = new NoiseSecretStream(false, b1);
  for (const s of [sa, ma, mb, sb]) s.on("error", () => {});
  onTeardown(t, "relay streams", () => { for (const s of [sa, ma, mb, sb, a1, m1, m2, b1]) { try { s.destroy(); } catch {} } });
  ma.on("data", (d) => { try { mb.write(d); } catch {} });
  mb.on("data", (d) => { try { ma.write(d); } catch {} });
  let aClosed = false, bClosed = false;
  sa.once("close", () => { aClosed = true; });
  sb.once("close", () => { bClosed = true; });
  const wa = tapWrites(sa), wb = tapWrites(sb);
  A.pm._handleConnection(sa, {});
  B.pm._handleConnection(sb, {});
  await Promise.all([sa.opened, sb.opened]);
  assert.notEqual(Buffer.from(sa.handshakeHash).toString("hex"), Buffer.from(sb.handshakeHash).toString("hex"), "the two legs have different handshake hashes");
  assert.ok(await until(() => aClosed && bClosed, W(8000)), "both sides destroy the relayed connection");
  await sleep(200);
  assert.ok(refusedFor("key") || logs.some((l) => l.includes("did not prove our key")), "refused: the cb_sig does not verify on the other leg");
  assertInert(A, "U-H4 A", { frames: wa });
  assertInert(B, "U-H4 B", { frames: wb });
  assert.equal(await pairPin(a, b.id), null);
  assert.equal(await pairPin(b, a.id), null);
});

// ================================================================ U-H5
test("U-H5 the guard runs inside the frame chain: an instance-key sent right after the response, while the pin lookup takes 500 ms, is applied only after ok and never after a refusal", T, async (t) => {
  const { identity, a, b } = await makePair(t);
  const FEED = randomBytes(32).toString("hex");
  /** A's DB, with every pair-pin read delayed 500 ms. */
  const slowDb = {
    execute: async (q) => {
      const sql = typeof q === "string" ? q : q.sql;
      if (/^\s*SELECT/i.test(sql) && String(q?.args?.[0] ?? "").startsWith("sync_pair_bound:")) await sleep(500);
      return a.db.execute(q);
    },
  };
  const timed = (N) => {
    const guard = N.pm.admitGuards.instance;
    const ev = [];
    N.pm.admitGuards.instance = async (ctx) => { const v = await guard(ctx); ev.push(["guard", Date.now(), v.ok]); return v; };
    const recv = N.pm.onInstanceKeyReceived;
    N.pm.onInstanceKeyReceived = (...x) => { ev.push(["key", Date.now()]); return recv(...x); };
    return ev;
  };
  {
    const A = newNode(a, { db: slowDb });
    const ev = timed(A);
    const t0 = Date.now();
    await rawSibling(t, A, identity, { challengeId: b.id, responseId: b.id, after: [{ type: "instance-key", instance_id: b.id, feed_key_hex: FEED }] });
    assert.ok(await until(() => ev.some((e) => e[0] === "key"), W(5000)), "ok: the key is applied");
    const g = ev.find((e) => e[0] === "guard"), k = ev.find((e) => e[0] === "key");
    assert.equal(g[2], true, "ok: legacy in auto");
    assert.ok(g[1] - t0 >= 450, "the pin lookup was delayed");
    assert.ok(k[1] >= g[1], "the key is applied only after the guard's ok");
    assert.deepEqual(A.spies.keyReceived, [[b.id, FEED]]);
  }
  {
    await markPairPinned(a.db, a.id, b.id);
    logs.length = 0;
    const A = newNode(a, { db: slowDb });
    const ev = timed(A);
    const R = await rawSibling(t, A, identity, { challengeId: b.id, responseId: b.id, after: [{ type: "instance-key", instance_id: b.id, feed_key_hex: FEED }] });
    assert.ok(await until(() => R.closed, W(5000)), "pinned: destroyed");
    await sleep(700);
    assert.deepEqual(ev.map((e) => e[0]), ["guard"], "pinned: the guard refused and no key was applied");
    assert.ok(refusedFor("guard:pb_required_pinned"));
    assertInert(A, "U-H5 pinned", { frames: R.pmFrames });
  }
});

// ================================================================ U-H6
test("U-H6 a sibling without an instance id (auto): replicates and refreshes only UNPINNED rows; refused in require", T, async (t) => {
  const identity = await makeSharedIdentity();
  const a = await makeSide(t, identity, newId("a"));
  const bId = newId("b"), cId = newId("c");
  await addPeerRow(a.db, bId);
  await addPeerRow(a.db, cId);
  const seen = async (id) => (await a.db.execute({ sql: "SELECT last_seen_at FROM crow_instances WHERE id = ?", args: [id] })).rows[0].last_seen_at;
  {
    // Control: nothing pinned → both rows ride the connection.
    const A = newNode(a);
    await rawSibling(t, A, identity, {});
    assert.ok(await until(() => A.spies.replicate.length === 2, W(5000)), "control: both rows replicate");
    assert.deepEqual([...A.spies.replicate].sort(), [bId, cId].sort());
    assert.deepEqual(A.spies.instanceConnected, [[SHARED_CROW_ID, null]]);
  }
  await a.db.execute({ sql: "UPDATE crow_instances SET last_seen_at = '2000-01-01 00:00:00'" });
  await markPairPinned(a.db, a.id, bId);
  {
    const A = newNode(a);
    await rawSibling(t, A, identity, {});
    assert.ok(await until(() => A.spies.replicate.length === 1, W(5000)), "pinned: one row replicates");
    await sleep(300);
    assert.deepEqual(A.spies.replicate, [cId], "only the unpinned row");
    assert.notEqual(await seen(cId), "2000-01-01 00:00:00", "the unpinned row is marked seen");
    assert.equal(await seen(bId), "2000-01-01 00:00:00", "the pinned row is NOT marked seen");
  }
  {
    logs.length = 0;
    const A = newNode(a, { mode: "require" });
    const R = await rawSibling(t, A, identity, {});
    assert.ok(await until(() => R.closed, W(5000)), "require: destroyed");
    await sleep(100);
    assert.ok(refusedFor("guard:pb_required"));
    assertInert(A, "U-H6 require", { frames: R.pmFrames });
  }
});

// ================================================================ U-H7c/d (real guard)
test("U-H7c (real guard) \"constructor\" never indexes the key store: unbound → legacy in auto (no Nest record: no row), refused in require; a trusted row that is unbound IS recorded; the production lookup over a 0600 store sends a pair-binding MAC and binds", T, async (t) => {
  const { identity, a, b, pairKey } = await makePair(t);
  const dir = mkdtempSync(join(tmpdir(), "pt2a-hs-store-"));
  onTeardown(t, `rm ${dir}`, () => removeDir(dir));
  const store = join(dir, "peer-tokens.json");
  writeFileSync(store, JSON.stringify({ "inst-real": { signing_key: randomBytes(32).toString("hex") }, [b.id]: { signing_key: pairKey } }), { mode: 0o600 });
  chmodSync(store, 0o600);
  const prev = process.env.CROW_PEER_TOKENS_PATH;
  process.env.CROW_PEER_TOKENS_PATH = store;
  t.after(() => { if (prev === undefined) delete process.env.CROW_PEER_TOKENS_PATH; else process.env.CROW_PEER_TOKENS_PATH = prev; });
  assert.equal(typeof defaultPairKey("inst-real"), "string", "control: the production lookup reads this store");
  assert.equal(defaultPairKey("constructor"), null);
  {
    _resetPeerTrustHealth();
    const A = newNode(a, { pairKeyLookup: defaultPairKey });
    const R = await rawSibling(t, A, identity, { challengeId: "constructor" });
    assert.ok(await until(() => A.spies.instanceConnected.length === 1, W(5000)), "auto: admitted as legacy");
    assert.deepEqual(A.spies.instanceConnected, [[SHARED_CROW_ID, "constructor"]]);
    assert.equal(framesOf(R.pmFrames, "challenge-response")[0]?.pb_mac, undefined);
    assert.equal(framesOf(R.pmFrames, "pair-binding")[0]?.pb_mac, null, "no MAC for an id the store does not own");
    const h = getPeerTrustHealth();
    assert.equal(h.unboundPeers.constructor, undefined, "no Nest record for an id with no crow_instances row");
    assert.deepEqual(Object.keys(h.unboundPeers), []);
    assert.equal(await pairPin(a, "constructor"), null);
  }
  {
    logs.length = 0;
    _resetPeerTrustHealth();
    const A = newNode(a, { pairKeyLookup: defaultPairKey, mode: "require" });
    const R = await rawSibling(t, A, identity, { challengeId: "constructor" });
    assert.ok(await until(() => R.closed, W(5000)), "require: destroyed");
    await sleep(100);
    assert.ok(refusedFor("guard:pb_required"));
    assert.deepEqual(Object.keys(getPeerTrustHealth().pairBindingRefusals), [], "no Nest record for an id with no row");
    assertInert(A, "U-H7c require", { frames: R.pmFrames });
  }
  {
    // A trusted row (B) that syncs unbound in auto IS recorded.
    _resetPeerTrustHealth();
    const A = newNode(a, { pairKeyLookup: defaultPairKey });
    await rawSibling(t, A, identity, { challengeId: b.id, responseId: b.id });
    assert.ok(await until(() => A.spies.instanceConnected.length === 1, W(5000)), "unbound B: admitted as legacy");
    assert.match(getPeerTrustHealth().unboundPeers[b.id]?.message || "", /without pair binding/, "a trusted row gets the record");
    assert.equal(await pairPin(a, b.id), null);
  }
  {
    // The production lookup over a 0600 store holding B's key: A's
    // pair-binding frame carries the MAC, and B's MAC binds and pins.
    const A = newNode(a, { pairKeyLookup: defaultPairKey });
    const R = await rawSibling(t, A, identity, { challengeId: b.id, responseId: b.id, pbKeyHex: pairKey });
    assert.ok(await until(() => A.spies.instanceConnected.length === 1, W(5000)), "bound B: admitted");
    const hh = Buffer.from(R.conn.handshakeHash).toString("hex");
    assert.equal(framesOf(R.pmFrames, "pair-binding")[0]?.pb_mac,
      hyperswarmMac(pairSubkey(pairKey), { responder: a.id, challenger: b.id, challenge: R.ask.challenge, handshakeHash: hh }));
    assert.equal(await pairPin(a, b.id), "1", "bound through the production lookup: pinned");
    assert.equal(getPeerTrustHealth().unboundPeers[b.id], undefined, "the bound handshake clears the record");
  }
});

test("U-H7d (real guard) self-loopback is killed before the guard: no Nest record", T, async (t) => {
  const { identity, a, b } = await makePair(t);
  {
    // Control: a sibling with a trusted row, unbound in require, IS recorded.
    _resetPeerTrustHealth();
    const A = newNode(a, { mode: "require" });
    const R = await rawSibling(t, A, identity, { challengeId: b.id });
    assert.ok(await until(() => R.closed, W(5000)));
    assert.equal(getPeerTrustHealth().pairBindingRefusals[b.id]?.reason, "pb_required", "control: the recorder is live");
  }
  for (const mode of ["auto", "require"]) {
    for (const where of ["challenge", "response"]) {
      _resetPeerTrustHealth();
      const A = newNode(a, { mode });
      const R = await rawSibling(t, A, identity, where === "challenge" ? { challengeId: a.id } : { responseId: a.id });
      assert.ok(await until(() => R.closed, W(5000)), `${mode}/${where}: destroyed`);
      await sleep(150);
      const h = getPeerTrustHealth();
      assert.deepEqual(Object.keys(h.unboundPeers), [], `${mode}/${where}: no unbound record`);
      assert.deepEqual(Object.keys(h.pairBindingRefusals), [], `${mode}/${where}: no refusal record`);
      assertInert(A, `U-H7d ${mode}/${where}`, { frames: R.pmFrames });
    }
  }
});

// ================================================================ U-H8
test("U-H8 unwired (I3): instance sync on and no guard refuses a genuine sibling with guard:unwired (logged once); positive control: the same pair through wireInstanceSync is admitted", T, async (t) => {
  const { a, b } = await makePair(t);
  logs.length = 0;
  const A = newNode(a, { wire: false });
  // The callbacks a test might set by hand: they must stay untouched.
  const calls = [];
  A.pm.onInstanceConnected = (...x) => calls.push(["connected", ...x]);
  A.pm.onInstanceKeyReceived = (...x) => calls.push(["key", ...x]);
  A.pm.getFeedKeyForInstance = async (...x) => { calls.push(["feed", ...x]); return "ab".repeat(32); };
  for (let i = 0; i < 2; i++) {
    const B = newNode(b);
    const L = await link(t, A, B);
    const n = `unwired #${i + 1}`;
    // Causal: A itself closed x, through the unwired fail-closed path (a bare
    // kill, no _refuseInstance reason). Anything else closing x first (B, a
    // cap, the pre-auth timer) shows up in L.why().
    assert.ok(await until(() => L.st.xClosed, W(5000)), `${n}: destroyed (${L.why()})`);
    assert.deepEqual(killsOn(A, L.x), ["kill"], `${n}: A closed it on the unwired path (${L.why()})`);
    await sleep(100); // late fires would land by now
    assert.deepEqual(calls, [], `${n}: no callback ran (${L.why()})`);
    assert.deepEqual(framesOf(L.wx, "instance-key"), [], `${n}: no instance-key (${L.why()})`);
    assert.deepEqual(framesOf(L.wx, "authenticated"), [], `${n}: no authenticated (${L.why()})`);
    assert.deepEqual(B.spies.instanceConnected, [], `${n}: B never connected (${L.why()})`);
  }
  assert.equal(logs.filter((l) => l.includes("guard:unwired")).length, 1, `logged once (logs: ${pmLogs()})`);
  refusalRegistry.push({ label: "U-H8 unwired", N: { spies: { instanceConnected: calls.filter((c) => c[0] === "connected"), keyReceived: calls.filter((c) => c[0] === "key"), feedKeyAsked: calls.filter((c) => c[0] === "feed"), replicate: A.spies.replicate } } });

  const A2 = newNode(a), B2 = newNode(b);
  const L2 = await link(t, A2, B2);
  assert.ok(await until(() => A2.spies.instanceConnected.length === 1 && B2.spies.instanceConnected.length === 1, W(8000)), `control: wired → admitted (${L2.why()})`);
});

// ================================================================ U-X1
test("U-X1 one pin, both transports: a peer pinned by a bound TAILNET handshake is refused unbound on Hyperswarm (guard:pb_required_pinned); positive control: the same peer with the real key is admitted on Hyperswarm", T, async (t) => {
  _setAllowLoopbackAddressesForTest(true);
  t.after(() => _setAllowLoopbackAddressesForTest(false));
  const fleet = await makeFleet();
  const { a, b, identity } = fleet;
  a.identity = identity; b.identity = identity;
  a.t = t; b.t = t;
  for (const side of [a, b]) guardSideOpens(side);
  // LIFO: managers close (after the opens in flight), then DBs and keepers, then the fixture removes the dirs.
  onTeardown(t, "fleet dirs", () => (a.quiet && b.quiet ? fleet.cleanup() : realConsole.error("[teardown] fleet dirs left in place, feed opens still in flight")));
  onTeardown(t, "fleet dbs", () => { for (const side of [a, b]) { try { side.db.close?.(); } catch {} releaseDbFiles(side.dir); } });
  onTeardown(t, "fleet mgrs", () => Promise.all([closeSide(a), closeSide(b)]));
  const quiet = { warn: () => {}, log: () => {} };
  const GA = await startGateway(fleet, a, { log: quiet });
  onTeardown(t, "gateway A", () => GA.close());
  const GB = await startGateway(fleet, b, { log: quiet });
  onTeardown(t, "gateway B", () => GB.close());
  try {
    assert.equal(await pairPin(a, b.id), null, "no pin before the tailnet handshake");
    await a.db.execute({ sql: "UPDATE crow_instances SET gateway_url = ? WHERE id = ?", args: [`http://127.0.0.1:${GB.port}`, b.id] });
    await GA.startClients();
    assert.ok(await until(() => a.mgr.hasDedicatedStream(b.id) && b.mgr.hasDedicatedStream(a.id), W(10_000)), "the tailnet link forms");
    assert.ok(await until(async () => (await pairPin(a, b.id)) === "1", W(3000)), "the bound tailnet handshake pinned B on A");
    GA.stopClients();
    assert.ok(await until(() => !a.mgr.hasDedicatedStream(b.id) && !b.mgr.hasDedicatedStream(a.id), W(5000)), "the tailnet link is torn down");
  } finally {
    await GA.close();
    await GB.close();
  }

  logs.length = 0;
  _resetPeerTrustHealth();
  const A = newNode(a);
  const R = await rawSibling(t, A, identity, { challengeId: b.id, responseId: b.id });
  assert.ok(await until(() => R.closed, W(5000)), "unbound on Hyperswarm: destroyed");
  await sleep(100);
  assert.ok(refusedFor("guard:pb_required_pinned"), "refused guard:pb_required_pinned");
  assertInert(A, "U-X1 unbound", { frames: R.pmFrames });

  const A2 = newNode(a), B2 = newNode(b);
  await link(t, A2, B2);
  assert.ok(await until(() => A2.spies.instanceConnected.length === 1 && B2.spies.instanceConnected.length === 1, W(8000)), "control: the real key is admitted on Hyperswarm");
  assert.equal(await pairPin(b, a.id), "1");
});

// ================================================================ U-H10
test("U-H10 stranger probes (no seed, our public Crow ID, pb:1, cb:1): a paired id and an unpaired id get replies of the same shape and no pair-binding frame", T, async (t) => {
  const { identity, a, b } = await makePair(t);
  const stranger = deriveInstanceIdentity(randomBytes(32));
  const probe = async (claimId) => {
    const A = newNode(a);
    const [p, r] = await streams(t, true);
    const pmFrames = tapWrites(p);
    let closed = false;
    r.once("close", () => { closed = true; });
    A.pm._handleConnection(p, {});
    r.write(JSON.stringify({ type: "challenge", challenge: randomBytes(32).toString("hex"), cb: 1, pb: 1, pubkey: stranger.ed25519Pubkey, crowId: identity.crowId, instance_id: claimId }) + "\n");
    assert.ok(await until(() => pmFrames.some((f) => f.type === "challenge-response"), W(3000)), `${claimId}: answered`);
    // It cannot prove our key: its own response fails.
    r.write(JSON.stringify({ type: "challenge-response", crowId: identity.crowId, pubkey: identity.ed25519Pubkey, cb_sig: "00".repeat(64) }) + "\n");
    assert.ok(await until(() => closed, W(3000)), `${claimId}: refused`);
    await sleep(100);
    assertInert(A, `U-H10 ${claimId}`, { frames: pmFrames });
    return pmFrames;
  };
  const paired = await probe(b.id);
  const unpaired = await probe("inst-unpaired");
  for (const [frames, who] of [[paired, "paired"], [unpaired, "unpaired"]]) {
    assert.deepEqual(framesOf(frames, "pair-binding"), [], `${who}: no pair-binding frame`);
    assert.deepEqual(frames.map((f) => f.type), ["challenge", "challenge-response"], `${who}: only the challenge and the cb reply`);
  }
  const shape = (frames) => Object.keys(framesOf(frames, "challenge-response")[0]).sort();
  assert.deepEqual(shape(paired), shape(unpaired), "same key set");
  assert.deepEqual(shape(paired), ["cb_sig", "crowId", "pubkey", "type"]);
  const strip = (frames) => { const { cb_sig, ...rest } = framesOf(frames, "challenge-response")[0]; return { ...rest, cbLen: cb_sig.length }; };
  assert.deepEqual(strip(paired), strip(unpaired), "same values apart from the signature");
});

// ================================================================ U-H12
test("U-H12 a peer that offers cb:1/pb:1 but proves with a bare signature (host unpinned) gets no pair-binding frame and is decided unbound at once (legacy in auto)", T, async (t) => {
  const { identity, a, b, pairKey } = await makePair(t);
  {
    // Control: the same offer proven with a cb_sig gets the frame.
    const A = newNode(a);
    const R = await rawSibling(t, A, identity, { challengeId: b.id, responseId: b.id, pbKeyHex: pairKey });
    assert.ok(await until(() => A.spies.instanceConnected.length === 1, W(5000)));
    assert.equal(framesOf(R.pmFrames, "pair-binding").length, 1, "control: a cb_sig prover gets the frame");
  }
  const p2 = await makePair(t); // unpinned host (no instance_hs_cb:, no pair pin)
  // A wait far longer than any admission takes: deciding inside it proves A did not wait.
  const A = newNode(p2.a, { pairBindingWaitMs: 60_000 });
  const t0 = Date.now();
  const R = await rawSibling(t, A, p2.identity, { challengeId: p2.b.id, responseId: p2.b.id, proof: "sig", pbFrame: false });
  assert.ok(await until(() => A.spies.instanceConnected.length === 1, W(5000)), "admitted as legacy");
  assert.ok(Date.now() - t0 < 30_000, "decided without waiting for a frame");
  await sleep(200);
  assert.deepEqual(framesOf(R.pmFrames, "pair-binding"), [], "no pair-binding frame for a bare-signature prover");
  assert.equal(await pairPin(p2.a, p2.b.id), null);
});

// ================================================================ U-H11
test("U-H11 a sibling that offers pb but never sends its pair-binding frame is refused guard:pb_timeout (wait set through wireInstanceSync); control: with the frame it is admitted", T, async (t) => {
  const { identity, a, b, pairKey } = await makePair(t);
  {
    const A = newNode(a, { pairBindingWaitMs: 300 });
    await rawSibling(t, A, identity, { challengeId: b.id, responseId: b.id, pbKeyHex: pairKey });
    assert.ok(await until(() => A.spies.instanceConnected.length === 1, W(5000)), "control: the frame arrives, admitted");
  }
  logs.length = 0;
  const A = newNode(a, { pairBindingWaitMs: 300 });
  assert.equal(A.pm.pairBindingWaitMs, 300);
  const t0 = Date.now();
  const R = await rawSibling(t, A, identity, { challengeId: b.id, responseId: b.id, pbFrame: false });
  assert.ok(await until(() => R.closed, W(5000)), "destroyed");
  assert.ok(Date.now() - t0 >= 250, "after the wait");
  await sleep(100);
  assert.ok(refusedFor("guard:pb_timeout"), "refused guard:pb_timeout");
  assertInert(A, "U-H11 timeout", { frames: R.pmFrames });
  assert.equal(new PeerManager(identity, { env: {} }).pairBindingWaitMs, 10_000, "the default wait is 10 s");
});

// ================================================================ U-H9
test("U-H9 runtime spy (I5): on every refusal above, onInstanceConnected, onInstanceKeyReceived, getFeedKeyForInstance and replicate stayed empty", async () => {
  await sleep(300); // late fires would land by now
  assert.ok(refusalRegistry.length >= 15, `refusals checked: ${refusalRegistry.length}`);
  for (const { label, N } of refusalRegistry) {
    const s = N.spies;
    assert.deepEqual([s.instanceConnected.length, s.keyReceived.length, s.feedKeyAsked.length, s.replicate.length], [0, 0, 0, 0], label);
  }
});
