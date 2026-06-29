import { test } from "node:test";
import assert from "node:assert/strict";
import { NostrManager } from "../servers/sharing/nostr.js";

// subscribe() throws synchronously when down — a test-only model (real
// nostr-tools leaks an un-awaited rejection instead); production never subscribes
// while disconnected. See tests/resilient-subscribe.test.js for the full note.
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
    drop() { r.connected = false; const s = r._subs[r._subs.length - 1]; if (s && s.onclose) s.onclose(); },
  };
  return r;
}

const identity = { secp256k1Pubkey: "a".repeat(64), secp256k1Priv: new Uint8Array(32) };

test("subscribeToIncoming registers a resilient handle that resubscribes after a drop", async () => {
  const mgr = new NostrManager(identity, null);
  const relay = stubRelay();
  mgr.relays.set("wss://stub", relay); // pre-populate so connectRelays() is a no-op
  await mgr.subscribeToIncoming(async () => {}, async () => {});
  assert.equal(relay.subscribeCalls.length, 1);
  const handle = mgr.subscriptions.get("incoming:wss://stub");
  assert.ok(handle && typeof handle.ensureHealthy === "function");

  relay.drop();
  await handle.ensureHealthy();
  assert.equal(relay.connectCalls, 1);
  assert.equal(relay.subscribeCalls.length, 2);

  await mgr.destroy();
  assert.equal(mgr._healthTimer, null);
  assert.equal(relay.closed, true);
});

test("subscribeToContact registers a resilient handle (no `since` on first subscribe)", async () => {
  const mgr = new NostrManager(identity, null);
  const relay = stubRelay();
  mgr.relays.set("wss://stub", relay);
  await mgr.subscribeToContact({ id: 1, crow_id: "crow:c", secp256k1_pubkey: "b".repeat(64), display_name: "C" });
  assert.equal(relay.subscribeCalls.length, 1);
  assert.equal("since" in relay.subscribeCalls[0].filters[0], false);
  const handle = mgr.subscriptions.get("crow:c:wss://stub");
  assert.ok(handle && typeof handle.ensureHealthy === "function");
  await mgr.destroy();
});
