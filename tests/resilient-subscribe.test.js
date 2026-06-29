import { test } from "node:test";
import assert from "node:assert/strict";
import { makeResilientSub } from "../servers/sharing/resilient-subscribe.js";
import { makeDedupeGate } from "../scripts/pi-bots/gateways/nostr-client.mjs";

// Stub nostr-tools Relay. NOTE on fidelity: the real relay.subscribe() does NOT
// throw on a closed connection — it returns a sub handle and leaks an un-awaited
// rejected send(). We model "subscribe while down" as a SYNCHRONOUS throw purely
// for testability (it drives sub=null in the busy-guard test). This is safe
// because production never calls doSubscribe() while disconnected: at
// construction the relay is connected, and in ensureHealthy() the synchronous
// subscribe is gated by `if (!relay.connected) return` with no await between the
// check and the call. drop() simulates a socket loss: connected=false + fire the
// live sub's onclose. deliver() pushes an event to the latest live sub.
function makeStubRelay({ connected = true } = {}) {
  const relay = {
    connected,
    connectCalls: 0,
    subscribeCalls: [], // { filters, onevent, onclose }
    closed: false,
    _subs: [],
    subscribe(filters, { onevent, onclose }) {
      if (!relay.connected) throw new Error("subscribe on closed relay");
      relay.subscribeCalls.push({ filters, onevent, onclose });
      const sub = { onevent, onclose, closed: false, close() { this.closed = true; } };
      relay._subs.push(sub);
      return sub;
    },
    async connect() { relay.connectCalls++; relay.connected = true; },
    close() { relay.closed = true; },
    deliver(event) { const s = relay._subs[relay._subs.length - 1]; if (s && !s.closed) s.onevent(event); },
    drop() { relay.connected = false; const s = relay._subs[relay._subs.length - 1]; if (s && s.onclose) s.onclose(); },
  };
  return relay;
}

test("initial subscribe happens at construction; events reach the handler", () => {
  const relay = makeStubRelay();
  const got = [];
  makeResilientSub(relay, { kinds: [4], "#p": ["bob"] }, (e) => got.push(e.id), { initialSince: 1000 });
  assert.equal(relay.subscribeCalls.length, 1);
  assert.equal(relay.subscribeCalls[0].filters[0].since, 1000);
  relay.deliver({ id: "e1", created_at: 2000 });
  assert.deepEqual(got, ["e1"]);
});

test("drop → ensureHealthy reconnects + resubscribes + delivers a post-reconnect event", async () => {
  const relay = makeStubRelay();
  const got = [];
  const h = makeResilientSub(relay, { kinds: [4] }, (e) => got.push(e.id), { initialSince: 1000 });
  relay.deliver({ id: "e1", created_at: 2000 });
  relay.drop();
  await h.ensureHealthy();
  assert.equal(relay.connectCalls, 1);
  assert.equal(relay.subscribeCalls.length, 2);
  relay.deliver({ id: "e2", created_at: 3000 });
  assert.deepEqual(got, ["e1", "e2"]);
});

test("resubscribe since = lastSeen - 120; fresh handle with no event uses initialSince", async () => {
  const relay = makeStubRelay();
  const h = makeResilientSub(relay, { kinds: [4] }, () => {}, { initialSince: 1000 });
  relay.deliver({ id: "e1", created_at: 5000 });
  relay.drop();
  await h.ensureHealthy();
  assert.equal(relay.subscribeCalls[1].filters[0].since, 4880); // 5000 - 120

  const r2 = makeStubRelay();
  makeResilientSub(r2, { kinds: [4] }, () => {}, { initialSince: 555 });
  assert.equal(r2.subscribeCalls[0].filters[0].since, 555);
});

test("no initialSince and no event → no `since` key on the filter", () => {
  const relay = makeStubRelay();
  makeResilientSub(relay, { kinds: [4], authors: ["a"] }, () => {}, {});
  assert.equal("since" in relay.subscribeCalls[0].filters[0], false);
});

test("replay of the same event id collapses at the caller's dedupe gate", async () => {
  const relay = makeStubRelay();
  const gate = makeDedupeGate();
  const business = [];
  const h = makeResilientSub(relay, { kinds: [4] }, (e) => { if (gate(e.id)) business.push(e.id); }, { initialSince: 0 });
  relay.deliver({ id: "dup", created_at: 100 });
  relay.drop();
  await h.ensureHealthy();
  relay.deliver({ id: "dup", created_at: 100 }); // replay post-resubscribe
  assert.deepEqual(business, ["dup"]); // business callback fired once
});

test("future-dated created_at cannot poison the resubscribe `since` (clamped to now + skew)", async () => {
  const relay = makeStubRelay();
  const now = Math.floor(Date.now() / 1000);
  const skewSec = 120;
  const h = makeResilientSub(relay, { kinds: [4] }, () => {}, { initialSince: 1000, skewSec });
  // A malicious / clock-skewed event 10 days in the future.
  relay.deliver({ id: "evil", created_at: now + 10 * 86400 });
  relay.drop();
  await h.ensureHealthy();
  const since = relay.subscribeCalls[1].filters[0].since;
  // since must NOT be in the future, or the relay returns nothing → receive blackout.
  assert.ok(since <= now + skewSec, `since ${since} must be <= now+skew ${now + skewSec}`);
});

test("close() makes a later ensureHealthy a no-op (no reconnect, no resubscribe)", async () => {
  const relay = makeStubRelay();
  const h = makeResilientSub(relay, { kinds: [4] }, () => {}, {});
  h.close();
  relay.connected = false;
  await h.ensureHealthy();
  assert.equal(relay.connectCalls, 0);
  assert.equal(relay.subscribeCalls.length, 1); // only the initial subscribe
});

test("close() during an in-flight reconnect prevents a post-close resubscribe", async () => {
  const relay = makeStubRelay({ connected: false });
  let release;
  relay.connect = async () => { relay.connectCalls++; await new Promise((r) => { release = r; }); relay.connected = true; };
  const h = makeResilientSub(relay, { kinds: [4] }, () => {}, {}); // initial subscribe throws (disconnected) → sub=null
  assert.equal(relay.subscribeCalls.length, 0);
  const p = h.ensureHealthy(); // enters connect branch, awaits
  h.close();                   // teardown races the in-flight reconnect
  release();                   // connect resolves → relay.connected = true
  await p;
  assert.equal(relay.subscribeCalls.length, 0); // no resubscribe after close
});

test("overlapping ensureHealthy ticks do not double-subscribe (busy guard)", async () => {
  const relay = makeStubRelay({ connected: false });
  let release;
  relay.connect = async () => { relay.connectCalls++; await new Promise((r) => { release = r; }); relay.connected = true; };
  const h = makeResilientSub(relay, { kinds: [4] }, () => {}, {}); // initial subscribe throws (disconnected) → sub=null
  const p1 = h.ensureHealthy(); // enters, awaits connect → busy
  const p2 = h.ensureHealthy(); // busy → returns immediately
  release();
  await Promise.all([p1, p2]);
  assert.equal(relay.connectCalls, 1);          // second tick did not re-enter connect
  assert.equal(relay.subscribeCalls.length, 1); // exactly one subscribe
});
