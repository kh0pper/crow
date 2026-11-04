/**
 * Per-instance PeerManager connections (the index, PI-1 … PI-10).
 *
 * All instances of one Crow share one Crow identity and one pinned key, so
 * `PeerManager.connections` (crowId -> ONE entry) could only ever name the
 * newest of them: `send(crowId, …)` reached that one, and when it closed while a
 * sibling was still up, the sibling went invisible (isConnected false, send
 * threw). The manager now keeps, next to `connections`, a bucket per crowId
 * (`peerConns`: every admitted live connection, oldest -> newest, capped at
 * maxConnsPerCrow). `connections` keeps its old meaning — "the newest live
 * connection, the contact" — so send()/isConnected(crowId)/getConnectedPeers()
 * are unchanged; `sendTo(crowId, instanceId, …)` picks the connection that
 * claimed (contact) or proved (sibling) that instance id.
 *
 * Harness (tests/c2c-reply-connection.test.js): real PeerManagers, real key
 * material, real admission over loopback NoiseSecretStream pairs; owner A and
 * two or three instances of one contact Crow (the same identity, distinct
 * claimed instance ids). Only the two seams boot.js normally wires
 * (contactBinding, onPeerData/onPeerDisconnected) are stand-ins.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import NoiseSecretStream from "@hyperswarm/secret-stream";
import { socketPair, until, sleep } from "./fixtures/sync-fleet.mjs";
import {
  PeerManager, isPeerLineOverCap, PEER_LINE_MAX_DEFAULT,
} from "../servers/sharing/peer-manager.js";
import { deriveInstanceIdentity, sign } from "../servers/sharing/identity.js";

const T = { timeout: 30_000 };
const MiB = 1024 * 1024;
const newIdentity = () => deriveInstanceIdentity(randomBytes(32));

/** A PeerManager with boot.js's contact-binding seam, no swarm, and recording callbacks. */
function makePeer(identity, pins, localInstanceId, opts = {}) {
  const pm = new PeerManager(identity, { env: {}, ...opts });
  pm.p2pDisabled = true; // every link here is a loopback socket pair, never the DHT
  pm.localInstanceId = localInstanceId; // what the challenge advertises as instance_id
  pm.contactBinding = {
    lookupKey: async (crowId) => pins[crowId] ?? null,
    isCbPinned: async () => true,
    markCbPinned: async () => {},
  };
  const received = [];
  const disconnected = [];
  pm.onPeerData = (crowId, payload, meta) => { received.push({ crowId, payload, meta }); };
  pm.onPeerDisconnected = (crowId) => disconnected.push(crowId);
  return { pm, identity, received, disconnected };
}

/** The owner A of one contact Crow C; the instances of C are separate PeerManagers. */
function scene() {
  const owner = newIdentity();
  const contact = newIdentity();
  const ownerPeer = (opts) => makePeer(owner, { [contact.crowId]: contact.ed25519Pubkey }, "inst-owner-1", opts);
  const contactPeer = (instanceId, opts) => makePeer(contact, { [owner.crowId]: owner.ed25519Pubkey }, instanceId, opts);
  return { owner, contact, ownerPeer, contactPeer };
}

/** Link two PeerManagers over one Noise socket pair; both must admit the other. */
async function link(t, a, b) {
  const [s1, s2] = await socketPair();
  const connA = new NoiseSecretStream(true, s1);
  const connB = new NoiseSecretStream(false, s2);
  connA.on("error", () => {});
  connB.on("error", () => {});
  t.after(() => {
    try { connA.destroy(); } catch { /* already gone */ }
    try { connB.destroy(); } catch { /* already gone */ }
  });
  a.pm._handleConnection(connA, {});
  b.pm._handleConnection(connB, {});
  const ok = await until(() => a.pm.isConnected(b.identity.crowId) && b.pm.isConnected(a.identity.crowId));
  assert.ok(ok, "both sides admitted each other");
  return { connA, connB };
}

test("PI-1 sendTo reaches the named instance while another holds the newest connection", T, async (t) => {
  const { contact, ownerPeer, contactPeer } = scene();
  const a = ownerPeer();
  const b1 = contactPeer("inst-visitor-1");
  const b2 = contactPeer("inst-visitor-2");
  const first = await link(t, a, b1);
  const second = await link(t, a, b2);
  assert.equal(a.pm.connections.get(contact.crowId).conn, second.connA, "b2 holds the newest connection");

  assert.equal(a.pm.sendTo(contact.crowId, "inst-visitor-1", { type: "hello", n: 1 }), true, "the named instance was written to");
  assert.ok(await until(() => b1.received.length === 1), "b1 got the frame");
  assert.deepEqual(b1.received[0].payload, { type: "hello", n: 1 });
  await sleep(100);
  assert.equal(b2.received.length, 0, "the newest connection got nothing");
  assert.equal(first.connA.destroyed, false, "the older link stayed up");
});

