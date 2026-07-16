import { test } from "node:test";
import assert from "node:assert/strict";
import { makeResilientSub } from "../servers/sharing/resilient-subscribe.js";
import { subscribe } from "../scripts/pi-bots/gateways/nostr-client.mjs";
import { handleRejection, installNostrCrashGuard, uninstallNostrCrashGuard } from "../servers/sharing/nostr-crash-guard.js";

// 2c-F1 crash class: nostr-tools' AbstractRelay.send() is ASYNC and throws
// SendingOnClosedConnection when the socket dropped; Subscription.fire() calls
// it without await/catch, so the throw is an ORPHANED rejection — invisible to
// any try/catch around subscribe(), fatal under Node's default
// --unhandled-rejections=throw. Stub fidelity is load-bearing: subscribe() on
// a dropped relay must return a sub handle AND leak an un-awaited rejection
// (a synchronous throw is caught by the existing try/catch and makes these
// tests vacuously green against unguarded code).
function makeAsyncThrowRelay({ connected = false } = {}) {
  const relay = {
    connected,
    connectCalls: 0,
    subscribeCalls: 0,
    subscribe(filters, handlers) {
      relay.subscribeCalls++;
      if (!relay.connected) {
        void (async () => { throw Object.assign(new Error("closed"), { name: "SendingOnClosedConnection" }); })();
      }
      return { onevent: handlers?.onevent, close() {} };
    },
    async connect() { relay.connectCalls++; relay.connected = true; },
  };
  return relay;
}

test("G-F1-1: construction on a dropped relay leaks no rejection, skips subscribe; ensureHealthy heals", async () => {
  const relay = makeAsyncThrowRelay({ connected: false });
  const unhandled = [];
  const onUR = (err) => unhandled.push(err);
  process.on("unhandledRejection", onUR);
  try {
    const h = makeResilientSub(relay, { kinds: [4] }, () => {}, { initialSince: 0 });
    await new Promise((r) => setImmediate(r)); // let any orphaned rejection surface
    assert.equal(unhandled.length, 0, `orphaned rejection escaped doSubscribe: ${unhandled[0]?.name}`);
    assert.equal(relay.subscribeCalls, 0, "guard must skip subscribe on a dropped relay");
    relay.connected = true;
    await h.ensureHealthy();
    assert.equal(relay.subscribeCalls, 1, "subscription heals once the relay is connected");
    h.close();
  } finally {
    process.off("unhandledRejection", onUR);
  }
});

// G-F1-2 is the mutation check on G-F1-1: comment out the connected guard in
// resilient-subscribe.js doSubscribe() → G-F1-1 goes red via the rejection
// capture (performed and recorded at build time, not encoded as a test).

test("G-F1-3: handleRejection swallows only the nostr close-race name; install is idempotent", () => {
  const before = process.listenerCount("unhandledRejection");
  try {
    assert.equal(handleRejection(Object.assign(new Error("closed"), { name: "SendingOnClosedConnection" })), true);
    assert.equal(handleRejection(new Error("boom")), false, "unknown errors must be rethrown by the caller");
    assert.equal(handleRejection(undefined), false);
    // NEVER emit a real process 'unhandledRejection' here — the installed
    // listener rethrows unknowns and would fight the node:test runner.
    installNostrCrashGuard();
    installNostrCrashGuard();
    assert.equal(process.listenerCount("unhandledRejection"), before + 1, "double install must register exactly one listener");
  } finally {
    uninstallNostrCrashGuard();
  }
  assert.equal(process.listenerCount("unhandledRejection"), before, "uninstall must remove the listener");
});

test("G-F1-4: raw pi-bots subscribe() skips dropped relays, preserves fan-out, leaks no rejection", async () => {
  const up = makeAsyncThrowRelay({ connected: true });
  const down = makeAsyncThrowRelay({ connected: false });
  const relays = new Map([["wss://up.example", up], ["wss://down.example", down]]);
  const unhandled = [];
  const onUR = (err) => unhandled.push(err);
  process.on("unhandledRejection", onUR);
  try {
    const subs = subscribe(relays, { kinds: [4] }, () => {});
    await new Promise((r) => setImmediate(r));
    assert.equal(unhandled.length, 0, `orphaned rejection escaped raw subscribe: ${unhandled[0]?.name}`);
    assert.equal(up.subscribeCalls, 1, "connected relay still subscribed (fan-out preserved)");
    assert.equal(down.subscribeCalls, 0, "dropped relay skipped");
    assert.equal(subs.length, 1);
  } finally {
    process.off("unhandledRejection", onUR);
  }
});
