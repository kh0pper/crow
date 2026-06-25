# Nostr relay re-subscribe hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Nostr `kind:4` subscriptions self-heal when a relay socket drops/idles, so a pi-bots crow-messages bot and the gateway's own peer/room messaging never silently stop receiving until a restart.

**Architecture:** One relay/db-agnostic primitive (`makeResilientSub`) wraps a single `relay.subscribe`, records `lastSeen`, and re-subscribes (rolling `since`) whenever the relay dropped. The caller runs ONE periodic health loop calling `ensureHealthy()` on each handle. `enablePing:true` at `Relay.connect` keeps `relay.connected` truthful (kills silent half-open sockets); `enableReconnect` stays OFF so there is exactly one app-level reconnect engine. Applied to the pi-bots adapter and `servers/sharing/nostr.js`.

**Tech Stack:** Node ESM, `nostr-tools@2.23.3`, `better-sqlite3` (adapter) / libsql (gateway), Node built-in test runner.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-25-nostr-resubscribe-hardening-design.md`.
- `enableReconnect` MUST stay off; only `enablePing:true` is added at connect sites.
- Resubscribe `since = lastSeen ? lastSeen - 120 : initialSince`; if no `initialSince` and no event seen, omit `since` entirely (preserve current full-history behavior of contact subs).
- Health interval default 45000 ms; env override `PIBOT_NOSTR_HEALTH_MS` (adapter), `CROW_NOSTR_HEALTH_MS` (gateway).
- The primitive never touches sqlite and never constructs/closes relays (caller owns relay lifecycle).
- Shared repo: a concurrent metering session works on `main`. Commit with **positional paths only**; for a NEW file, `git add <exact-path>` then `git commit <exact-path> -m`. Verify each commit with `git show --stat HEAD`.
- Tests: `node --test tests/<file>.test.js`. Gateway boot smoke: `node servers/gateway/index.js --no-auth` (ctrl-C to exit).

---

### Task 1: `makeResilientSub` primitive + unit tests

**Files:**
- Create: `servers/sharing/resilient-subscribe.js`
- Test: `tests/resilient-subscribe.test.js`

**Interfaces:**
- Produces: `makeResilientSub(relay, filter, onevent, opts = {}) → { ensureHealthy(): Promise<void>, close(): void }`
  - `relay`: a connected nostr-tools `Relay` (or a stub with `.connected`, `.subscribe(filters,{onevent,onclose})`, `async .connect()`).
  - `filter`: a Nostr filter object WITHOUT `since` (the primitive injects `since`).
  - `opts`: `{ initialSince?: number, skewSec?: number = 120, connectTimeoutMs?: number = 10000 }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/resilient-subscribe.test.js`:

```js
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