test("PI-2 sendTo for an absent instance returns false and writes nothing", T, async (t) => {
  const { contact, ownerPeer, contactPeer } = scene();
  const a = ownerPeer();
  const b1 = contactPeer("inst-visitor-1");
  const b2 = contactPeer("inst-visitor-2");
  await link(t, a, b1);
  await link(t, a, b2);

  assert.equal(a.pm.sendTo(contact.crowId, "inst-nobody", { type: "noop" }), false, "unknown instance id");
  assert.equal(a.pm.sendTo("crow:no-such-contact", "inst-visitor-1", { type: "noop" }), false, "unknown crowId");
  assert.equal(a.pm.sendTo(contact.crowId, "", { type: "noop" }), false, "an empty id names nobody");
  await sleep(150);
  assert.equal(b1.received.length, 0, "nothing was written");
  assert.equal(b2.received.length, 0, "nothing was written");

  // Control: the same call for a live id does write (the harness itself works).
  assert.equal(a.pm.sendTo(contact.crowId, "inst-visitor-2", { type: "noop", n: 2 }), true);
  assert.ok(await until(() => b2.received.length === 1), "the control frame arrived");
});

test("PI-3 isConnected(crowId, id) and connectedInstances track each instance", T, async (t) => {
  const { contact, ownerPeer, contactPeer } = scene();
  const a = ownerPeer();
  const b1 = contactPeer("inst-visitor-1");
  const b2 = contactPeer("inst-visitor-2");
  const first = await link(t, a, b1);
  const second = await link(t, a, b2);

  assert.equal(a.pm.isConnected(contact.crowId), true, "unchanged: the newest connection");
  assert.equal(a.pm.isConnected(contact.crowId, "inst-visitor-1"), true);
  assert.equal(a.pm.isConnected(contact.crowId, "inst-visitor-2"), true);
  assert.equal(a.pm.isConnected(contact.crowId, "inst-visitor-9"), false);
  assert.deepEqual(a.pm.connectedInstances(contact.crowId), ["inst-visitor-2", "inst-visitor-1"], "newest first");

  second.connA.destroy();
  assert.ok(await until(() => a.pm.connectedInstances(contact.crowId).length === 1), "b2 left the index");
  assert.deepEqual(a.pm.connectedInstances(contact.crowId), ["inst-visitor-1"]);
  assert.equal(a.pm.isConnected(contact.crowId, "inst-visitor-2"), false);
  assert.equal(a.pm.isConnected(contact.crowId), true, "the survivor is now the contact");
});

test("PI-4 the newest closing promotes the survivor; onPeerDisconnected fires once, only on the last", T, async (t) => {
  const { contact, ownerPeer, contactPeer } = scene();
  const a = ownerPeer();
  const b1 = contactPeer("inst-visitor-1");
  const b2 = contactPeer("inst-visitor-2");
  const first = await link(t, a, b1);
  const second = await link(t, a, b2);

  second.connA.destroy();
  assert.ok(await until(() => a.pm.connections.get(contact.crowId)?.conn === first.connA), "the survivor was promoted into connections");
  assert.equal(a.pm.isConnected(contact.crowId), true, "the contact stays connected");
  assert.deepEqual(a.pm.connectedInstances(contact.crowId), ["inst-visitor-1"]);
  assert.equal(a.pm.sendTo(contact.crowId, "inst-visitor-1", { type: "after-promotion" }), true);
  assert.ok(await until(() => b1.received.length === 1), "the promoted connection is routable");
  assert.equal(a.pm.send(contact.crowId, { type: "via-send" }), undefined, "send() follows the promotion");
  assert.ok(await until(() => b1.received.length === 2), "send() reached the promoted connection");
  await sleep(100);
  assert.deepEqual(a.disconnected, [], "a surviving instance does not fire onPeerDisconnected");

  first.connA.destroy();
  assert.ok(await until(() => a.disconnected.length === 1), "the last one closing fires it");
  await sleep(150);
  assert.deepEqual(a.disconnected, [contact.crowId], "exactly once");
  assert.equal(a.pm.isConnected(contact.crowId), false);
  assert.equal(a.pm.connections.has(contact.crowId), false);
  assert.equal(a.pm.peerConns.has(contact.crowId), false, "the empty bucket is gone");
});

