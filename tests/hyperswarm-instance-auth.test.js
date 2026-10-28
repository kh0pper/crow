/**
 * PT-2.0 (private engineering notes, F1): the Hyperswarm instance-sync path
 * must prove the owner's key, and can be switched off.
 *
 * Sibling instances share one seed, so a genuine sibling signs our challenge
 * with OUR ed25519 key and carries OUR crowId. The instance path (feed-key
 * piggyback, in-feed key receipt, replication, liveness) is taken only then.
 * CROW_INSTANCE_SYNC_HYPERSWARM=0 turns the Hyperswarm instance path off
 * entirely; contacts and the tailnet transport are untouched.
 *
 * Drives the real PeerManager message handler with real ed25519 keys.
 * PT-3: _handleMessage is async, and a new node answers a challenge without
 * `cb` only after the asker has proven itself on that connection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { PeerManager, hyperswarmInstanceSyncEnabled } from "../servers/sharing/peer-manager.js";
import { deriveInstanceIdentity, sign } from "../servers/sharing/identity.js";
import { shouldInitInstanceSync } from "../servers/sharing/instance-sync.js";

const owner = deriveInstanceIdentity(randomBytes(32));
const stranger = deriveInstanceIdentity(randomBytes(32));
const FEED = "ab".repeat(32);

function makePm(env = {}) {
  const pm = new PeerManager(owner, { env });
  pm.p2pDisabled = false; // the suite env disables P2P; these tests drive the handler directly
  pm.localInstanceId = "instA";
  const calls = { keyReceived: [], instanceConnected: [], peerConnected: [], feedKeyAsked: [] };
  pm.onInstanceKeyReceived = (id, k) => { calls.keyReceived.push([id, k]); };
  pm.onInstanceConnected = (crowId, _c, id) => { calls.instanceConnected.push([crowId, id]); };
  pm.onPeerConnected = (crowId) => { calls.peerConnected.push(crowId); };
  pm.getFeedKeyForInstance = async (id) => { calls.feedKeyAsked.push(id); return FEED; };
  return { pm, calls };
}

function fakeConn() {
  const conn = { written: [], destroyed: false, write(s) { this.written.push(JSON.parse(s)); }, destroy() { this.destroyed = true; } };
  return conn;
}

const newState = (isInstanceConn) => ({ authenticated: false, remoteCrowId: null, isInstanceConn });
const ticks = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

/** Feed a challenge-response signed by `signer`, claiming `claims`. */
async function respond(pm, signer, claims, { isInstanceConn = true, conn = fakeConn(), state = newState(isInstanceConn), peerAuth = true } = {}) {
  const ourChallenge = randomBytes(32);
  await pm._handleMessage(conn, {
    type: "challenge-response",
    signature: sign(ourChallenge.toString("hex"), signer.ed25519Priv),
    pubkey: signer.ed25519Pubkey,
    ...claims,
  }, ourChallenge, state, () => {});
  // PT-3: the peer's own `authenticated` completes mutual admission.
  if (peerAuth) await pm._handleMessage(conn, { type: "authenticated" }, ourChallenge, state, () => {});
  await ticks();
  return conn;
}

/** Feed a challenge claiming `claims`; resolves with what we wrote back. */
async function challenge(pm, claims, { isInstanceConn = true, conn = fakeConn(), state = newState(isInstanceConn) } = {}) {
  await pm._handleMessage(conn, { type: "challenge", challenge: randomBytes(32).toString("hex"), ...claims },
    randomBytes(32), state, () => {});
  await ticks();
  return conn;
}

test("H-R1 positive control: a sibling (owner's key) gets the instance path", async () => {
  const { pm, calls } = makePm();
  const conn = await respond(pm, owner, { crowId: owner.crowId, instance_id: "instB", feed_key_hex: FEED });
  assert.equal(conn.destroyed, false);
  assert.deepEqual(calls.keyReceived, [["instB", FEED]]);
  assert.deepEqual(calls.instanceConnected, [[owner.crowId, "instB"]]);
});

test("H-R2 a stranger's key claiming our crowId and a sibling id is destroyed, no key swap, no replication", async () => {
  const { pm, calls } = makePm();
  const conn = await respond(pm, stranger, { crowId: owner.crowId, instance_id: "instB", feed_key_hex: FEED });
  assert.equal(conn.destroyed, true);
  assert.deepEqual(calls.keyReceived, []);
  assert.deepEqual(calls.instanceConnected, []);
  assert.deepEqual(calls.peerConnected, []);
});

test("H-R3 a foreign crowId on the instance topic never reaches the instance callbacks", async () => {
  const { pm, calls } = makePm();
  await respond(pm, stranger, { crowId: stranger.crowId, instance_id: "instB", feed_key_hex: FEED }, { isInstanceConn: true });
  assert.deepEqual(calls.keyReceived, []);
  assert.deepEqual(calls.instanceConnected, []);

  const out = await challenge(pm, { crowId: stranger.crowId, pubkey: stranger.ed25519Pubkey, instance_id: "instB" }, { isInstanceConn: true });
  assert.deepEqual(calls.feedKeyAsked, []);
  // PT-3: an asker without `cb` is answered only after it proves itself here.
  assert.equal(out.written.find((m) => m.type === "challenge-response"), undefined, "an unproven asker gets no reply");
});

