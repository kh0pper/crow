/**
 * PT-2b Task 3: the tailnet control phase is MAC'd under a per-connection
 * session key, and the replication stream is bound to it.
 *
 * Real two-instance harness (tests/fixtures/sync-fleet.mjs + sync-gateway.mjs):
 * real InstanceSyncManagers, real Hypercore feeds, real http servers running
 * setupTailnetSyncServer, real startTailnetSyncClients. An on-path relay sits
 * between the dialer and the server (tests/fixtures/sync-gateway.mjs
 * startWsRelay) and rewrites, drops, replays or withholds frames.
 *
 * EVERY negative first runs the same relay in pass-through mode as a positive
 * control: the relay must be transparent, so a refusal can only come from the
 * session check. See the private engineering notes for the design.
 *
 *   U-S1  new↔new: sm negotiated, both feed frames carry noise_pk, markers
 *         flow, both logs show "session-bound link".
 *   U-S2  relay swaps the feed key s→c: bad_mac, no backfill, no initInstance,
 *         no replicate, no marker.
 *   U-S3  relay swaps the feed key c→s: refused before sync_url/last_seen.
 *   U-S3b the server's C3 refusal reaches the client as closed-by-peer only
 *         (no client-side noise_timeout, no second session item).
 *   U-S4  address swap in C1 (server refuses at C2) and in S1 (server refuses,
 *         the client never backfills because S2 never arrives).
 *   U-S5  replay/reorder: C2 in C3's slot, session 1's C3 into session 2, and
 *         session 1's C3 into C2's slot; S2 with sm stripped.
 *   U-S6  the strip matrix + a PT-2a peer in require (both roles) and in auto.
 *   U-S8  a session refusal retries at normal backoff, not the refused park.
 *   U-S9  one log line per peer/reason/hour; no 64-hex value in any log line.
 *   U-S10 Noise binding: a Noise MITM is refused on both sides; an unbound
 *         pair in auto is still MITM-able (the documenting control).
 *   U-S12 a negotiated session over an UNBOUND pair (an auto, unpinned peer
 *         whose proof carries no pair key) is refused sm_invalid before any
 *         side effect — session mode is negotiated AND bound on each side.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { makeFleet, until, sleep, hasMemory, writeAndEmit } from "./fixtures/sync-fleet.mjs";
import { startGateway, startWsRelay } from "./fixtures/sync-gateway.mjs";
import { _setAllowLoopbackAddressesForTest, _resetSessionRefusalLogForTest, _resetLegacySessionLogForTest, SESSION_BINDING_CLOSE_REASON } from "../servers/sharing/tailnet-sync.js";
import { sign } from "../servers/sharing/identity.js";
import { getPeerDialHealth, _resetPeerDialHealth } from "../servers/shared/peer-dial-health.js";
import { getPeerTrustHealth, _resetPeerTrustHealth } from "../servers/shared/peer-trust-health.js";
import { _resetPairBindingModeLog } from "../servers/shared/sync-pair-binding.js";

_setAllowLoopbackAddressesForTest(true);

/* ------------------------------------------------------------- helpers */

const realWarn = console.warn;
const realLog = console.log;
let logs = [];
function capture() {
  logs = [];
  const rec = (orig) => (...a) => { logs.push(a.map(String).join(" ")); if (process.env.TEST_LOUD) orig(...a); };
  console.warn = rec(realWarn);
  console.log = rec(realLog);
}
function release() { console.warn = realWarn; console.log = realLog; }
const LOG = { warn: (...a) => console.warn(...a), log: (...a) => console.log(...a) };

function reset() {
  _resetPeerDialHealth();
  _resetPeerTrustHealth();
  _resetSessionRefusalLogForTest();
  _resetLegacySessionLogForTest();
  _resetPairBindingModeLog();
}

const linked = (a, b) => a.mgr.hasDedicatedStream(b.id) && b.mgr.hasDedicatedStream(a.id);
const unlinked = (a, b) => !a.mgr.hasDedicatedStream(b.id) && !b.mgr.hasDedicatedStream(a.id);
const dialErr = (peerId) => getPeerDialHealth()[peerId]?.lastError || "";

let markerSeq = 8000;
async function markers(x, y, label) {
  const m1 = ++markerSeq; const m2 = ++markerSeq;
  await writeAndEmit(x, m1, `session ${label} x→y`);
  await writeAndEmit(y, m2, `session ${label} y→x`);
  return { m1, m2 };
}
async function flowBoth(x, y, label) {
  await x.startClients();
  assert.ok(await until(() => linked(x.side, y.side), 10_000), `${label}: link forms`);
  const { m1, m2 } = await markers(x.side, y.side, label);
  assert.ok(await until(() => hasMemory(y.side.db, m1), 8000), `${label}: x→y marker`);
  assert.ok(await until(() => hasMemory(x.side.db, m2), 8000), `${label}: y→x marker`);
  x.stopClients();
  assert.ok(await until(() => unlinked(x.side, y.side), 5000), `${label}: torn down`);
}