test("close() makes a later ensureHealthy a no-op (no reconnect, no resubscribe)", async () => {
  const relay = makeStubRelay();
  const h = makeResilientSub(relay, { kinds: [4] }, () => {}, {});
  h.close();
  relay.connected = false;
  await h.ensureHealthy();
  assert.equal(relay.connectCalls, 0);
  assert.equal(relay.subscribeCalls.length, 1); // only the initial subscribe
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/resilient-subscribe.test.js`
Expected: FAIL — `Cannot find module '../servers/sharing/resilient-subscribe.js'`.

- [ ] **Step 3: Write the implementation**

Create `servers/sharing/resilient-subscribe.js`:

```js
/**
 * Keep a single Nostr subscription alive across relay socket drops.
 *
 * nostr-tools' `relay.subscribe(...)` is established once and is NOT re-created
 * when the socket drops, goes idle, or the relay closes the long-lived REQ — the
 * relay keeps holding events but they never reach the handler until the process
 * restarts and re-subscribes. This wraps ONE subscribe against ONE relay and
 * re-establishes it whenever the relay reports disconnected.
 *
 * Design: the caller owns the relay lifecycle and runs a periodic health loop
 * that calls `ensureHealthy()` on each handle. Pair this with
 * `Relay.connect(url, { enablePing: true })` so a silently-dead half-open socket
 * flips `relay.connected` to false (ping timeout → ws.close) and the loop then
 * reconnects it. `enableReconnect` is intentionally left OFF — this is the single
 * app-level reconnect engine. Mirrors the reconnect-or-skip philosophy of
 * safe-relay-publish.js, on the subscribe side.
 *
 * Never touches sqlite and never constructs/closes the relay — that keeps the
 * same code usable from the pi-bots adapter (better-sqlite3) and NostrManager
 * (libsql) unchanged.
 *
 * @param {object} relay  connected nostr-tools Relay (or a stub)
 * @param {object} filter Nostr filter WITHOUT `since` (this injects `since`)
 * @param {function} onevent  called with each event (the caller dedups/decodes)
 * @param {{initialSince?:number, skewSec?:number, connectTimeoutMs?:number}} opts
 * @returns {{ensureHealthy:()=>Promise<void>, close:()=>void}}
 */
export function makeResilientSub(relay, filter, onevent, opts = {}) {
  const skewSec = opts.skewSec ?? 120;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10000;
  const initialSince = opts.initialSince ?? null;
  let lastSeen = null; // max event.created_at delivered
  let sub = null;      // current sub handle, or null if none / dropped
  let stopped = false;
  let busy = false;

  const wrapped = (event) => {
    if (event && typeof event.created_at === "number" && (lastSeen === null || event.created_at > lastSeen)) {
      lastSeen = event.created_at;
    }
    onevent(event);
  };

  function doSubscribe() {
    const since = lastSeen !== null ? lastSeen - skewSec : initialSince;
    const f = since !== null ? { ...filter, since } : { ...filter };
    try {
      sub = relay.subscribe([f], { onevent: wrapped, onclose: () => { sub = null; } });
    } catch {
      sub = null; // relay not ready; ensureHealthy retries next tick
    }
  }

  // Subscribe immediately (relay is connected at construction) so listening
  // starts right away, exactly like the pre-hardening one-shot subscribe.
  doSubscribe();

  async function ensureHealthy() {
    if (stopped || busy) return;
    busy = true;
    try {
      if (!relay.connected) {
        let to;
        try {
          await Promise.race([
            relay.connect(),
            new Promise((_, rej) => { to = setTimeout(() => rej(new Error("connect timeout")), connectTimeoutMs); }),
          ]);
        } catch {
          return; // still down → retry next tick
        } finally {
          clearTimeout(to); // don't leave the race timer dangling when connect wins
        }
      }
      if (!relay.connected) return;
      if (!sub) doSubscribe();
    } finally {
      busy = false;
    }
  }

  function close() {
    stopped = true;
    if (sub) { try { sub.close(); } catch {} sub = null; }
  }

  return { ensureHealthy, close };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/resilient-subscribe.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add servers/sharing/resilient-subscribe.js tests/resilient-subscribe.test.js
git commit servers/sharing/resilient-subscribe.js tests/resilient-subscribe.test.js \
  -m "feat(nostr): makeResilientSub — re-subscribe a dropped relay (health-loop primitive)"
git show --stat HEAD
```

---

### Task 2: pi-bots adapter — `subscribeResilient` + `enablePing` in `nostr-client.mjs`

**Files:**
- Modify: `scripts/pi-bots/gateways/nostr-client.mjs` (`connectRelays`; add `subscribeResilient`)
- Test: `tests/crow-messages-adapter.test.js` (append cases)

**Interfaces:**
- Consumes: `makeResilientSub` from `../../../servers/sharing/resilient-subscribe.js`.
- Produces: `subscribeResilient(relays, filter, onevent, opts = {}) → { handles, ensureAllHealthy(): Promise<void>, stop(): void }` where `relays` is a `Map<url, Relay>`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/crow-messages-adapter.test.js`:

```js
import { subscribeResilient } from "../scripts/pi-bots/gateways/nostr-client.mjs";

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

test("subscribeResilient builds one handle per relay and reconnects all on ensureAllHealthy", async () => {
  const a = stubRelay(); const b = stubRelay();
  const relays = new Map([["wss://a", a], ["wss://b", b]]);
  const sub = subscribeResilient(relays, { kinds: [4], "#p": ["bot"] }, () => {}, { initialSince: 10 });
  assert.equal(a.subscribeCalls.length, 1);
  assert.equal(b.subscribeCalls.length, 1);
  a.drop(); b.drop();
  await sub.ensureAllHealthy();
  assert.equal(a.subscribeCalls.length, 2);
  assert.equal(b.subscribeCalls.length, 2);
  sub.stop();
});

test("subscribeResilient.stop() closes every handle (later ensureAllHealthy is a no-op)", async () => {
  const a = stubRelay();
  const relays = new Map([["wss://a", a]]);
  const sub = subscribeResilient(relays, { kinds: [4] }, () => {}, {});
  sub.stop();
  a.drop();
  await sub.ensureAllHealthy();
  assert.equal(a.connectCalls, 0);
  assert.equal(a.subscribeCalls.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/crow-messages-adapter.test.js`
Expected: FAIL — `subscribeResilient` is not exported.

- [ ] **Step 3: Implement**

In `scripts/pi-bots/gateways/nostr-client.mjs`, add the import near the top (after the existing `safeRelayPublish` import):

```js
import { makeResilientSub } from "../../../servers/sharing/resilient-subscribe.js";
```

In `connectRelays`, enable ping at connect (the only change to that function — the `Relay.connect` call):

```js
    const relay = await Promise.race([
      Relay.connect(url, { enablePing: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("connection timeout")), timeoutMs)),
    ]);
```

Add `subscribeResilient` next to the existing `subscribe` export (keep `subscribe` — it stays for the simple/test paths):

```js
/**
 * Resilient variant of subscribe(): one self-healing handle per relay. The
 * caller drives recovery by calling ensureAllHealthy() on an interval and tears
 * down with stop(). Pair with Relay.connect(url, { enablePing: true }).
 */
export function subscribeResilient(relays, filter, onevent, opts = {}) {
  const handles = [];
  for (const [, relay] of relays) handles.push(makeResilientSub(relay, filter, onevent, opts));
  return {
    handles,
    async ensureAllHealthy() { for (const h of handles) await h.ensureHealthy(); },
    stop() { for (const h of handles) { try { h.close(); } catch {} } },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/crow-messages-adapter.test.js`
Expected: PASS (all prior cases + the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add scripts/pi-bots/gateways/nostr-client.mjs tests/crow-messages-adapter.test.js
git commit scripts/pi-bots/gateways/nostr-client.mjs tests/crow-messages-adapter.test.js \
  -m "feat(pi-bots): subscribeResilient + enablePing in nostr-client"
git show --stat HEAD
```

---

### Task 3: pi-bots adapter — wire `crow-messages.mjs` `start()/stop()` to the health loop

**Files:**
- Modify: `scripts/pi-bots/gateways/crow-messages.mjs` (`start()` and its returned `stop()`)

**Interfaces:**
- Consumes: `subscribeResilient` (Task 2).

This wires the real adapter. `start()` is integration-heavy (dynamic imports of `bridge.mjs`, `better-sqlite3`, the instance seed) and is not unit-tested today; verification is the full adapter/integration suite staying green plus a module-load smoke. The reconnect mechanism itself is covered by Tasks 1–2.

**Coverage decision (plan-review Q1):** the `start()`/`stop()` glue ships without dedicated unit coverage by deliberate choice — `start()` was never injectable and refactoring it for one test is out of scope. The residual risk is a `subs`→`subResilient` rename slip that the module-load smoke can't catch. Mitigations: (a) the implementing subagent's two-stage review MUST read `start()`/`stop()` and confirm no dangling `subs`/`subscribe` reference remains; (b) the live-verify (DM round-trips after a simulated drop, no restart) is the functional backstop.

- [ ] **Step 1: Update the import line**

In `scripts/pi-bots/gateways/crow-messages.mjs`, change the `nostr-client.mjs` import to add `subscribeResilient` and drop the now-unused `subscribe`:

```js
import { xOnly, buildDM, openDM, connectRelays, subscribeResilient, publish, makeDedupeGate } from "./nostr-client.mjs";
```

- [ ] **Step 2: Replace the one-shot subscribe with the resilient variant**

Two precise anchors in `start()`. The handler closure spans `crow-messages.mjs:122-162` and contains several nested `});`/`)` — change ONLY the two lines below.

**Opening (line 122):** replace
```js
  const subs = subscribe(relays, { kinds: [4], "#p": [botXOnly], since }, (event) => {
```
with
```js
  const subResilient = subscribeResilient(relays, { kinds: [4], "#p": [botXOnly] }, (event) => {
```
(`since` is removed from the filter — the primitive injects it; it moves into `opts` below.)

**Closing (line 162):** this is the outermost `});` that closes the `subscribe(...)` call — NOT line 161's `).catch(...)` and NOT any inner `})`. Replace the line 162
```js
  });
