/**
 * nostr.js receive-health hooks — R7. _doConnectRelays mirrors relay count;
 * a successful decrypt stamps lastInboundAt; a failed decrypt increments the
 * L8 counter. Uses stubRelay (tests/nostr-resubscribe.test.js pattern) with
 * real NIP-44 crypto so the decrypt paths genuinely run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getPublicKey, nip44 } from "nostr-tools";
import { NostrManager } from "../servers/sharing/nostr.js";
import { getReceiveHealth, _resetReceiveHealth } from "../servers/sharing/receive-health.js";

function stubRelay({ connected = true } = {}) {
  const r = {
    connected, connectCalls: 0, subscribeCalls: [], _subs: [], closed: false,
    subscribe(filters, { onevent, onclose }) {
      if (!r.connected) throw new Error("closed");
      r.subscribeCalls.push({ filters, onevent, onclose });
      const s = { onevent, onclose, closed: false, close() { this.closed = true; } };
      r._subs.push(s); return s;
    },
    async connect() { r.connectCalls++; r.connected = true; },
    close() { r.closed = true; },
  };
  return r;
}

// Fixed valid secp256k1 scalars (both < curve order) — deterministic keypairs.
const ourPriv = new Uint8Array(32).fill(1);
const theirPriv = new Uint8Array(32).fill(2);
const ourPub = getPublicKey(ourPriv);     // 64-hex x-only
const theirPub = getPublicKey(theirPriv);
const identity = { secp256k1Pubkey: ourPub, secp256k1Priv: ourPriv };

function encryptToUs(plaintext) {
  const convKey = nip44.v2.utils.getConversationKey(theirPriv, ourPub);
  return nip44.v2.encrypt(plaintext, convKey);
}

test("_doConnectRelays mirrors relay count into receive-health", async () => {
  _resetReceiveHealth();
  const mgr = new NostrManager(identity, null);
  // Empty custom relay list: connect loop runs, 0 connect, mirror hook fires.
  await mgr.connectRelays([]);
  assert.equal(getReceiveHealth().relaysConnected, 0);
  await mgr.destroy();
});

test("subscribeToContact: successful decrypt stamps lastInboundAt", async () => {
  _resetReceiveHealth();
  const mgr = new NostrManager(identity, null);
  mgr._sendDeliveryReceipt = async () => {}; // keep the R5 ack out of the way
  const relay = stubRelay();
  mgr.relays.set("wss://stub", relay);
  await mgr.subscribeToContact({ id: null, crow_id: "crow:t", secp256k1_pubkey: theirPub, display_name: "T" });
  assert.equal(getReceiveHealth().lastInboundAt, null);
  await relay.subscribeCalls[0].onevent({
    id: "e1", pubkey: theirPub, created_at: 1_700_000_000, content: encryptToUs("hello"),
  });
  assert.notEqual(getReceiveHealth().lastInboundAt, null);
  assert.equal(getReceiveHealth().decryptFailures, 0);
  await mgr.destroy();
});

test("subscribeToContact: failed decrypt increments decryptFailures, no inbound stamp", async () => {
  _resetReceiveHealth();
  const mgr = new NostrManager(identity, null);
  const relay = stubRelay();
  mgr.relays.set("wss://stub", relay);
  await mgr.subscribeToContact({ id: null, crow_id: "crow:t", secp256k1_pubkey: theirPub, display_name: "T" });
  await relay.subscribeCalls[0].onevent({
    id: "e2", pubkey: theirPub, created_at: 1_700_000_000, content: "not-nip44-garbage",
  });
  assert.equal(getReceiveHealth().decryptFailures, 1);
  assert.equal(getReceiveHealth().lastInboundAt, null);
  await mgr.destroy();
});

test("subscribeToIncoming: decrypt stamps inbound; garbage increments counter", async () => {
  _resetReceiveHealth();
  const mgr = new NostrManager(identity, null);
  const relay = stubRelay();
  mgr.relays.set("wss://stub", relay);
  await mgr.subscribeToIncoming(async () => {}, async () => {}, async () => {});
  await relay.subscribeCalls[0].onevent({
    id: "e3", pubkey: theirPub, created_at: 1_700_000_000, content: encryptToUs("plain hi"),
  });
  assert.notEqual(getReceiveHealth().lastInboundAt, null);
  await relay.subscribeCalls[0].onevent({
    id: "e4", pubkey: theirPub, created_at: 1_700_000_001, content: "garbage",
  });
  assert.equal(getReceiveHealth().decryptFailures, 1);
  await mgr.destroy();
});
