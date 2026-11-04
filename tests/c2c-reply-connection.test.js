/**
 * Z1 of the final-review fix wave: a reply goes back on the connection the frame
 * arrived on.
 *
 * `PeerManager.send(crowId, …)` writes on `connections.get(crowId)`, and that map
 * holds ONE connection per Crow id. Paired siblings share a Crow id (all of one
 * user's instances have one identity and one pinned key), so an ack or a refusal
 * sent with `send()` can reach the sibling that never asked. `_dispatchAdmitted`
 * therefore hands the receive pipeline a `meta.reply(payload)` bound to THIS
 * connection — same framing as `send()` (one `dataLine`), the cap of that
 * connection, and a no-op once it has closed.
 *
 * Harness: real PeerManagers, real key material, real admission over loopback
 * NoiseSecretStream pairs (tests/fixtures/sync-fleet.mjs's `socketPair`). Only the
 * two seams boot.js normally wires (`contactBinding`) and the pipeline's
 * `onPeerData` are stand-ins. The same Contact identity is used by BOTH sibling
 * managers, exactly as a paired Crow is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import NoiseSecretStream from "@hyperswarm/secret-stream";
import { socketPair, until, sleep } from "./fixtures/sync-fleet.mjs";
import { PeerManager } from "../servers/sharing/peer-manager.js";
import { deriveInstanceIdentity } from "../servers/sharing/identity.js";

const T = { timeout: 30_000 };

const newIdentity = () => deriveInstanceIdentity(randomBytes(32));

/**
 * A PeerManager with the contact binding boot.js installs (`lookupKey` resolves the
 * key pinned in the contact row; the cb pin predicates accept), no swarm, and an
 * `onPeerData` that records `{ crowId, payload, meta }`.
 */
function makePeer(identity, pins, localInstanceId) {
  const pm = new PeerManager(identity, { env: {} });
  pm.p2pDisabled = true; // every link here is a loopback socket pair, never the DHT
  pm.localInstanceId = localInstanceId;
  pm.contactBinding = {
    lookupKey: async (crowId) => pins[crowId] ?? null,
    isCbPinned: async () => true,
    markCbPinned: async () => {},
  };
  const received = [];
  pm.onPeerData = (crowId, payload, meta) => { received.push({ crowId, payload, meta }); };
  return { pm, identity, received };
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

/**
 * An owner and ONE contact Crow with two sibling instances (b1, b2 — the same
 * identity, so the same crowId). `first` is b1's link, `second` is b2's.
 */
async function twoSiblings(t) {
  const owner = newIdentity();
  const contact = newIdentity();
  const a = makePeer(owner, { [contact.crowId]: contact.ed25519Pubkey }, "inst-owner-1");
  const b1 = makePeer(contact, { [owner.crowId]: owner.ed25519Pubkey }, "inst-visitor-1");
  const b2 = makePeer(contact, { [owner.crowId]: owner.ed25519Pubkey }, "inst-visitor-2");
  const first = await link(t, a, b1);
  const second = await link(t, a, b2);
  return { a, b1, b2, first, second, owner, contact };
}

test("Z1: reply writes on the frame's own connection, not on connections.get(crowId)", T, async (t) => {
  const { a, b1, b2, first, second, owner, contact } = await twoSiblings(t);

  // One connection per Crow id: the sibling that connected LAST owns the map entry,
  // which is exactly the connection `send(crowId, …)` would write on.
  assert.equal(a.pm.connections.get(contact.crowId).conn, second.connA,
    "the map holds the newest sibling's connection");

  // The OLDER sibling asks.
  b1.pm.send(owner.crowId, { question: 1 });
  assert.ok(await until(() => a.received.length === 1), "the owner received the frame");
  const meta = a.received[0].meta;
  assert.equal(typeof meta.reply, "function", "the transport offers a per-connection reply (Z1)");

  assert.equal(meta.reply({ answer: 1 }), true, "the reply was written");
  assert.ok(await until(() => b1.received.length === 1), "the ASKER got the answer");
  assert.deepEqual(b1.received[0].payload, { answer: 1 },
    "same data-frame shape as send(): { type: 'data', payload }");
  await sleep(100);
  assert.equal(b2.received.length, 0, "the sibling holding the map entry got nothing");

  // The contrast: the very same payload through send() goes to the newest connection.
  a.pm.send(contact.crowId, { broadcast: 1 });
  assert.ok(await until(() => b2.received.length === 1), "send() still reaches the newest connection");
  assert.equal(b1.received.length, 1, "…and only that one");
  assert.equal(first.connA.destroyed, false, "the asker's connection is still up");
});

test("Z1: reply is a no-op once its connection has closed, and never throws", T, async (t) => {
  const { a, b1, first, second, owner, contact } = await twoSiblings(t);

  b1.pm.send(owner.crowId, { question: 2 });
  assert.ok(await until(() => a.received.length === 1), "the owner received the frame");
  const reply = a.received[0].meta.reply;

  first.connA.destroy();
  assert.ok(await until(() => first.connA.destroyed), "the destroyed stream reports it");
  assert.ok(await until(() => b1.pm.isConnected(owner.crowId) === false), "the peer side saw the close");
  await sleep(50); // let the owner's own 'close' handler set the connection state
  assert.equal(a.pm.connections.get(contact.crowId).conn, second.connA,
    "the surviving sibling still holds the map entry");

  assert.equal(reply({ answer: 2 }), false, "a closed connection takes no reply");
  assert.equal(reply({ answer: 3 }), false, "and it stays a no-op");
  await sleep(100);
  assert.equal(b1.received.length, 0, "nothing reached the closed peer");
  assert.equal(b1.pm.isConnected(owner.crowId), false, "the link really is down");
});