```
with
```js
  }, { initialSince: since });
```

The closure body (lines 123-161: dedupe gate → `markEventSeen` → `openDM` → `queue.push`) is unchanged — `(event) => { ... }` stays the 3rd arg, `{ initialSince: since }` becomes the 4th.

- [ ] **Step 3: Add the health-loop interval after the listen log line**

Immediately after `log("crow-messages bot=" + bot_id + " listening as " + ...);` add:

```js
  const healthMs = Number(process.env.PIBOT_NOSTR_HEALTH_MS) || 45000;
  const healthTimer = setInterval(() => { subResilient.ensureAllHealthy().catch(() => {}); }, healthMs);
  if (healthTimer.unref) healthTimer.unref();
```

- [ ] **Step 4: Update the returned `stop()` to tear the loop down**

Replace the returned object's `stop()` with:

```js
    stop() {
      try { clearInterval(healthTimer); } catch {}
      try { subResilient.stop(); } catch {}
      for (const [, relay] of relays) { try { relay.close(); } catch {} }
      try { db.close(); } catch {}
    },
```

- [ ] **Step 5: Verify the module loads and the suite is green**

Run: `node --input-type=module -e "import('./scripts/pi-bots/gateways/crow-messages.mjs').then(()=>console.log('LOADS OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: `LOADS OK`.