async function pointAt(side, peer, port) {
  await side.db.execute({ sql: "UPDATE crow_instances SET gateway_url = ? WHERE id = ?", args: [`http://127.0.0.1:${port}`, peer.id] });
}
async function override(side, key) {
  const { rows } = await side.db.execute({ sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?", args: [key, side.id] });
  return rows[0]?.value ?? null;
}
/** This side's PT-2a pin for `peerId` ("1" when bound before), or null. */
const pairPin = (side, peerId) => override(side, `sync_pair_bound:${peerId}`);
async function peerRow(side, peerId) {
  const { rows } = await side.db.execute({ sql: "SELECT gateway_url, tailscale_ip, sync_url, last_seen_at FROM crow_instances WHERE id = ?", args: [peerId] });
  return { ...rows[0] };
}

/** A relay tap: records every text frame it forwards. */
function tap(store) {
  return (dir, idx, text) => { store.push({ dir, idx, text }); return undefined; };
}
const framesOf = (seen, dir) => seen.filter((f) => f.dir === dir).map((f) => ({ ...f, msg: JSON.parse(f.text) }));
const mutate = (text, fn) => { const m = JSON.parse(text); fn(m); return JSON.stringify(m); };

/** Swap a feed frame's feed key for one the relay chose (an on-path seed holder). */
const swapFeedKey = (text) => mutate(text, (m) => { m.feed_key_hex = randomBytes(32).toString("hex"); });

/** Rewrite a hello's signed address block, re-signed with the (shared) seed. */
function resignAddr(text, identity, addr) {
  return mutate(text, (h) => {
    const canon = JSON.stringify({ gateway_url: addr.gateway_url ?? null, tailscale_ip: addr.tailscale_ip ?? null, sync_port: addr.sync_port ?? null });
    h.addr = addr;
    h.addr_sig = sign(`addr:${h.instance_id}:${h.nonce_hex}:${canon}`, identity.ed25519Priv);
  });
}

/* --------------------------------------------------------------- U-S1 */

test("U-S1 new↔new: sm is negotiated, both feed frames carry noise_pk, markers flow both ways and both sides log a session-bound link", async () => {
  reset();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const A = await startGateway(fleet, a, { log: LOG });
  const B = await startGateway(fleet, b, { log: LOG });
  const seen = [];
  const relay = await startWsRelay(B.port, { onText: tap(seen) });
  try {
    capture();
    await pointAt(a, b, relay.port);
    await flowBoth({ side: a, startClients: A.startClients, stopClients: A.stopClients }, { side: b, startClients: B.startClients, stopClients: B.stopClients }, "u-s1");

    // Both hellos offered sm; the signalled frames carry counters and MACs.
    const c2s = framesOf(seen, "c2s").map((f) => f.msg);
    const s2c = framesOf(seen, "s2c").map((f) => f.msg);
    assert.equal(c2s[0].sm, 1, "C1 offers sm");
    assert.equal(s2c[0].sm, 1, "S1 accepts it");
    assert.equal(c2s[1].sm_ctr, 0);
    assert.equal(typeof c2s[1].sm, "string");
    assert.equal(s2c[1].sm_ctr, 0);
    assert.match(s2c[1].noise_pk, /^[0-9a-f]{64}$/, "the server's feed frame carries its Noise key");
    assert.equal(c2s[2].sm_ctr, 1);
    assert.match(c2s[2].noise_pk, /^[0-9a-f]{64}$/, "the client's feed frame carries its Noise key");
    assert.equal(typeof c2s[2].sm, "string");
    assert.ok(!("noise_pk" in c2s[1]), "the proof frame carries no Noise key");

    assert.ok(logs.some((l) => /session-bound link/.test(l) && /client side/.test(l)), logs.join("\n"));
    assert.ok(logs.some((l) => /session-bound link/.test(l) && /server side/.test(l)));
    assert.ok(!logs.some((l) => /session binding failed/.test(l)), logs.join("\n"));
  } finally {
    release();
    await relay.close();
    A.stopClients(); B.stopClients();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

/* --------------------------------------------------------------- U-S2 */

test("U-S2 relay swaps the feed key in S2 after a genuine handshake: the client refuses bad_mac, never backs the address up, never opens a feed or a stream, and no marker crosses; pass-through control: everything flows", async () => {
  reset();
  const fleet = await makeFleet();
  const { a, b, identity } = fleet;
  const A = await startGateway(fleet, a, { log: LOG });
  const B = await startGateway(fleet, b, { log: LOG });
  // A signs its own address so the server could back it up; the client would
  // too if it ever got past S2.
  B.advertise = { tailscale_ip: "127.0.0.1", sync_port: 4998 };
  let tamper = false;
  const seen = [];
  const relay = await startWsRelay(B.port, {
    onText: (dir, idx, text) => {
      seen.push({ dir, idx, text });
      if (tamper && dir === "s2c" && idx === 2) return swapFeedKey(text);
      return undefined;
    },
  });
  const keyed = [];
  const replicated = [];
  try {
    capture();
    const realInit = a.mgr.initInstance.bind(a.mgr);
    a.mgr.initInstance = (id, key) => { if (key) keyed.push(id); return realInit(id, key); };
    const realReplicate = a.mgr.replicate.bind(a.mgr);
    a.mgr.replicate = (id, stream, opts) => { replicated.push(id); return realReplicate(id, stream, opts); };
    await pointAt(a, b, relay.port);

    // Positive control: the same relay, pass-through.
    await flowBoth({ side: a, startClients: A.startClients, stopClients: A.stopClients }, { side: b, startClients: B.startClients, stopClients: B.stopClients }, "u-s2 control");
    assert.equal((await peerRow(a, b.id)).tailscale_ip, "127.0.0.1", "control: the client backed the server's address up");
    keyed.length = 0; replicated.length = 0;
    // The control leg persisted both keys; clear them so the refresh loop's heal
    // opens no feed and only THIS handshake could supply a key.
    for (const [x, y] of [[a, b], [b, a]]) {
      await x.db.execute({ sql: "UPDATE crow_instances SET sync_url = NULL, last_seen_at = '2000-01-01 00:00:00' WHERE id = ?", args: [y.id] });
    }
    const beforeA = await peerRow(a, b.id);
    const beforeB = await peerRow(b, a.id);

    // Now swap the server's feed key.
    tamper = true;
    _resetPeerDialHealth();
    _resetPeerTrustHealth();
    logs = [];
    await A.startClients();
    assert.ok(await until(() => /session binding failed \(bad_mac\)/.test(dialErr(b.id)), 8000), dialErr(b.id));
    await sleep(300);
    A.stopClients();
    assert.ok(logs.some((l) => /session binding failed for/.test(l) && /client side/.test(l) && /bad_mac/.test(l)), logs.join("\n"));
    // The client refused before any side effect of this connection.
    assert.equal(a.mgr.hasDedicatedStream(b.id), false, "no dedicated stream");
    assert.deepEqual(replicated, [], "replicate() never ran");
    assert.deepEqual(keyed, [], "initInstance never got a key");
    assert.deepEqual(await peerRow(a, b.id), beforeA, "the client's row (address, sync_url, last_seen) is unchanged");
    // The server never got C3, so it wrote no key from this connection.
    assert.deepEqual(await peerRow(b, a.id), beforeB, "the server's row is unchanged");
    const { m1 } = await markers(a, b, "u-s2 after");
    await sleep(500);
    assert.equal(await hasMemory(b.db, m1), false, "nothing crosses");
  } finally {
    release();
    await relay.close();
    A.stopClients(); B.stopClients();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

/* --------------------------------------------------------------- U-S3 */

test("U-S3 relay swaps the feed key in C3: the server refuses before sync_url, last_seen_at or a feed; pass-through control: the same leg links", async () => {
  reset();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const A = await startGateway(fleet, a, { log: LOG });
  const B = await startGateway(fleet, b, { log: LOG });
  let tamper = false;
  const relay = await startWsRelay(B.port, {
    onText: (dir, idx, text) => (tamper && dir === "c2s" && idx === 3 ? swapFeedKey(text) : undefined),
  });
  const keyed = [];
  try {
    capture();
    const realInit = b.mgr.initInstance.bind(b.mgr);
    b.mgr.initInstance = (id, key) => { if (key) keyed.push(id); return realInit(id, key); };
    await pointAt(a, b, relay.port);
    await flowBoth({ side: a, startClients: A.startClients, stopClients: A.stopClients }, { side: b, startClients: B.startClients, stopClients: B.stopClients }, "u-s3 control");
    keyed.length = 0;
    // The control leg persisted a key; clear it so a refusal is visible.
    await b.db.execute({ sql: "UPDATE crow_instances SET sync_url = NULL, last_seen_at = '2000-01-01 00:00:00' WHERE id = ?", args: [a.id] });
    const before = await peerRow(b, a.id);

    tamper = true;
    _resetPeerDialHealth();
    logs = [];
    await A.startClients();
    // The server refuses C3 and closes with the session reason. The client is
    // in the Noise wait and classifies that close as closed-by-peer (no
    // noise_timeout of its own — U-S3b asserts that half). The refusal itself
    // is the SERVER's, and it must land before any server side effect.
    assert.ok(await until(() => /session binding failed for/.test(logs.join("\n")) && /server side/.test(logs.join("\n")), 8000), logs.join("\n"));
    await sleep(300);
    A.stopClients();
    assert.ok(logs.some((l) => /session binding failed for/.test(l) && /server side/.test(l) && /feed frame/.test(l) && /bad_mac/.test(l)), logs.join("\n"));
    assert.deepEqual(keyed, [], "the server never opened a feed from the swapped key");
    assert.deepEqual(await peerRow(b, a.id), before, "sync_url and last_seen_at unchanged");
    assert.equal(b.mgr.hasDedicatedStream(a.id), false, "no dedicated stream");
  } finally {
    release();
    await relay.close();
    A.stopClients(); B.stopClients();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

/* -------------------------------------------------------------- U-S3b */

test("U-S3b when the server refuses C3 the client classifies the close as closed-by-peer only: no noise_timeout of its own and no client-side session item; control: the same relay pass-through logs the session-bound link", async () => {
  reset();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const A = await startGateway(fleet, a, { log: LOG });
  const B = await startGateway(fleet, b, { log: LOG });
  // A relay that, once the client's C3 has gone through, closes the client's
  // leg exactly the way a refusing server does: 1008 + the session reason. (A
  // hard terminate would reach the client as 1006 and it could not classify
  // anything; the direct two-process legs see the real server do this.)
  const refusing = await startWsRelay(B.port, { closeClientWith: { code: 1008, reason: SESSION_BINDING_CLOSE_REASON } });
  const passRelay = await startWsRelay(B.port, {});
  try {
    capture();
    // Positive control: a transparent relay, and the client logs its own
    // session-bound link — so the absence asserted below is the close's doing.
    await pointAt(a, b, passRelay.port);
    await flowBoth({ side: a, startClients: A.startClients, stopClients: A.stopClients }, { side: b, startClients: B.startClients, stopClients: B.stopClients }, "u-s3b control");
    assert.ok(logs.some((l) => /session-bound link/.test(l) && /client side/.test(l)), logs.join("\n"));

    logs = [];
    _resetPeerDialHealth();
    _resetSessionRefusalLogForTest();
    await pointAt(a, b, refusing.port);
    await A.startClients();
    // The refusal reaches the client as the close reason; nothing the client did
    // failed, so its dial health says closed-by-peer, not noise_timeout.
    assert.ok(await until(() => /closed by peer \(1008 session binding failed\)/.test(dialErr(b.id)), 8000), dialErr(b.id));
    await sleep(500);
    A.stopClients();
    // The client's half of the record: none. noteSessionRefusal writes the log
    // line and the Nest item together, so no client-side line means no second,
    // false "failed the session check" item for a refusal the server owns.
    // (The server may still log its OWN noise_timeout: the relay cut the leg it
    // was replicating on. That is the server's line, not the client's.)
    const clientLines = logs.filter((l) => /\(client side/.test(l));
    assert.ok(!clientLines.some((l) => /session binding failed/.test(l)), `no client-side session refusal: ${logs.join("\n")}`);
    assert.ok(!clientLines.some((l) => /noise_timeout/.test(l)), `no client-side noise_timeout: ${logs.join("\n")}`);
    assert.ok(!/noise_timeout/.test(dialErr(b.id)), dialErr(b.id));
    assert.ok(!logs.some((l) => /session-bound link/.test(l)), "no session-bound link");
    assert.equal(a.mgr.hasDedicatedStream(b.id), false, "no link");
  } finally {
    release();
    await refusing.close();
    await passRelay.close();
    A.stopClients(); B.stopClients();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

/* --------------------------------------------------------------- U-S4 */

test("U-S4 address swap: (a) in C1 the server refuses at C2 (bad_mac) with no side effect; (b) in S1 the server refuses too and the client never backs the address up (S2 never arrives)", async () => {
  reset();
  const fleet = await makeFleet();
  const { a, b, identity } = fleet;
  const A = await startGateway(fleet, a, { log: LOG });
  const B = await startGateway(fleet, b, { log: LOG });
  B.advertise = { tailscale_ip: "127.0.0.1", sync_port: 4998 };
  const evil = { gateway_url: null, tailscale_ip: "127.0.0.2", sync_port: 4111 };
  let tamper = null; // "c1" | "s1" | null
  const relay = await startWsRelay(B.port, {
    onText: (dir, idx, text) => {
      if (tamper === "c1" && dir === "c2s" && idx === 1) return resignAddr(text, identity, evil);
      if (tamper === "s1" && dir === "s2c" && idx === 1) return resignAddr(text, identity, evil);
      return undefined;
    },
  });
  try {
    capture();
    await pointAt(a, b, relay.port);
    // Positive control: pass-through links and teaches the client the address.
    await flowBoth({ side: a, startClients: A.startClients, stopClients: A.stopClients }, { side: b, startClients: B.startClients, stopClients: B.stopClients }, "u-s4 control");
    assert.equal((await peerRow(a, b.id)).tailscale_ip, "127.0.0.1", "control: the real address was learned");
    // Reset everything a legitimate handshake would write.
    for (const x of [a, b]) {
      await x.db.execute({ sql: "UPDATE crow_instances SET tailscale_ip = NULL, sync_url = NULL, last_seen_at = '2000-01-01 00:00:00' WHERE id = ?", args: [x === a ? b.id : a.id] });
      await x.db.execute({ sql: "DELETE FROM dashboard_settings_overrides WHERE instance_id = ?", args: [x.id] });
    }
    const beforeA = await peerRow(a, b.id);
    const beforeB = await peerRow(b, a.id);

    for (const where of ["c1", "s1"]) {
      tamper = where;
      logs = [];
      _resetPeerDialHealth();
      _resetSessionRefusalLogForTest(); // the throttle is per peer/frame/reason per hour
      await A.startClients();
      // Both swaps make the two sides' transcripts differ, so the SERVER is the
      // one that cannot verify the client's C2 MAC; the client never sees S2.
      assert.ok(await until(() => /session binding failed for/.test(logs.join("\n")) && /server side/.test(logs.join("\n")), 8000), `${where}: ${logs.join("\n")}`);
      await sleep(300);
      A.stopClients();
      assert.ok(logs.some((l) => /server side, proof frame/.test(l) && /bad_mac/.test(l)), `${where}: ${logs.join("\n")}`);
      assert.equal(a.mgr.hasDedicatedStream(b.id), false, `${where}: no link`);
      assert.equal(b.mgr.hasDedicatedStream(a.id), false, `${where}: no link (server)`);
      assert.deepEqual(await peerRow(a, b.id), beforeA, `${where}: the client's row is unchanged (no address backfill)`);
      assert.deepEqual(await peerRow(b, a.id), beforeB, `${where}: the server's row is unchanged (no address, no key, no liveness)`);
      assert.equal(await override(b, `tailnet_sync_port:${a.id}`), null, `${where}: no port memo from the swapped address`);
      assert.equal(await override(b, `tailnet_sync_cr:${a.id}`), null, `${where}: no CR pin`);
      // The client's own CR pin is NOT a session side effect: S1 alone already
      // proved the seed and our nonce, which is all that pin records.
      assert.equal(await override(a, `tailnet_sync_cr:${b.id}`), "1", `${where}: the client's CR pin stands (S1 proved the seed)`);
    }
  } finally {
    release();
    await relay.close();
    A.stopClients(); B.stopClients();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

/* --------------------------------------------------------------- U-S5 */

test("U-S5 replay and reorder: C2 in C3's slot (bad_ctr), session 1's C3 in session 2 (bad_mac), session 1's C3 in C2's slot (refused), and S2 with sm stripped (missing)", async () => {
  reset();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const A = await startGateway(fleet, a, { log: LOG });
  const B = await startGateway(fleet, b, { log: LOG });
  let mode = "pass";
  let captured = null;
  let lastProof = null;
  let lastC3 = null;
  const relay = await startWsRelay(B.port, {
    onText: (dir, idx, text) => {
      if (dir === "s2c") {
        if (mode === "strip-s2-sm" && idx === 2) return mutate(text, (m) => { delete m.sm; });
        return undefined;
      }
      if (idx === 2) lastProof = text;
      if (mode === "c2-in-c3" && idx === 3) return lastProof;
      if (mode === "old-c3-in-c3" && idx === 3 && captured) return captured;
      if (mode === "old-c3-in-c2" && idx === 2 && captured) return captured;
      if (idx === 3) lastC3 = text;
      return undefined;
    },
  });
  const attempt = async (label, reason) => {
    logs = [];
    _resetPeerDialHealth();
    _resetSessionRefusalLogForTest();
    await A.startClients();
    const seenReason = () => dialErr(b.id).includes(`session binding failed (${reason})`)
      || logs.some((l) => /session binding failed for/.test(l) && l.endsWith(`: ${reason}`));
    assert.ok(await until(seenReason, 8000), `${label}: ${dialErr(b.id)}\n${logs.join("\n")}`);
    await sleep(200);
    A.stopClients();
    assert.equal(a.mgr.hasDedicatedStream(b.id), false, `${label}: no link`);
  };
  try {
    capture();
    await pointAt(a, b, relay.port);
    // Control: pass-through links, and its C3 is the frame replayed below.
    await A.startClients();
    assert.ok(await until(() => linked(a, b), 10_000), "control link");
    await sleep(200);
    captured = lastC3;
    assert.match(captured, /noise_pk/, "control: a real C3 was captured");
    A.stopClients();
    assert.ok(await until(() => unlinked(a, b), 5000));

    mode = "c2-in-c3";
    await attempt("C2 in C3's slot", "bad_ctr");
    assert.ok(logs.some((l) => /server side, feed frame, ctr 0\): bad_ctr/.test(l)), logs.join("\n"));

    mode = "old-c3-in-c3";
    await attempt("session 1's C3 into session 2", "bad_mac");
    assert.ok(logs.some((l) => /server side, feed frame, ctr 1\): bad_mac/.test(l)), logs.join("\n"));

    mode = "old-c3-in-c2";
    logs = [];
    _resetPeerDialHealth();
    await A.startClients();
    // The CR proof check runs first: a feed frame in the proof slot carries no cr_proof.
    assert.ok(await until(() => /closed by peer \(1008 bad proof\)/.test(dialErr(b.id)) || /challenge proof INVALID/.test(logs.join("\n")), 8000), dialErr(b.id));
    A.stopClients();
    assert.equal(b.mgr.hasDedicatedStream(a.id), false, "a feed frame in the proof slot never becomes a link");

    mode = "strip-s2-sm";
    await attempt("S2 with sm stripped", "missing");
    assert.ok(logs.some((l) => /client side, feed frame, ctr 0\): missing/.test(l)), logs.join("\n"));
  } finally {
    release();
    await relay.close();
    A.stopClients(); B.stopClients();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

/* --------------------------------------------------------------- U-S6 */

test("U-S6 the strip matrix: S1-only strip in require is sm_required before C2; auto client + require server is missing; C1 strip with an auto server and a require client is sm_required; auto↔auto documents the legacy link; a PT-2a-modelled peer is refused in require both ways and admitted in auto with a Nest item", async () => {
  reset();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const A = await startGateway(fleet, a, { log: LOG });
  const B = await startGateway(fleet, b, { log: LOG });
  let strip = null; // "s1" | "c1"
  let seen = [];
  const relayB = await startWsRelay(B.port, {
    onText: (dir, idx, text) => {
      seen.push({ dir, idx, text });
      if (strip === "s1" && dir === "s2c" && idx === 1) return mutate(text, (m) => { delete m.sm; });
      if (strip === "c1" && dir === "c2s" && idx === 1) return mutate(text, (m) => { delete m.sm; });
      return undefined;
    },
  });
  // The fallback-dial legs need a relay in front of A too.
  const relayA = await startWsRelay(A.port, {});
  const refusal = (side, reason) => (l) => /session binding failed for/.test(l) && l.includes(`${side} side`) && l.endsWith(`: ${reason}`);
  try {
    capture();
    await pointAt(a, b, relayB.port);
    await pointAt(b, a, relayA.port);

    // 1. Strip sm from S1 only, client require: refused before C2 is sent.
    strip = "s1";
    seen = [];
    logs = [];
    await A.startClients();
    assert.ok(await until(() => logs.some(refusal("client", "sm_required")), 8000), logs.join("\n"));
    await sleep(200);
    A.stopClients();
    assert.ok(!seen.some((f) => f.dir === "c2s" && f.idx === 2), "no cr_proof/pb_proof reached the server");

    // 2. Client auto + server require: the client takes the legacy branch, the
    //    server negotiated a session and calls the missing MAC `missing`.
    A.ctx.pairBindingMode = "auto";
    _resetSessionRefusalLogForTest();
    _resetLegacySessionLogForTest();
    logs = [];
    await A.startClients();
    assert.ok(await until(() => logs.some(refusal("server", "missing")), 8000), logs.join("\n"));
    A.stopClients();

    // 3. Strip sm from C1 with an auto server and a require client: the server
    //    takes the legacy branch and says so; the client refuses.
    A.ctx.pairBindingMode = "require";
    B.ctx.pairBindingMode = "auto";
    strip = "c1";
    _resetSessionRefusalLogForTest();
    _resetLegacySessionLogForTest();
    logs = [];
    await A.startClients();
    assert.ok(await until(() => logs.some(refusal("client", "sm_required")), 8000), dialErr(b.id) + "\n" + logs.join("\n"));
    A.stopClients();

    // 4. auto↔auto: the documenting control — a stripped sm still links, as
    //    legacy, and the peer gets the log line and the Nest item.
    A.ctx.pairBindingMode = "auto";
    _resetPeerTrustHealth();
    _resetLegacySessionLogForTest();
    logs = [];
    await flowBoth({ side: a, startClients: A.startClients, stopClients: A.stopClients }, { side: b, startClients: B.startClients, stopClients: B.stopClients }, "u-s6 auto↔auto");
    assert.ok(!logs.some((l) => /session-bound link/.test(l)), "no session-bound link on the legacy path");
    assert.ok(logs.some((l) => /syncs without session MACs \(server side/.test(l)), logs.join("\n"));
    assert.match(getPeerTrustHealth().unboundPeers[a.id]?.message || "", /without session MACs/, "the server raises the session Nest item");

    // 5. A PT-2a-modelled peer (sessionMacOffer: false = PT-2a) with A in
    //    require, as CLIENT: refused on S1, before C2.
    strip = null;
    A.ctx.pairBindingMode = "require";
    B.ctx.pairBindingMode = "require";
    B.ctx.sessionMacOffer = false;
    _resetPeerTrustHealth();
    _resetSessionRefusalLogForTest();
    _resetLegacySessionLogForTest();
    seen = [];
    logs = [];
    await A.startClients();
    assert.ok(await until(() => logs.some(refusal("client", "sm_required")), 8000), logs.join("\n"));
    await sleep(200);
    A.stopClients();
    assert.ok(!seen.some((f) => f.dir === "c2s" && f.idx === 2), "the PT-2a server never received a proof");

    // 6. The same pair in auto as CLIENT: bound, markers flow, Nest item.
    A.ctx.pairBindingMode = "auto";
    _resetPeerTrustHealth();
    _resetLegacySessionLogForTest();
    await flowBoth({ side: a, startClients: A.startClients, stopClients: A.stopClients }, { side: b, startClients: B.startClients, stopClients: B.stopClients }, "u-s6 legacy client");
    assert.match(getPeerTrustHealth().unboundPeers[b.id]?.message || "", /without session MACs/);

    // 7. The same pair with A in require, as SERVER (B fallback-dials A):
    //    refused after the proof, before any side effect on A.
    for (const x of [a, b]) {
      await x.db.execute({ sql: "UPDATE crow_instances SET tailscale_ip = NULL, sync_url = NULL, last_seen_at = '2000-01-01 00:00:00' WHERE id = ?", args: [x === a ? b.id : a.id] });
      await x.db.execute({ sql: "DELETE FROM dashboard_settings_overrides WHERE instance_id = ?", args: [x.id] });
    }
    const beforeA = await peerRow(a, b.id);
    A.ctx.pairBindingMode = "require";
    // B is the PT-2a-modelled peer: it offers no sm. Its own *client* side must
    // not also enforce (real PT-2a has no session check at all), so it runs
    // `auto` while A stays in `require`.
    B.ctx.pairBindingMode = "auto";
    _resetSessionRefusalLogForTest();
    _resetLegacySessionLogForTest();
    _resetPeerDialHealth();
    logs = [];
    await B.startClients();
    assert.ok(await until(() => logs.some(refusal("server", "sm_required")), 8000), dialErr(a.id) + "\n" + logs.join("\n"));
    B.stopClients();
    assert.deepEqual(await peerRow(a, b.id), beforeA, "no side effect on the refusing server");
    assert.equal(await override(a, `tailnet_sync_cr:${b.id}`), null, "no CR pin on the refusing server");

    // 8. And in auto as SERVER: the link forms both ways, with a Nest item.
    A.ctx.pairBindingMode = "auto";
    _resetPeerTrustHealth();
    _resetLegacySessionLogForTest();
    await flowBoth({ side: b, startClients: B.startClients, stopClients: B.stopClients }, { side: a, startClients: A.startClients, stopClients: A.stopClients }, "u-s6 legacy server");
    assert.match(getPeerTrustHealth().unboundPeers[b.id]?.message || "", /without session MACs/);
  } finally {
    release();
    await relayB.close();
    await relayA.close();
    A.stopClients(); B.stopClients();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

/* --------------------------------------------------------------- U-S8 */

test("U-S8 a session refusal is retried at normal backoff, not the 10-minute refused park: the link forms within 15 s once the tampering stops", async () => {
  reset();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const A = await startGateway(fleet, a, { log: LOG, refusedRecheckMs: 600_000 });
  const B = await startGateway(fleet, b, { log: LOG });
  let block = true;
  const relay = await startWsRelay(B.port, {
    onText: (dir, idx, text) => (block && dir === "c2s" && idx === 1 ? mutate(text, (m) => { delete m.sm; }) : undefined),
  });
  try {
    capture();
    await pointAt(a, b, relay.port);
    await A.startClients();
    assert.ok(await until(() => /session binding failed \(sm_required\)/.test(dialErr(b.id)), 8000), dialErr(b.id));
    const fix = setTimeout(() => { block = false; }, 2000);
    const t0 = Date.now();
    assert.ok(await until(() => linked(a, b), 15_000), `link within 15 s (${Date.now() - t0} ms); last error ${dialErr(b.id)}`);
    clearTimeout(fix);
    assert.ok(logs.some((l) => /session-bound link/.test(l)), logs.join("\n"));
  } finally {
    release();
    await relay.close();
    A.stopClients(); B.stopClients();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

/* --------------------------------------------------------------- U-S9 */

test("U-S9 logs: one line per peer/frame/reason per hour (injected clock), and no log line ever carries a 64-hex value", async () => {
  reset();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const A = await startGateway(fleet, a, { log: LOG });
  const B = await startGateway(fleet, b, { log: LOG });
  let t = 1_000_000;
  A.ctx.now = () => t;
  const relay = await startWsRelay(B.port, {
    onText: (dir, idx, text) => (dir === "c2s" && idx === 1 ? mutate(text, (m) => { delete m.sm; }) : undefined),
  });
  const hits = () => logs.filter((l) => /session binding failed for/.test(l) && l.endsWith(": sm_required")).length;
  try {
    capture();
    await pointAt(a, b, relay.port);
    await A.startClients();
    assert.ok(await until(() => hits() >= 1, 8000), logs.join("\n"));
    // Several retries inside the hour are throttled to one line.
    await sleep(6500);
    assert.equal(hits(), 1, logs.join("\n"));
    // Two hours later the next refusal logs again.
    t += 2 * 3_600_001;
    assert.ok(await until(() => hits() >= 2, 20_000), `still ${hits()} line(s): ${logs.join("\n")}`);
    assert.equal(hits(), 2, "exactly one more line for the new hour");
    // Nothing secret rides a log line: no 64-hex value at all (MAC, key, hash, nonce).
    const leaks = logs.filter((l) => /[0-9a-f]{64}/.test(l));
    assert.deepEqual(leaks, [], "logs carry no 64-hex values");
  } finally {
    release();
    await relay.close();
    A.stopClients(); B.stopClients();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

test("U-S12 a negotiated session over an UNBOUND pair (auto, unpinned, no pb_proof) is refused sm_invalid before any side effect; control: the same relay pass-through links session-bound", async () => {
  reset();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const A = await startGateway(fleet, a, { log: LOG });
  const B = await startGateway(fleet, b, { log: LOG });
  let strip = false;
  const relay = await startWsRelay(B.port, {
    onText: (dir, idx, text) => (strip && dir === "c2s" && idx === 2 ? mutate(text, (m) => { delete m.pb_proof; }) : undefined),
  });
  try {
    capture();
    await pointAt(a, b, relay.port);
    // Both sides are in auto so an unbound pair decision is LEGACY (not a
    // refusal), which is the only way a negotiated session can meet one.
    A.ctx.pairBindingMode = "auto";
    B.ctx.pairBindingMode = "auto";
    // Positive control: pass-through — the pair binds, so the session runs.
    await flowBoth({ side: a, startClients: A.startClients, stopClients: A.stopClients }, { side: b, startClients: B.startClients, stopClients: B.stopClients }, "u-s12 control");
    assert.ok(logs.some((l) => /session-bound link/.test(l)), logs.join("\n"));
    assert.equal(await pairPin(a, b.id), "1", "control: the pair bound, so A pinned B");

    // Drop the pins and the other handshake leftovers (CR pin, port memo):
    // the pair decision must be LEGACY for this leg, or the pair-binding
    // refusal would fire first and hide the session decision.
    for (const x of [a, b]) {
      await x.db.execute({ sql: "DELETE FROM dashboard_settings_overrides WHERE instance_id = ?", args: [x.id] });
    }
    assert.equal(await pairPin(a, b.id), null);
    logs = [];
    _resetPeerDialHealth();
    _resetSessionRefusalLogForTest();
    strip = true;
    await A.startClients();
    // The server negotiated `sm` (the client offered it) but the client's proof
    // carries no pair key, so the pair decision is not bound: refused before the
    // CR pin, the address backfill or a feed.
    assert.ok(await until(() => logs.some((l) => /session binding failed for/.test(l) && /server side, proof frame/.test(l) && l.endsWith(": sm_invalid")), 8000), `${dialErr(b.id)}\n${logs.join("\n")}`);
    await sleep(300);
    A.stopClients();
    assert.equal(a.mgr.hasDedicatedStream(b.id), false, "no client stream");
    assert.equal(b.mgr.hasDedicatedStream(a.id), false, "no server stream");
    assert.equal(await override(b, `tailnet_sync_cr:${a.id}`), null, "no CR pin on the refusing server");
    assert.ok(!logs.some((l) => /session-bound link/.test(l)), "never a session-bound link");
    const { m1 } = await markers(a, b, "u-s12 after");
    await sleep(500);
    assert.equal(await hasMemory(b.db, m1), false, "nothing crosses");
  } finally {
    release();
    await relay.close();
    A.stopClients(); B.stopClients();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

/* -------------------------------------------------------------- U-S10 */

test("U-S10a Noise binding: a Noise MITM after a faithful JSON phase is refused on both sides (replicate never runs, no marker crosses); control: a transparent relay passes a bound stream", async () => {
  reset();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const A = await startGateway(fleet, a, { log: LOG });
  const B = await startGateway(fleet, b, { log: LOG });
  const passRelay = await startWsRelay(B.port, {});
  const mitmRelay = await startWsRelay(B.port, { mitmNoise: true });
  const replicated = [];
  try {
    capture();
    const realReplicate = a.mgr.replicate.bind(a.mgr);
    a.mgr.replicate = (id, stream, opts) => { replicated.push(id); return realReplicate(id, stream, opts); };

    // Control: a transparent relay passes a bound stream.
    await pointAt(a, b, passRelay.port);
    await flowBoth({ side: a, startClients: A.startClients, stopClients: A.stopClients }, { side: b, startClients: B.startClients, stopClients: B.stopClients }, "u-s10 control");
    assert.ok(replicated.length > 0, "control: replicate ran");

    // A Noise MITM: each side's Noise peer key is the relay's, not the MAC'd noise_pk.
    replicated.length = 0;
    _resetPeerDialHealth();
    _resetSessionRefusalLogForTest();
    logs = [];
    await pointAt(a, b, mitmRelay.port);
    await A.startClients();
    assert.ok(await until(() => /noise_key_mismatch/.test(logs.join("\n")) || /noise_key_mismatch/.test(dialErr(b.id)), 8000), `${dialErr(b.id)} | mitmLegs=${mitmRelay.mitmLegs} bin=${mitmRelay.binaryFrames} txt=${mitmRelay.textFrames} errs=${JSON.stringify(mitmRelay.legErrors)}\n${logs.join("\n")}`);
    await sleep(300);
    A.stopClients();
    assert.ok(logs.some((l) => /session binding failed for/.test(l) && /noise frame\): noise_key_mismatch/.test(l)), logs.join("\n"));
    assert.deepEqual(replicated, [], "replicate never ran on a mismatched Noise key");
    assert.equal(a.mgr.hasDedicatedStream(b.id), false, "the client opened no stream");
    assert.equal(b.mgr.hasDedicatedStream(a.id), false, "the server opened no stream");
    const { m1 } = await markers(a, b, "u-s10 mitm");
    await sleep(500);
    assert.equal(await hasMemory(b.db, m1), false, "no marker crosses a MITM'd stream");
  } finally {
    release();
    await passRelay.close();
    await mitmRelay.close();
    A.stopClients(); B.stopClients();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

test("U-S10b a peer that never finishes Noise is refused as noise_timeout, not waited on forever", async () => {
  reset();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const A = await startGateway(fleet, a, { log: LOG });
  const B = await startGateway(fleet, b, { log: LOG });
  const dropRelay = await startWsRelay(B.port, { dropBinary: true });
  try {
    capture();
    A.ctx.noiseTimeoutMs = 300;
    await pointAt(a, b, dropRelay.port);
    await A.startClients();
    assert.ok(await until(() => /noise_timeout/.test(dialErr(b.id)), 8000), dialErr(b.id));
    await sleep(200);
    A.stopClients();
    assert.ok(logs.some((l) => /noise frame\): noise_timeout/.test(l)), logs.join("\n"));
    assert.equal(a.mgr.hasDedicatedStream(b.id), false);
  } finally {
    release();
    await dropRelay.close();
    A.stopClients(); B.stopClients();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

test("U-S10c documenting control: with NO pair key and both sides in auto the pair is unbound, so the transport DOES hand a relayed Noise stream to replication (no session check at all) — which is why auto is only a temporary state", async () => {
  reset();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const A = await startGateway(fleet, a, { log: LOG });
  const B = await startGateway(fleet, b, { log: LOG });
  const mitmRelay = await startWsRelay(B.port, { mitmNoise: true });
  const replicated = [];
  // Both sides' replicate is stubbed: hypercore binds its replication
  // capability to each stream's Noise handshake hash, so a bridged (MTIM'd)
  // stream throws inside its replicator. What this leg documents is the
  // TRANSPORT: unbound, it hands the relay's stream over (replicate is called);
  // bound, the session check refuses first and replicate is never reached.
  const stub = (x) => (id) => { replicated.push(`${x}:${id}`); return Promise.resolve(); };
  try {
    capture();
    for (const x of [a, b]) {
      await x.db.execute({ sql: "DELETE FROM dashboard_settings_overrides WHERE instance_id = ?", args: [x.id] });
      x.mgr.replicate = stub(x.id);
    }
    a.pairKeys.delete(b.id);
    b.pairKeys.delete(a.id);
    A.ctx.pairBindingMode = "auto";
    B.ctx.pairBindingMode = "auto";
    _resetPeerTrustHealth();
    await pointAt(a, b, mitmRelay.port);
    await A.startClients();
    assert.ok(await until(() => replicated.length > 0, 10_000), `no hand-off: ${logs.join("\n")}`);
    await sleep(300);
    A.stopClients();
    assert.ok(!logs.some((l) => /session binding failed|session-bound link/.test(l)), logs.join("\n"));
    assert.ok(replicated.some((t) => t.startsWith(`${a.id}:`)), "the client handed the relayed stream to replicate");
  } finally {
    release();
    await mitmRelay.close();
    A.stopClients(); B.stopClients();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});