test("PI-5 two connections claiming one id: the newer routes, the older again when the newer closes", T, async (t) => {
  const { contact, ownerPeer, contactPeer } = scene();
  const a = ownerPeer();
  const older = contactPeer("inst-visitor-1");
  const newer = contactPeer("inst-visitor-1"); // the same claim, a second connection
  const olderLink = await link(t, a, older);
  const newerLink = await link(t, a, newer);

  assert.deepEqual(a.pm.connectedInstances(contact.crowId), ["inst-visitor-1"], "one id, listed once");
  assert.equal(a.pm.sendTo(contact.crowId, "inst-visitor-1", { type: "while-both" }), true);
  assert.ok(await until(() => newer.received.length === 1), "the newest claim routes");
  await sleep(100);
  assert.equal(older.received.length, 0, "the older connection stayed open but unrouted");

  // R2-6: a connection being destroyed is skipped at once (the Noise streams are
  // streamx duplexes: `destroying` is set synchronously, `destroyed` a tick
  // later), so a frame sent in the same tick as the close goes to the survivor
  // instead of into a dying stream.
  newerLink.connA.destroy();
  assert.equal(a.pm.sendTo(contact.crowId, "inst-visitor-1", { type: "immediately" }), true, "the dying connection is skipped");
  assert.ok(await until(() => older.received.length === 1), "the older connection got the frame at once");
  assert.deepEqual(older.received[0].payload, { type: "immediately" });

  assert.ok(await until(() => a.pm.connections.get(contact.crowId)?.conn === olderLink.connA), "the older connection is promoted");
  assert.equal(a.pm.isConnected(contact.crowId, "inst-visitor-1"), true);
  assert.equal(a.pm.sendTo(contact.crowId, "inst-visitor-1", { type: "after-newer" }), true, "the older claim routes again");
  assert.ok(await until(() => older.received.length === 2), "and the frame arrives there");
});

test("PI-6 a connection claiming no instance id: send() reaches it, sendTo never does", T, async (t) => {
  const { contact, ownerPeer, contactPeer } = scene();
  const a = ownerPeer();
  const b1 = contactPeer("inst-visitor-1");
  const anonymous = contactPeer(null); // no instance_id in its challenge: an older peer
  await link(t, a, b1);
  const second = await link(t, a, anonymous);
  assert.equal(a.pm.connections.get(contact.crowId).conn, second.connA, "the id-less connection is the newest");

  assert.deepEqual(a.pm.connectedInstances(contact.crowId), ["inst-visitor-1"], "no null id is ever listed");
  assert.equal(a.pm.sendTo(contact.crowId, "inst-visitor-1", { type: "targeted" }), true);
  assert.ok(await until(() => b1.received.length === 1), "the id-carrying connection is routable");
  await sleep(100);
  assert.equal(anonymous.received.length, 0, "sendTo never falls back to the id-less connection");

  assert.equal(a.pm.send(contact.crowId, { type: "broadcast" }), undefined);
  assert.ok(await until(() => anonymous.received.length === 1), "send() still reaches the newest connection");
  assert.equal(a.pm.sendTo(contact.crowId, null, { type: "noop" }), false, "null names nobody");
});