Run: `node --test tests/crow-messages-adapter.test.js tests/crow-messages-integration.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/pi-bots/gateways/crow-messages.mjs
git commit scripts/pi-bots/gateways/crow-messages.mjs \
  -m "feat(pi-bots): drive crow-messages subscribe through the resilient health loop"
git show --stat HEAD
```

---

### Task 4: gateway `nostr.js` — resilient incoming/contact subs + manager health loop

**Files:**
- Modify: `servers/sharing/nostr.js` (`constructor`, `_doConnectRelays`, `subscribeToContact`, `subscribeToIncoming`, add `_startHealthLoop`, `destroy`)
- Test: `tests/nostr-resubscribe.test.js`

**Interfaces:**
- Consumes: `makeResilientSub` from `./resilient-subscribe.js`.
- Produces: `NostrManager._healthTimer` (nullable), `NostrManager._startHealthLoop()`. `this.subscriptions` now stores `makeResilientSub` handles (each has `.close()`), so `destroy()`'s existing `sub.close()` loop still works.

- [ ] **Step 1: Write the failing test**

Create `tests/nostr-resubscribe.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/nostr-resubscribe.test.js`
Expected: FAIL — `mgr.subscriptions.get(...)` returns a raw nostr-tools sub (no `ensureHealthy`), and `mgr._healthTimer` is `undefined`.

- [ ] **Step 3: Import the primitive and init the timer field**

In `servers/sharing/nostr.js`, add after the `safeRelayPublish` import:

```js
import { makeResilientSub } from "./resilient-subscribe.js";
```

In the constructor, add after `this.onMessage = null;`:

```js
    this._healthTimer = null; // single health loop for all resilient subs
```

- [ ] **Step 4: Enable ping at connect**