test("H-R4 switch off: an unauthenticated peer presenting our crowId AND our pubkey gets no feed key", async () => {
  const { pm, calls } = makePm({ CROW_INSTANCE_SYNC_HYPERSWARM: "0" });
  const out = await challenge(pm, { crowId: owner.crowId, pubkey: owner.ed25519Pubkey, instance_id: "instB" });
  assert.deepEqual(calls.feedKeyAsked, []);
  assert.equal(out.written.find((m) => m.type === "challenge-response"), undefined, "an unproven asker gets no reply");
  assert.equal(out.written.some((m) => "feed_key_hex" in m || "instance_id" in m), false);
});

// Formerly a known gap (test.todo): the challenge reply piggybacked the feed
// key before the peer had proved anything. PT-3 holds that reply until the
// asker proves our key on the connection.
test("PT-2a: with the switch on, the feed key is sent only after the peer proves our key", async () => {
  // Positive control, same connection shape: a proving sibling gets the key.
  {
    const { pm, calls } = makePm();
    const conn = fakeConn();
    const state = newState(true);
    await challenge(pm, { crowId: owner.crowId, pubkey: owner.ed25519Pubkey, instance_id: "instB" }, { conn, state });
    assert.deepEqual(conn.written, [], "nothing is written before the proof");
    assert.deepEqual(calls.feedKeyAsked, []);
    await respond(pm, owner, { crowId: owner.crowId, instance_id: "instB" }, { conn, state });
    const types = conn.written.map((m) => m.type);
    assert.deepEqual(types, ["authenticated", "challenge-response"], "the reply follows admission");
    const reply = conn.written[1];
    assert.equal(reply.feed_key_hex, FEED);
    assert.equal(reply.instance_id, "instA");
    assert.equal(typeof reply.signature, "string");
    assert.deepEqual(calls.feedKeyAsked, ["instB"]);
  }
  // A stranger presenting our Crow ID and our pubkey never proves our key.
  const { pm, calls } = makePm();
  const conn = fakeConn();
  const state = newState(true);
  await challenge(pm, { crowId: owner.crowId, pubkey: owner.ed25519Pubkey, instance_id: "instB" }, { conn, state });
  await respond(pm, stranger, { crowId: owner.crowId, pubkey: owner.ed25519Pubkey, instance_id: "instB" }, { conn, state });
  assert.equal(conn.destroyed, true);
  assert.deepEqual(calls.feedKeyAsked, []);
  assert.equal(conn.written.some((m) => "feed_key_hex" in m), false, "no feed key");
});

test("H-K0 the switch: on by default, off only for \"0\"", () => {
  assert.equal(hyperswarmInstanceSyncEnabled({}), true);
  assert.equal(hyperswarmInstanceSyncEnabled({ CROW_INSTANCE_SYNC_HYPERSWARM: "1" }), true);
  assert.equal(hyperswarmInstanceSyncEnabled({ CROW_INSTANCE_SYNC_HYPERSWARM: "" }), true);
  assert.equal(hyperswarmInstanceSyncEnabled({ CROW_INSTANCE_SYNC_HYPERSWARM: "0" }), false);
});

test("H-K1 switch off: no instance-topic join, a genuine sibling is dropped, no feed key; contacts still join", async () => {
  const { pm, calls } = makePm({ CROW_INSTANCE_SYNC_HYPERSWARM: "0" });
  const joins = [];
  pm.swarm = { join(topic) { joins.push(topic); return { flushed: async () => {} }; } };

  assert.equal(await pm.joinInstanceSync({ flushedCapMs: 50 }), null);
  assert.equal(pm.instanceSyncTopic, null);
  assert.equal(joins.length, 0, "no Hyperswarm instance-sync topic join");

  const conn = await respond(pm, owner, { crowId: owner.crowId, instance_id: "instB", feed_key_hex: FEED });
  assert.equal(conn.destroyed, true);
  assert.deepEqual(calls.keyReceived, []);
  assert.deepEqual(calls.instanceConnected, []);

  const out = await challenge(pm, { crowId: owner.crowId, pubkey: owner.ed25519Pubkey, instance_id: "instB" });
  assert.deepEqual(calls.feedKeyAsked, []);
  assert.equal(out.written.find((m) => m.type === "challenge-response")?.feed_key_hex, undefined);

  await pm.joinContact({ crowId: stranger.crowId, ed25519Pubkey: stranger.ed25519Pubkey }, { flushedCapMs: 50 });
  assert.equal(joins.length, 1, "contact topics are unaffected");
});

test("H-K2 switch off leaves the tailnet transport's gate open", () => {
  // tailnet-sync (gateway post-listen) and the Hypercore feeds it replicates
  // are gated only by shouldInitInstanceSync; the Hyperswarm switch must not
  // feed into it.
  assert.equal(shouldInitInstanceSync({ argv: [], env: { CROW_INSTANCE_SYNC_HYPERSWARM: "0" } }), true);
});