test("PI-7 a claimed id routes only inside its own crowId (and only on a cb-proven connection)", T, async (t) => {
  const owner = newIdentity();
  const contactB = newIdentity();
  const contactC = newIdentity();
  const pins = { [contactB.crowId]: contactB.ed25519Pubkey, [contactC.crowId]: contactC.ed25519Pubkey };
  const a = makePeer(owner, pins, "inst-owner-1");
  const b1 = makePeer(contactB, { [owner.crowId]: owner.ed25519Pubkey }, "inst-visitor-1");
  const c1 = makePeer(contactC, { [owner.crowId]: owner.ed25519Pubkey }, "inst-visitor-1"); // the SAME id as b1
  const c2 = makePeer(contactC, { [owner.crowId]: owner.ed25519Pubkey }, "inst-c-2");
  await link(t, a, b1);
  await link(t, a, c1);
  await link(t, a, c2);

  // The claim picks a connection inside ONE crowId's bucket and never crosses to another.
  assert.equal(a.pm.sendTo(contactB.crowId, "inst-visitor-1", { type: "to-b" }), true);
  assert.ok(await until(() => b1.received.length === 1), "B's own connection got B's frame");
  assert.equal(c1.received.length, 0, "the other Crow claiming the same id got nothing");
  assert.equal(a.pm.sendTo(contactC.crowId, "inst-visitor-1", { type: "to-c" }), true);
  assert.ok(await until(() => c1.received.length === 1), "C's own connection got C's frame");
  assert.equal(a.pm.sendTo(contactB.crowId, "inst-c-2", { type: "noop" }), false, "an id only the other Crow claims does not route here");
  await sleep(100);
  assert.equal(c2.received.length, 0, "nothing leaked across the crowId");
  assert.deepEqual(a.pm.connectedInstances(contactB.crowId), ["inst-visitor-1"]);
  assert.deepEqual(a.pm.connectedInstances(contactC.crowId), ["inst-c-2", "inst-visitor-1"]);
  assert.equal(a.pm.isConnected(contactB.crowId, "inst-c-2"), false);

  // A bare-signature (older Crow) contact may CLAIM an id, but it is not proven
  // with a cb_sig, so sendTo never routes to it: only send() reaches it.
  const legacy = newIdentity();
  const a2 = makePeer(owner, { [legacy.crowId]: legacy.ed25519Pubkey }, "inst-owner-1");
  a2.pm.contactBinding.isCbPinned = async () => false; // an old contact: a bare signature admits it
  const raw = await rawLegacyContact(t, a2.pm, legacy, "inst-legacy-1");
  assert.equal(a2.pm.isConnected(legacy.crowId), true, "send() reaches it (the newest connection)");
  assert.equal(a2.pm.isConnected(legacy.crowId, "inst-legacy-1"), false, "unproven claim: sendTo does not route to it");
  assert.deepEqual(a2.pm.connectedInstances(legacy.crowId), []);
  assert.equal(a2.pm.sendTo(legacy.crowId, "inst-legacy-1", { type: "noop" }), false);
  await sleep(100);
  assert.equal(raw.frames.some((f) => f.type === "data"), false, "nothing was written for the targeted frame");
  assert.equal(a2.pm.send(legacy.crowId, { type: "data-for-legacy" }), undefined);
  assert.ok(await until(() => raw.frames.some((f) => f.type === "data")), "send() does reach it");
});

test("PI-8 the bucket is capped: the oldest connection is destroyed and leaves routing; the contact stays routable when the rest close", T, async (t) => {
  const { contact, ownerPeer, contactPeer } = scene();
  const a = ownerPeer({ maxConnsPerCrow: 2 });
  const b1 = contactPeer("inst-visitor-1");
  const b2 = contactPeer("inst-visitor-2");
  const b3 = contactPeer("inst-visitor-3");
  const first = await link(t, a, b1);
  const second = await link(t, a, b2);
  const third = await link(t, a, b3);

  assert.ok(await until(() => first.connA.destroyed === true), "the oldest connection is DESTROYED at the cap, not left open");
  assert.ok(await until(() => a.pm.connectedInstances(contact.crowId).length === 2), "and it left the index");
  assert.deepEqual(a.pm.connectedInstances(contact.crowId), ["inst-visitor-3", "inst-visitor-2"]);
  assert.equal(a.pm.sendTo(contact.crowId, "inst-visitor-1", { type: "noop" }), false, "the evicted instance is not routable");
  assert.equal(b1.received.length, 0);

  // The evicted connection's own close is a no-op: it must not knock the
  // survivors out of routing (the bug this index exists to prevent).
  await sleep(150);
  assert.equal(a.pm.isConnected(contact.crowId), true);
  assert.equal(a.pm.sendTo(contact.crowId, "inst-visitor-2", { type: "still-here-2" }), true);
  assert.equal(a.pm.sendTo(contact.crowId, "inst-visitor-3", { type: "still-here-3" }), true);
  assert.ok(await until(() => b2.received.length === 1 && b3.received.length === 1), "both survivors are routable");
  assert.equal(a.pm.send(contact.crowId, { type: "newest" }), undefined);
  assert.ok(await until(() => b3.received.length === 2), "send() reaches the newest");

  second.connA.destroy();
  assert.ok(await until(() => a.pm.connectedInstances(contact.crowId).length === 1));
  assert.equal(a.pm.isConnected(contact.crowId), true, "one survivor keeps the contact connected");
  assert.equal(a.pm.sendTo(contact.crowId, "inst-visitor-3", { type: "last-one" }), true);
  assert.ok(await until(() => b3.received.length === 3), "the capped contact is still routable");

  third.connA.destroy();
  assert.ok(await until(() => a.disconnected.length === 1), "only the last close fires onPeerDisconnected");
  await sleep(150);
  assert.deepEqual(a.disconnected, [contact.crowId]);
  assert.equal(a.pm.isConnected(contact.crowId), false);
  assert.equal(a.pm.peerConns.has(contact.crowId), false);
});