In `_doConnectRelays`, change the `Relay.connect` call:

```js
        const relay = await Promise.race([
          Relay.connect(url, { enablePing: true }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("connection timeout")), 10000)
          ),
        ]);
```

- [ ] **Step 5: Add the health loop starter**

Add this method to the class (e.g. just before `subscribeToContact`):

```js
  /**
   * Start the single periodic health loop that re-establishes any resilient
   * subscription whose relay has dropped. Idempotent (created once). unref'd so
   * it never keeps the process alive on its own.
   */
  _startHealthLoop() {
    if (this._healthTimer) return;
    const ms = Number(process.env.CROW_NOSTR_HEALTH_MS) || 45000;
    this._healthTimer = setInterval(() => {
      for (const h of this.subscriptions.values()) {
        // ensureHealthy is async — a sync try/catch would NOT catch a rejected
        // promise. Wrap so a stray rejection can never become an unhandledRejection
        // (the whole point of this arc is a gateway that never silently dies).
        if (h && typeof h.ensureHealthy === "function") {
          Promise.resolve(h.ensureHealthy()).catch(() => {});
        }
      }
    }, ms);
    if (this._healthTimer.unref) this._healthTimer.unref();
  }
```

- [ ] **Step 6: Convert `subscribeToContact` to a resilient handle**

In `subscribeToContact`, replace the whole `for (const [url, relay] of this.relays) { ... this.subscriptions.set(...) ... }` block with a version that builds a handle per relay. The decrypt/cache/notify body becomes the `onevent` passed to `makeResilientSub` (unchanged logic). The contact filter has NO `since`, and no `initialSince` is passed (preserves current full-history-then-rolling behavior):

```js
    for (const [url, relay] of this.relays) {
      try {
        const onevent = async (event) => {
          try {
            const conversationKey = nip44.v2.utils.getConversationKey(
              this.identity.secp256k1Priv,
              contactPubkey
            );
            const decrypted = nip44.v2.decrypt(event.content, conversationKey);

            if (decrypted.startsWith("{")) {
              try {
                const parsed = JSON.parse(decrypted);
                if (parsed.type === "invite_accepted" || parsed.type === "crow_social") {
                  return;
                }
              } catch {
                // Not valid JSON, treat as regular message
              }
            }

            if (contactId && this.db) {
              try {
                const result = await this.db.execute({
                  sql: `INSERT OR IGNORE INTO messages (contact_id, nostr_event_id, content, direction, is_read, created_at)
                        VALUES (?, ?, ?, 'received', 0, datetime(?, 'unixepoch'))`,
                  args: [contactId, event.id, decrypted, event.created_at],
                });
                if (result.rowsAffected > 0) {
                  try {
                    await createNotification(this.db, {
                      title: `Message from ${contact.display_name || crowId}`,
                      type: "peer",
                      source: "sharing:message",
                      action_url: "/dashboard/messages",
                    });
                  } catch {}
                  try {
                    const { rows } = await this.db.execute({
                      sql: `SELECT COUNT(*) AS unread FROM messages
                            WHERE contact_id = ? AND is_read = 0 AND direction = 'received'`,
                      args: [contactId],
                    });
                    const unread = Number(rows?.[0]?.unread ?? 0);
                    bus.emit("messages:changed", { contactId, unread });
                  } catch {}
                }
              } catch {
                // Duplicate event, ignore
              }
            }

            if (this.onMessage) {
              this.onMessage(crowId, { eventId: event.id, content: decrypted, timestamp: event.created_at });
            }
          } catch (err) {
            // Decryption failed — not for us or corrupted
          }
        };
        const handle = makeResilientSub(
          relay,
          { kinds: [4], authors: [contactPubkey], "#p": [ownPubkey] },
          onevent,
          {} // no initialSince → contact subs keep their full-history-then-rolling behavior
        );
        // Close any prior resilient handle for this key before replacing it, so a
        // re-subscribe can't orphan a live sub (no longer health-driven, leaked by destroy()).
        const prev = this.subscriptions.get(`${crowId}:${url}`);
        if (prev && typeof prev.close === "function") { try { prev.close(); } catch {} }
        this.subscriptions.set(`${crowId}:${url}`, handle);
      } catch (err) {
        // Subscription failed for this relay
      }
    }
    this._startHealthLoop();
```

