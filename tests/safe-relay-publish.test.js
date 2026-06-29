import { test } from "node:test";
import assert from "node:assert/strict";
import { safeRelayPublish } from "../servers/sharing/safe-relay-publish.js";

/**
 * Models the failure mode that crashed the crow-mpa gateway: nostr-tools'
 * Relay.publish() fires Relay.send() WITHOUT awaiting it. When the relay's
 * WebSocket has dropped (connected === false / connectionPromise === null),
 * send() rejects with SendingOnClosedConnection — a rejection that escapes the
 * caller's try/catch (it is not the promise publish() returns) and, under
 * Node's default --unhandled-rejections=throw, terminates the process.
 *
 * safeRelayPublish must NEVER call publish() on a relay that is not connected.
 */
function fakeRelay({ connected = true, reconnectsTo = null } = {}) {
  return {
    connected,
    publishCalls: 0,
    connectCalls: 0,
    async connect() {
      this.connectCalls++;
      if (reconnectsTo !== null) this.connected = reconnectsTo;
    },
    async publish() {
      this.publishCalls++;
      // Mirror nostr-tools: a closed relay would leak an unhandled rejection
      // from the un-awaited send(). If safeRelayPublish ever calls us while
      // disconnected, fail loudly so the test catches the regression.
      if (!this.connected) throw new Error("publish() called on a closed relay");
      return { id: "ev" };
    },
  };
}

test("safeRelayPublish publishes when the relay is connected", async () => {
  const relay = fakeRelay({ connected: true });
  const ok = await safeRelayPublish(relay, { id: "e" });
  assert.equal(ok, true);
  assert.equal(relay.publishCalls, 1);
  assert.equal(relay.connectCalls, 0); // already connected → no reconnect
});

test("safeRelayPublish SKIPS a closed relay that fails to reconnect — never calls publish()", async () => {
  const relay = fakeRelay({ connected: false, reconnectsTo: false });
  const ok = await safeRelayPublish(relay, { id: "e" });
  assert.equal(ok, false);
  assert.equal(relay.connectCalls, 1); // attempted reconnect
  assert.equal(relay.publishCalls, 0); // but never published on the closed relay (the crash trigger)
});

test("safeRelayPublish reconnects a dropped relay, then publishes", async () => {
  const relay = fakeRelay({ connected: false, reconnectsTo: true });
  const ok = await safeRelayPublish(relay, { id: "e" });
  assert.equal(ok, true);
  assert.equal(relay.connectCalls, 1);
  assert.equal(relay.publishCalls, 1);
});

test("safeRelayPublish swallows a reconnect() that throws and skips publish", async () => {
  const relay = {
    connected: false,
    publishCalls: 0,
    async connect() { throw new Error("connection timed out"); },
    async publish() { this.publishCalls++; },
  };
  const ok = await safeRelayPublish(relay, { id: "e" });
  assert.equal(ok, false);
  assert.equal(relay.publishCalls, 0);
});