test("PI-9 sendTo honours that connection's line_max", T, async (t) => {
  const { contact, ownerPeer, contactPeer } = scene();
  const a = ownerPeer();
  const b1 = contactPeer("inst-visitor-1", { env: { CROW_PEER_LINE_MAX_BYTES: String(MiB) } }); // advertises 1 MiB
  const b2 = contactPeer("inst-visitor-2"); // advertises the default cap
  await link(t, a, b1);
  await link(t, a, b2);

  assert.equal(a.pm.lineMaxFor(contact.crowId, "inst-visitor-1"), MiB, "the 1 MiB peer's cap");
  assert.equal(a.pm.lineMaxFor(contact.crowId, "inst-visitor-2"), PEER_LINE_MAX_DEFAULT);
  assert.equal(a.pm.lineMaxFor(contact.crowId), PEER_LINE_MAX_DEFAULT, "no instance: the newest connection's cap");

  const over = { pad: "x".repeat(MiB + 16) }; // a line over 1 MiB, under our own cap
  assert.throws(() => a.pm.sendTo(contact.crowId, "inst-visitor-1", over), (e) => isPeerLineOverCap(e) && e.cap === MiB);
  await sleep(100);
  assert.equal(b1.received.length, 0, "nothing was written to the capped peer");
  assert.equal(a.pm.sendTo(contact.crowId, "inst-visitor-2", over), true, "the same frame fits the other instance");
  assert.ok(await until(() => b2.received.length === 1), "and arrives there");
  assert.equal(b1.received.length, 0);
});

test("PI-10 leaveContact destroys every instance and clears both maps; destroy() clears the index", T, async (t) => {
  const { contact, ownerPeer, contactPeer } = scene();
  const a = ownerPeer();
  const b1 = contactPeer("inst-visitor-1");
  const b2 = contactPeer("inst-visitor-2");
  const first = await link(t, a, b1);
  const second = await link(t, a, b2);

  await a.pm.leaveContact(contact.crowId);
  assert.ok(await until(() => first.connA.destroyed && second.connA.destroyed), "every instance's connection was destroyed");
  assert.equal(a.pm.connections.has(contact.crowId), false);
  assert.equal(a.pm.peerConns.has(contact.crowId), false);
  assert.equal(a.pm.isConnected(contact.crowId), false);
  assert.equal(a.pm.sendTo(contact.crowId, "inst-visitor-1", { type: "noop" }), false);
  await sleep(100);
  assert.deepEqual(a.disconnected, [], "leaving is not a per-connection close");

  const b3 = contactPeer("inst-visitor-3");
  await link(t, a, b3);
  await a.pm.destroy();
  assert.equal(a.pm.connections.size, 0);
  assert.equal(a.pm.peerConns.size, 0);
});

/**
 * A raw peer that admits as an OLD Crow contact: it claims `claimed` as its
 * instance id and answers the owner's challenge with a BARE signature (no
 * cb_sig), which only a contact whose pin is not cb-pinned accepts.
 */
async function rawLegacyContact(t, pm, peerIdentity, claimed) {
  const [s1, s2] = await socketPair();
  const ours = new NoiseSecretStream(true, s1);
  const raw = new NoiseSecretStream(false, s2);
  ours.on("error", () => {});
  raw.on("error", () => {});
  t.after(() => {
    try { ours.destroy(); } catch { /* already gone */ }
    try { raw.destroy(); } catch { /* already gone */ }
  });
  const frames = [];
  let buf = "";
  raw.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const l of lines) if (l.trim()) { try { frames.push(JSON.parse(l)); } catch { /* junk */ } }
  });
  pm._handleConnection(ours, {});
  assert.ok(await until(() => frames.some((f) => f.type === "challenge")), "the owner challenged us");
  const ch = frames.find((f) => f.type === "challenge");
  await raw.opened;
  raw.write(JSON.stringify({
    type: "challenge", challenge: randomBytes(32).toString("hex"),
    crowId: peerIdentity.crowId, pubkey: peerIdentity.ed25519Pubkey, instance_id: claimed,
  }) + "\n");
  raw.write(JSON.stringify({
    type: "challenge-response", crowId: peerIdentity.crowId, pubkey: peerIdentity.ed25519Pubkey,
    signature: sign(ch.challenge, peerIdentity.ed25519Priv),
  }) + "\n");
  raw.write(JSON.stringify({ type: "authenticated" }) + "\n");
  assert.ok(await until(() => pm.isConnected(peerIdentity.crowId)), "the bare-signature contact was admitted");
  return { frames, raw };
}