- [ ] **Step 7: Convert `subscribeToIncoming` to a resilient handle**

In `subscribeToIncoming`, replace the `for (const [url, relay] of this.relays) { ... this.subscriptions.set(`incoming:${url}`, sub) ... }` block with:

```js
    const incomingSince = Math.floor(Date.now() / 1000) - 86400; // Last 24h only
    for (const [url, relay] of this.relays) {
      try {
        const onevent = async (event) => {
          if (seenEventIds.has(event.id)) return;
          seenEventIds.add(event.id);
          try {
            let senderPubkey = event.pubkey;
            const conversationKey = nip44.v2.utils.getConversationKey(
              this.identity.secp256k1Priv,
              senderPubkey
            );
            const decrypted = nip44.v2.decrypt(event.content, conversationKey);
            if (decrypted.startsWith("{")) {
              try {
                const payload = JSON.parse(decrypted);
                if (payload.type === "invite_accepted" && onInviteAccepted) {
                  await onInviteAccepted(payload);
                } else if (payload.type === "crow_social" && payload.subtype && onSocialMessage) {
                  await onSocialMessage(payload.subtype, payload.payload || {}, senderPubkey);
                }
              } catch {
                // Not valid JSON or not our message type
              }
            }
          } catch (decryptErr) {
            // Decryption failed — event not for us or from unknown sender
          }
        };
        const handle = makeResilientSub(
          relay,
          { kinds: [4], "#p": [ownPubkey] },
          onevent,
          { initialSince: incomingSince }
        );
        // Close any prior resilient handle for this key before replacing it (see subscribeToContact).
        const prevIncoming = this.subscriptions.get(`incoming:${url}`);
        if (prevIncoming && typeof prevIncoming.close === "function") { try { prevIncoming.close(); } catch {} }
        this.subscriptions.set(`incoming:${url}`, handle);
      } catch {
        // Subscription failed for this relay
      }
    }
    this._startHealthLoop();
```

- [ ] **Step 8: Clear the timer in `destroy()`**

At the top of `destroy()`, before the subscription-close loop, add:

```js
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `node --test tests/nostr-resubscribe.test.js`
Expected: PASS (2 tests).

- [ ] **Step 10: Commit**

```bash
git add servers/sharing/nostr.js tests/nostr-resubscribe.test.js
git commit servers/sharing/nostr.js tests/nostr-resubscribe.test.js \
  -m "feat(sharing): resilient incoming/contact Nostr subs + manager health loop + enablePing"
git show --stat HEAD
```

---

### Task 5: Full-suite + gateway boot verification

**Files:** none (verification only)

- [ ] **Step 1: Run the touched test suites**

Run: `node --test tests/resilient-subscribe.test.js tests/crow-messages-adapter.test.js tests/crow-messages-integration.test.js tests/nostr-resubscribe.test.js tests/safe-relay-publish.test.js`
Expected: PASS, zero failures.

- [ ] **Step 2: Run the whole suite to catch regressions**

Run: `node --test tests/`
Expected: PASS (or only pre-existing unrelated failures — note any in the task summary).

- [ ] **Step 3: Gateway boot smoke**

Run: `node servers/gateway/index.js --no-auth` then ctrl-C after it logs a clean listen (watch for a `[nostr] Subscribed to incoming` line and no import/throw).
Expected: boots clean; no `resilient-subscribe` import error, no unhandled rejection.

- [ ] **Step 4: No commit** (verification only). Report results; proceed to final review + `/security-review`.

---

## Self-Review

**Spec coverage:**
- Primitive `makeResilientSub` (db/relay-agnostic, rolling since, busy/stopped guards, bounded connect) → Task 1. ✓
- `enablePing` at both connect sites → Task 2 (adapter `connectRelays`), Task 4 (`_doConnectRelays`). ✓
- `enableReconnect` stays off → never added anywhere. ✓
- Adapter wiring (subscribeResilient + health interval + stop teardown) → Tasks 2–3. ✓
- `nostr.js` `subscribeToIncoming` + `subscribeToContact` (both live) + manager health loop + destroy cleanup → Task 4. ✓
- `since = lastSeen - 120 : initialSince`; omit when neither → Task 1 impl + test "no initialSince → no since key". ✓
- Dedup safety (caller gates) → Task 1 replay test; adapter keeps `makeDedupeGate`/`markEventSeen`; incoming keeps `seenEventIds`; contact keeps `INSERT OR IGNORE`. ✓
- Tests with injected stub relays → Tasks 1, 2, 4. ✓
- Deploy/verify → handled post-plan (finishing-a-development-branch); Task 5 covers local verification. ✓
- Out-of-scope (`seenEventIds` unbounded; no `enableReconnect`) → respected. ✓

**Placeholder scan:** none — every code step is complete.

**Type consistency:** `makeResilientSub(relay, filter, onevent, opts) → {ensureHealthy, close}` used identically in Tasks 2 and 4. `subscribeResilient(...) → {handles, ensureAllHealthy, stop}` defined in Task 2, used in Task 3. `_healthTimer`/`_startHealthLoop` consistent across Task 4 steps. Health interval `45000` and skew `120` consistent with the spec.

---

## Review

**Reviewer:** Plan subagent (staff-engineer adversarial pass), 2026-06-25.
**Verdict:** REVISE → all issues addressed inline (below); ready to execute.

The reviewer verified the load-bearing claims against `nostr-tools@2.23.3` source and confirmed them: (a) with `enablePing:true` and `enableReconnect` OFF, every drop mode (clean close, RST, silent half-open via ping timeout) funnels through `handleHardClose` → `_connected=false` + `closeAllSubscriptions` → our sub's `onclose` fires (`sub=null`) — no path leaves a dead socket reporting `connected:true`; (b) `Relay.connect(url, {enablePing:true})` flows the option to the constructor and survives reconnect; (c) the `since`-omit branch is correct; (d) nothing else reads `this.subscriptions`, so storing handles is safe and `destroy()` still works.

Issues raised and resolution:
- **C1 (critical) — async rejection escapes the gateway health loop's sync `try/catch`.** FIXED: `_startHealthLoop` now wraps each call as `Promise.resolve(h.ensureHealthy()).catch(() => {})`, matching the adapter's `.catch()`. (Task 4 Step 5.)
- **S1 — stub `subscribe()` synchronous-throw is not faithful to nostr-tools.** ADDRESSED: added a fidelity note to all three stubs explaining it's a test-only model and that production never calls `doSubscribe` while disconnected (so the throw path is unreachable in prod). (Tasks 1, 2, 4.)
- **S2 — Task 3 Step 2 anchor imprecise.** FIXED: both anchors now quoted explicitly — opening line 122 and the outermost closing `});` at line 162 (not line 161's `).catch` nor any inner `})`).
- **S3 — re-subscribing a key orphans the prior resilient handle.** FIXED: `subscribeToContact`/`subscribeToIncoming` now close any existing handle for the key before `.set(...)`. (Task 4 Steps 6–7.)
- **S4 — dangling connect-timeout timer.** FIXED: `ensureHealthy` clears the race timer in a `finally`. (Task 1.)
- **Q1 — `start()`/`stop()` ships without unit coverage.** ANSWERED in Task 3: deliberate scope decision; mitigated by the two-stage implementation review reading the glue + the live-verify backstop.
- **Q2 — `enablePing` non-unref'd ping interval could hang a short-lived process.** ANSWERED: verified every `connectRelays`/`_doConnectRelays` caller runs inside a long-lived process (gateway via `managers.js`, MCP tool handlers, the pibot adapter) that closes relays on shutdown; no connect-and-exit CLI exists. Documented as a constraint for any future short-lived caller (must `destroy()`/`close()`).
