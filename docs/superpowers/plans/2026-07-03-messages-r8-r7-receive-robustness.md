# Messages R8 + R7 — Never Run Deaf + Messages Health Signal (Phase 1 close)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Nostr DM receive path is wired **unconditionally at boot** — a `peerManager.start()` (Hyperswarm) rejection can no longer leave the gateway silently deaf (L11) — and a new `messages` nest health signal makes the receive path observable (R7/L8 + R3's residual relay-state), warning loudly (nest + notification) when Crow isn't receiving or has zero relays, while a quiet mailbox never false-alarms.

**Architecture:** Three pieces. (1) **`receive-health.js`** — a new pure per-process state module in `servers/sharing/` (the `isAuditDegraded()` precedent from `servers/shared/cross-host-auth.js:306`): `{ receiveWired, lastError, relaysConnected, lastInboundAt, decryptFailures }`, written by the sharing layer, read by the gateway with a **plain import** (never instantiating the sharing client — the QW2 live-socket trap). (2) **Boot split** — the Nostr wiring (per-contact `subscribeToContact` + the broad `subscribeToIncoming` with its full handler ladder) moves out of `peerManager.start().then()` into an exported `wireNostrReceive(managers)`, driven by `startNostrReceive(managers)` which sets `receiveWired` and retries failed wiring on bounded backoff (15s → 30s → … → 5min cap, unref'd). The `.then()` block keeps only the genuinely-Hyperswarm work (DHT `joinContact` + instance-sync feeds). (3) **`messagesSignal(db)`** — a new collector in `health-signals.js` wired into `collectHealthSignals`, so the existing `post-listen.js` health-monitor loop renders it in the nest **and** pushes a notification on warn with zero new plumbing. Warn ONLY on `receiveWired === false` or `relaysConnected === 0`; inbound age / pending-outbound / decrypt-failures are display-only.

**Tech Stack:** Node ESM, `@libsql/client`, `nostr-tools` (NIP-44, kind:4), Node built-in test runner. No new dependencies. **No schema change → NO `SCHEMA_GENERATION` bump** (stays 3); plain-restart deploy.

## Global Constraints

- **Commit with a positional path arg**: `git commit <path> -m "..."`, never `git add <path> && git commit` (bare). For NEW files, `git add <thatpath>` first, then `git commit <thatpath> ... -m`. Verify with `git show --stat HEAD` after each commit. Substantial untracked WIP in the tree (`bundles/`, `bots/`, `scripts/`) must never be swept.
- **`git pull --rebase` before any push** — parallel sessions push to `main`.
- **Never attribute Claude as a co-author**; never add Claude as a contributor.
- **Tests**: `node --test tests/<file>.test.js`. Full suite must stay green (`node --test tests/` — 961/961 on `main` as of `5f8356f1`; this plan adds 21: 5 receive-health + 4 hooks + 5 decouple + 7 signal).
- **No schema migration in this plan.** Do NOT touch `servers/shared/schema-version.js` or `scripts/init-db.js`.
- **Never throw on the receive path**: `onevent` closures and everything they call stay throw-proof. New health-module calls inside `onevent` must be bare synchronous one-liners on a module that cannot throw.
- **Never instantiate the sharing client from gateway code** — `health-signals.js` may import ONLY the new pure `receive-health.js` from `servers/sharing/` (no `nostr.js`, no `boot.js`): transitively importing the live client spins up relay sockets that keep the process alive (hung the suite 44 min pre-QW2).
- **False-alarm discipline (load-bearing for R7):** a quiet mailbox is normal — inbound age NEVER warns; queued outbound retries (an offline recipient) NEVER warn; `receiveWired === null` (never attempted / sharing disabled) is `off`, not an issue.
- **Trust boundary unchanged**: this plan moves code and adds observability; it must NOT alter the L6/R4/R5 semantics (request_status gating, promotion, receipts).
- Branch: `feat/messages-r8-r7-receive-robustness` (spec commit `a67c2eff` is its base). Design spec: `docs/superpowers/specs/2026-07-03-messages-r8-r7-receive-robustness-design.md`.

---

## Background — the exact code being changed (verified @ `main` 5f8356f1)

**The L11 hole.** `servers/sharing/boot.js` `initSharingRuntime(managers, helpers)` (`boot.js:321`) destructures `{ db, identity, peerManager, syncManager, instanceSyncManager, nostrManager }`. At `boot.js:335` it runs `peerManager.start().then(async () => { ... })` containing, in order: (a) a contacts query + per-contact loop (`boot.js:337–380`) that routes on `request_status` — `'pending'` → skip; `'accepted'` → `nostrManager.subscribeToContact(...)` only; `NULL` (full) → `syncManager.initContact` + `peerManager.joinContact` + `nostrManager.subscribeToContact`; (b) `nostrManager.subscribeToIncoming(onInviteAccepted, onSocialMessage, onMessageRequest)` (`boot.js:384–516`) with the big `if (subtype === ...)` handler ladder (room_invite/room_closed/voice_memo/reaction/group_message/bot_relay/bot_relay_result/delivery_receipt/room_message|room_join) and the L6 `onMessageRequest` fallback; (c) `peerManager.joinInstanceSync()` + instance-sync feed init (`boot.js:520–545`). The terminal `.catch` (`boot.js:546–548`) only `console.warn`s — **if Hyperswarm `start()` rejects, (a)+(b) never run and the gateway receives no DMs until restart, silently.** PR #115's `makeResilientSub`/`ensureHealthy` self-heal only repairs subs that were *created*; it cannot help when the creation code never ran.

**Nostr internals to hook.** `NostrManager` (`servers/sharing/nostr.js`): `_doConnectRelays(customRelays)` populates `this.relays` (Map url→Relay) and returns `[...this.relays.keys()]` (`nostr.js:92–124`). `subscribeToContact(contact)`'s `onevent` decrypts at `nostr.js:343` (`const decrypted = nip44.v2.decrypt(...)`), early-returns on `invite_accepted`/`crow_social` (`:348–350`), stores/acks, with the decrypt-failure catch at `:395–397` (`// Decryption failed — not for us or corrupted`). `subscribeToIncoming(...)`'s `onevent` decrypts at `nostr.js:497`, with its decrypt-failure catch at `:540–542` (`catch (decryptErr)`). Both build subs via `makeResilientSub` and register in `this.subscriptions`; `subscribeToContact` calls `await this.connectRelays()` first (`:323`), as does `subscribeToIncoming` (`:477`). Re-running either subscribe replaces + closes any prior handle for the same key (idempotent, safe for retry). `connectRelays` is never-throw on config (falls back to `DEFAULT_RELAYS`, `nostr.js:569–581`) but individual relay connects can all fail, yielding `relays.size === 0` without throwing.

**Health-signal pattern (W2).** `servers/gateway/dashboard/panels/nest/health-signals.js`: each collector returns `{ id, severity, state, label, value, issueLabel?, actionLabel?, actionHref? }`; `state` ∈ `ok|info|warn|off`; collectors are assembled in the `collectHealthSignals` `Promise.all` array (`health-signals.js:597–616`) with a per-collector `.catch` → `state:"off"` wrapper; results cached 30 s (`invalidateHealthCache()` in tests). `severity:"warn"` issues get pushed as notifications by the monitor loop in `servers/gateway/boot/post-listen.js:210–…` (24h dedupe via `shouldNotify`, incident-scoped reset via `pruneResolved`). The module-shape precedent for cross-layer per-process state is `isAuditDegraded()` (`servers/shared/cross-host-auth.js:306`), already imported by `federationAuditSignal` (`health-signals.js:27,562`). i18n strings live in `servers/gateway/dashboard/shared/i18n.js` as `"signals.<id>.<key>": { en, es }` (see `signals.federationAudit.*` at `i18n.js:200–204`).

**Pending-outbound source.** `message_retry_queue` (R5, `scripts/init-db.js`) — one row per unacked outbound DM; rows clear on delivery ack or ~60h expiry. `SELECT COUNT(*)` is the display-only backlog.

**Test scaffolding to reuse.** `tests/nostr-resubscribe.test.js` has `stubRelay()` (fake Relay with `subscribe/connect/close/drop`, records `subscribeCalls`) and the pre-populate trick `mgr.relays.set("wss://stub", relay)` so `connectRelays()` no-ops. `tests/health-signals.test.js` has the `makeDb()` stub + `invalidateHealthCache()` pattern. `tests/delivery-receipt-emit.test.js` shows method-stubbing on a real `NostrManager` (null db).

---

## File Structure

- **Create** `servers/sharing/receive-health.js` — pure per-process receive-path health state. Exports: `setReceiveWired`, `setRelaysConnected`, `markInbound`, `markDecryptFailure`, `getReceiveHealth`, `_resetReceiveHealth`. **Zero imports** (safe for gateway to import).
- **Modify** `servers/sharing/nostr.js` — 4 one-line hooks: `setRelaysConnected` in `_doConnectRelays`; `markInbound` after each successful decrypt (×2); `markDecryptFailure` in each decrypt-failure catch (×2).
- **Modify** `servers/sharing/boot.js` — new exported `wireNostrReceive(managers)` + `startNostrReceive(managers, opts)`; `initSharingRuntime` calls `startNostrReceive` before `peerManager.start()`; the `.then()` block loses the Nostr wiring and keeps DHT/sync only.
- **Modify** `servers/gateway/dashboard/panels/nest/health-signals.js` — `messagesSignal(db, lang, nowFn)` + entry in `collectHealthSignals`.
- **Modify** `servers/gateway/dashboard/shared/i18n.js` — `signals.messages.*` strings EN + ES.
- **Create** tests: `tests/receive-health.test.js`, `tests/nostr-receive-health-hooks.test.js`, `tests/boot-receive-decouple.test.js`, `tests/messages-health-signal.test.js`.

---

## Task 1: `receive-health.js` + `nostr.js` hooks

**Files:**
- Create: `servers/sharing/receive-health.js`
- Modify: `servers/sharing/nostr.js` (import + 4 hook lines)
- Test: `tests/receive-health.test.js`, `tests/nostr-receive-health-hooks.test.js`

**Interfaces:**
- Produces (Tasks 2–3 rely on these exact names):
  - `setReceiveWired(ok: boolean, err?: Error|string)` — sets `receiveWired` to `!!ok`; on failure records `lastError` (message string), on success clears it.
  - `setRelaysConnected(n: number)`
  - `markInbound(nowMs?: number)` — default `Date.now()`.
  - `markDecryptFailure()` — increments the L8 counter.
  - `getReceiveHealth() → { receiveWired: boolean|null, lastError: string|null, relaysConnected: number, lastInboundAt: number|null, decryptFailures: number }` (a copy, never the live object).
  - `_resetReceiveHealth()` — test hook restoring the initial state (`receiveWired: null`).

- [ ] **Step 1: Write the failing module tests**

Create `tests/receive-health.test.js`:

```js
/**
 * receive-health — R8/R7 per-process receive-path state. Pure module, zero
 * imports (gateway reads it with a plain import; must never pull sharing-client
 * sockets). Initial receiveWired is null = "never attempted".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setReceiveWired, setRelaysConnected, markInbound, markDecryptFailure,
  getReceiveHealth, _resetReceiveHealth,
} from "../servers/sharing/receive-health.js";

test("initial state: receiveWired null, no error, 0 relays, no inbound", () => {
  _resetReceiveHealth();
  assert.deepEqual(getReceiveHealth(), {
    receiveWired: null, lastError: null, relaysConnected: 0,
    lastInboundAt: null, decryptFailures: 0,
  });
});

test("setReceiveWired(false, err) records the failure; (true) clears it", () => {
  _resetReceiveHealth();
  setReceiveWired(false, new Error("DHT boom"));
  let h = getReceiveHealth();
  assert.equal(h.receiveWired, false);
  assert.equal(h.lastError, "DHT boom");
  setReceiveWired(true);
  h = getReceiveHealth();
  assert.equal(h.receiveWired, true);
  assert.equal(h.lastError, null);
});

test("setReceiveWired accepts a string error and a missing error", () => {
  _resetReceiveHealth();
  setReceiveWired(false, "plain string");
  assert.equal(getReceiveHealth().lastError, "plain string");
  setReceiveWired(false);
  assert.equal(getReceiveHealth().receiveWired, false);
  assert.equal(typeof getReceiveHealth().lastError, "string"); // some non-null placeholder
});

test("setRelaysConnected coerces; markInbound stamps; markDecryptFailure counts", () => {
  _resetReceiveHealth();
  setRelaysConnected(4);
  markInbound(1234567890);
  markDecryptFailure();
  markDecryptFailure();
  const h = getReceiveHealth();
  assert.equal(h.relaysConnected, 4);
  assert.equal(h.lastInboundAt, 1234567890);
  assert.equal(h.decryptFailures, 2);
  setRelaysConnected("not a number");
  assert.equal(getReceiveHealth().relaysConnected, 0);
});

test("getReceiveHealth returns a copy — mutating it does not leak back", () => {
  _resetReceiveHealth();
  const h = getReceiveHealth();
  h.receiveWired = true;
  assert.equal(getReceiveHealth().receiveWired, null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/receive-health.test.js`
Expected: FAIL — `Cannot find module ... receive-health.js`.

- [ ] **Step 3: Implement `servers/sharing/receive-health.js`**

```js
/**
 * receive-health — per-process receive-path health state (R8 + R7).
 *
 * Written by the sharing layer (boot.js sets receiveWired; nostr.js mirrors
 * relay count, stamps inbound activity, counts decrypt failures — L8). Read by
 * the gateway's nest `messagesSignal` with a PLAIN IMPORT — this module has
 * ZERO imports so importing it can never spin up sharing-client sockets
 * (the pre-QW2 suite-hang trap). Same per-process-singleton shape as
 * isAuditDegraded() in servers/shared/cross-host-auth.js.
 *
 * receiveWired: null = wiring never attempted (e.g. sharing disabled) — the
 * signal renders "off", never a false warn; false = attempted and failed
 * (warn); true = subscriptions live.
 */

const INITIAL = () => ({
  receiveWired: null,
  lastError: null,
  relaysConnected: 0,
  lastInboundAt: null,
  decryptFailures: 0,
});

let _state = INITIAL();

export function setReceiveWired(ok, err) {
  _state.receiveWired = !!ok;
  _state.lastError = ok ? null : (err?.message ?? String(err ?? "unknown"));
}

export function setRelaysConnected(n) {
  _state.relaysConnected = Number(n) || 0;
}

export function markInbound(nowMs = Date.now()) {
  _state.lastInboundAt = nowMs;
}

export function markDecryptFailure() {
  _state.decryptFailures += 1;
}

export function getReceiveHealth() {
  return { ..._state };
}

/** Test hook. */
export function _resetReceiveHealth() {
  _state = INITIAL();
}
```

- [ ] **Step 4: Run module tests to verify pass**

Run: `node --test tests/receive-health.test.js`
Expected: PASS (5/5).

- [ ] **Step 5: Write the failing hook tests**

Create `tests/nostr-receive-health-hooks.test.js`. Uses the `stubRelay` pattern from `tests/nostr-resubscribe.test.js` and a REAL NIP-44 encryption round-trip (fixed small-scalar keys — no key generation needed). If `getPublicKey` isn't exported from the `nostr-tools` root in the installed version, import it from `"nostr-tools/pure"`.

```js
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
```

- [ ] **Step 6: Run to verify failure**

Run: `node --test tests/nostr-receive-health-hooks.test.js`
Expected: FAIL — assertions on `relaysConnected` / `lastInboundAt` / `decryptFailures` (hooks not yet added). If the import of `getPublicKey` fails first, switch that import to `"nostr-tools/pure"` and re-run.

- [ ] **Step 7: Add the hooks to `nostr.js`**

Add to imports (near `import { makeResilientSub } ...` at `nostr.js:32`):

```js
import { setRelaysConnected, markInbound, markDecryptFailure } from "./receive-health.js";
```

Four hook sites (exact anchors, verified @ `5f8356f1` — re-locate by content if lines drifted):

1. **End of `_doConnectRelays`** — before `return [...this.relays.keys()];` (`nostr.js:~123`):
```js
    setRelaysConnected(this.relays.size);
    return [...this.relays.keys()];
```

2. **`subscribeToContact` `onevent`** — immediately after `const decrypted = nip44.v2.decrypt(event.content, conversationKey);` (`nostr.js:343`):
```js
            markInbound();
```

3. **`subscribeToContact` decrypt-failure catch** (`nostr.js:395–397`):
```js
          } catch (err) {
            // Decryption failed — not for us or corrupted
            markDecryptFailure();
          }
```

4. **`subscribeToIncoming` `onevent`** — immediately after its `const decrypted = nip44.v2.decrypt(event.content, conversationKey);` (`nostr.js:497`):
```js
            markInbound();
```
and its decrypt-failure catch (`nostr.js:540–542`):
```js
          } catch (decryptErr) {
            // Decryption failed — event not for us or from unknown sender
            markDecryptFailure();
          }
```

These are bare synchronous calls on a zero-import module — they cannot throw and cannot block `onevent`.

**Known observability limit (accepted, per spec "mirror of `relays.size`"):** the count reflects the last `_doConnectRelays` run — `connectRelays` short-circuits once the Map is populated (`nostr.js:82`) and the PR #115 health loop reconnects via `relay.connect()` without repopulating the Map, so a post-boot total socket loss does NOT drop the number to 0 (the health loop is the recovery for that case). A live `relay.connected`-filtered count is a logged follow-up, not this plan.

- [ ] **Step 8: Run both test files to verify pass**

Run: `node --test tests/receive-health.test.js tests/nostr-receive-health-hooks.test.js`
Expected: PASS (9/9). Also run the neighbors that exercise the same paths: `node --test tests/nostr-resubscribe.test.js tests/delivery-receipt-emit.test.js tests/relay-config.test.js` — all green.

- [ ] **Step 9: Commit**

```bash
git add servers/sharing/receive-health.js tests/receive-health.test.js tests/nostr-receive-health-hooks.test.js
git commit servers/sharing/receive-health.js servers/sharing/nostr.js tests/receive-health.test.js tests/nostr-receive-health-hooks.test.js -m "feat(sharing): receive-health state module + nostr mirror hooks (R7/L8)"
git show --stat HEAD
```

---

## Task 2: Boot split — `wireNostrReceive` decoupled from `peerManager.start()` (R8/L11)

**Files:**
- Modify: `servers/sharing/boot.js` (extract `wireNostrReceive` + `startNostrReceive`; slim the `.then()` block)
- Test: `tests/boot-receive-decouple.test.js`

**Interfaces:**
- Consumes: `setReceiveWired` from Task 1.
- Produces:
  - `export async function wireNostrReceive(managers)` — performs per-contact `subscribeToContact` (skip `'pending'`) then `subscribeToIncoming` with the FULL existing handler ladder, **verbatim**. Per-contact failures warn-and-continue; a `subscribeToIncoming` failure **propagates** (that is the wiring failure).
  - `export function startNostrReceive(managers, opts?)` — `opts = { baseMs=15000, maxMs=300000, schedule }`; `schedule(fn, ms)` defaults to an unref'd `setTimeout`. Runs `wireNostrReceive`; on success `setReceiveWired(true)`; on throw `setReceiveWired(false, err)` + schedules a retry at `min(baseMs · 2^attempt, maxMs)`. Returns the first-attempt promise; **never rejects**.

- [ ] **Step 1: Read the current wiring end-to-end**

Read `servers/sharing/boot.js:321–560` fully before editing (the contacts loop, the whole `subscribeToIncoming` handler ladder, the instance-sync tail, the `.catch`). The handler ladder references module-scope names (`handleInviteAccepted`, `handleIncomingRequest`, `handleDeliveryReceipt`, `handleIncomingBotRelay`, `resolvePendingRelay`, `resolveLocalInstanceName`, `createNotification`, `DELIVERY_RECEIPT_SUBTYPE`, dynamic `./room-inbound.js` import) — all remain reachable because `wireNostrReceive` stays **in the same module**.

- [ ] **Step 2: Write the failing decouple test**

Create `tests/boot-receive-decouple.test.js`:

```js
/**
 * R8 (never run deaf, L11): the Nostr receive path is wired even when
 * peerManager.start() rejects, and a wiring failure sets receiveWired=false
 * and schedules a bounded-backoff retry. Stub managers only — no sockets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { initSharingRuntime, wireNostrReceive, startNostrReceive } from "../servers/sharing/boot.js";
import { getReceiveHealth, _resetReceiveHealth } from "../servers/sharing/receive-health.js";

function stubManagers({ startRejects = false, incomingThrows = 0 } = {}) {
  const calls = { subscribeToContact: [], subscribeToIncoming: 0, joinContact: [], initContact: [] };
  let throwsLeft = incomingThrows;
  const contactsRows = [
    { id: 1, crow_id: "crow:full", display_name: "F", ed25519_pubkey: "ed1", secp256k1_pubkey: "02" + "a".repeat(64), request_status: null },
    { id: 2, crow_id: "crow:acc", display_name: "A", ed25519_pubkey: "", secp256k1_pubkey: "02" + "b".repeat(64), request_status: "accepted" },
    { id: 3, crow_id: "crow:pend", display_name: "P", ed25519_pubkey: "", secp256k1_pubkey: "02" + "c".repeat(64), request_status: "pending" },
  ];
  const db = {
    execute: async ({ sql }) =>
      /FROM contacts WHERE is_blocked = 0/.test(sql)
        ? { rows: contactsRows, rowsAffected: 0 }
        : { rows: [], rowsAffected: 0 },
  };
  const managers = {
    db,
    identity: { crowId: "crow:test", secp256k1Pubkey: "a".repeat(64), secp256k1Priv: new Uint8Array(32) },
    peerManager: {
      start: () => (startRejects ? Promise.reject(new Error("DHT boom")) : Promise.resolve()),
      joinContact: async (a) => { calls.joinContact.push(a); },
      joinInstanceSync: async () => {},
    },
    syncManager: { initContact: async (id) => { calls.initContact.push(id); } },
    instanceSyncManager: { localInstanceId: "inst-test" },
    nostrManager: {
      subscribeToContact: async (c) => { calls.subscribeToContact.push(c.crow_id); },
      subscribeToIncoming: async (onInvite, onSocial, onRequest) => {
        if (throwsLeft > 0) { throwsLeft--; throw new Error("relay wiring boom"); }
        calls.subscribeToIncoming++;
        calls.handlers = { onInvite, onSocial, onRequest }; // captured for ladder-scope tests
      },
    },
  };
  return { managers, calls };
}

// The scope-trap detector (review round 1): a too-narrow destructure in
// wireNostrReceive makes a ladder branch throw ReferenceError on its free
// variables (syncManager/peerManager/identity). Stub-db failures are tolerated;
// a ReferenceError is the bug.
async function assertNoReferenceError(fn, label) {
  try {
    await fn();
  } catch (err) {
    assert.ok(!(err instanceof ReferenceError), `${label}: ladder scope broken — ${err.message}`);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test("wireNostrReceive subscribes non-pending contacts then incoming", async () => {
  _resetReceiveHealth();
  const { managers, calls } = stubManagers();
  await wireNostrReceive(managers);
  assert.deepEqual(calls.subscribeToContact.sort(), ["crow:acc", "crow:full"]); // pending skipped
  assert.equal(calls.subscribeToIncoming, 1);
});

test("R8: initSharingRuntime wires Nostr receive even when peerManager.start() rejects", async () => {
  _resetReceiveHealth();
  const { managers, calls } = stubManagers({ startRejects: true });
  await initSharingRuntime(managers, { applyProjectCloneBundle: async () => {}, buildProjectCloneBundle: async () => {} });
  for (let i = 0; i < 25 && calls.subscribeToIncoming === 0; i++) await tick();
  assert.equal(calls.subscribeToIncoming, 1, "subscribeToIncoming must run despite DHT failure");
  assert.equal(getReceiveHealth().receiveWired, true);
  // And the Hyperswarm-only work did NOT run (start rejected):
  assert.equal(calls.joinContact.length, 0);
});

test("startNostrReceive: wiring failure sets receiveWired=false and retries with backoff", async () => {
  _resetReceiveHealth();
  const { managers, calls } = stubManagers({ incomingThrows: 2 });
  const scheduled = [];
  // Capturing scheduler: records delay, runs the retry immediately.
  const schedule = (fn, ms) => { scheduled.push(ms); fn(); };
  await startNostrReceive(managers, { baseMs: 1000, maxMs: 8000, schedule });
  for (let i = 0; i < 25 && calls.subscribeToIncoming === 0; i++) await tick();
  assert.equal(calls.subscribeToIncoming, 1, "third attempt succeeds");
  assert.deepEqual(scheduled, [1000, 2000], "exponential backoff from baseMs");
  assert.equal(getReceiveHealth().receiveWired, true);
});

test("moved ladder keeps its free variables in scope (invite/social/request drive without ReferenceError)", async () => {
  _resetReceiveHealth();
  const { managers, calls } = stubManagers();
  await wireNostrReceive(managers);
  const h = calls.handlers;
  assert.ok(h, "stub must capture the three subscribeToIncoming callbacks");
  // invite_accepted → handleInviteAccepted(db, { syncManager, peerManager, nostrManager }, …)
  await assertNoReferenceError(
    () => h.onInvite({ type: "invite_accepted", crow_id: "crow:x", secp: "02" + "d".repeat(64) }, "d".repeat(64)),
    "onInviteAccepted",
  );
  // room_message → handleInboundRoomEnvelope({ db, nostrManager, identity, … }) — references `identity`
  await assertNoReferenceError(
    () => h.onSocial("room_message", {}, "d".repeat(64)),
    "onSocial(room_message)",
  );
  // bot_relay → early-returns on target_instance mismatch (exercises the
  // resolveLocalInstanceName/db path only; the `identity` free variable is
  // covered by the room_message drive above, which evaluates it in the
  // argument object before the callee runs)
  await assertNoReferenceError(
    () => h.onSocial("bot_relay", { target_instance: "nope", sender_instance: "x" }, "d".repeat(64)),
    "onSocial(bot_relay)",
  );
  // reaction → createNotification-only branch
  await assertNoReferenceError(
    () => h.onSocial("reaction", { emoji: "+1", sender_name: "X" }, "d".repeat(64)),
    "onSocial(reaction)",
  );
  // message-request fallback → handleIncomingRequest(db, managers, …) — references `managers`
  await assertNoReferenceError(
    () => h.onRequest("d".repeat(64), "plain text", { id: "evt1" }),
    "onMessageRequest",
  );
});

test("startNostrReceive: backoff is capped at maxMs and never rejects", async () => {
  _resetReceiveHealth();
  const { managers } = stubManagers({ incomingThrows: 6 });
  const scheduled = [];
  let pending = null;
  const schedule = (fn, ms) => { scheduled.push(ms); pending = fn; };
  await startNostrReceive(managers, { baseMs: 1000, maxMs: 4000, schedule });
  // Drive the retries manually: initial attempt scheduled push #1; 4 more
  // attempts (all still throwing) push #2-#5. 5 attempts total, throwsLeft 6→1.
  for (let i = 0; i < 4; i++) { const fn = pending; pending = null; await fn(); }
  assert.deepEqual(scheduled, [1000, 2000, 4000, 4000, 4000], "capped at maxMs");
  assert.equal(getReceiveHealth().receiveWired, false);
  assert.match(getReceiveHealth().lastError, /relay wiring boom/);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test tests/boot-receive-decouple.test.js`
Expected: FAIL — `wireNostrReceive`/`startNostrReceive` are not exported.

- [ ] **Step 4: Implement the split in `boot.js`**

**(a)** Add the import at the top (with the other `./` imports, near `boot.js:23`):
```js
import { setReceiveWired } from "./receive-health.js";
```

**(b)** Define the two new exports ABOVE `initSharingRuntime` (`boot.js:321`). `wireNostrReceive` receives the whole `managers` object (the handler ladder needs `db`, `identity`, `peerManager`, `syncManager`, `nostrManager`):

```js
/**
 * R8 (never run deaf): wire the Nostr receive path — per-contact subscriptions
 * plus the broad incoming subscription — INDEPENDENT of Hyperswarm. DMs are
 * Nostr kind:4 and need no DHT; before this split the whole block lived inside
 * peerManager.start().then(), so a single DHT failure at boot silently killed
 * all message receipt until restart (L11).
 *
 * Per-contact subscribe failures warn-and-continue (as before). A
 * subscribeToIncoming failure PROPAGATES — that is the wiring failure
 * startNostrReceive retries. Re-running is safe: NostrManager closes and
 * replaces any prior handle per subscription key.
 */
export async function wireNostrReceive(managers) {
  // The handler ladder references ALL of these free names (review round 1
  // critical): handleInviteAccepted uses syncManager/peerManager (boot.js:385),
  // handleIncomingBotRelay + handleInboundRoomEnvelope use identity
  // (boot.js:477,497), handleIncomingRequest takes the whole `managers`
  // (boot.js:505). Destructuring too few silently breaks invite promotion —
  // the ReferenceError is swallowed by subscribeToIncoming's handled=true
  // try/catch (nostr.js:508-521).
  const { db, identity, peerManager, syncManager, nostrManager } = managers;

  try {
    const contacts = await db.execute({
      sql: "SELECT id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, request_status FROM contacts WHERE is_blocked = 0",
      args: [],
    });
    for (const c of contacts.rows) {
      try {
        // 'pending' requests stay unsubscribed — the broad incoming
        // subscription below still receives them (L6 request path).
        if (c.request_status === "pending") continue;
        await nostrManager.subscribeToContact({
          id: c.id,
          crow_id: c.crow_id,
          secp256k1_pubkey: c.secp256k1_pubkey,
          display_name: c.display_name,
        });
      } catch (err) {
        console.warn(`[sharing] Nostr subscribe failed for ${c.crow_id}:`, err.message);
      }
    }
  } catch (err) {
    console.warn("[sharing] Failed to load contacts for Nostr subscribe:", err.message);
  }

  // Broad incoming subscription (invites, social envelopes, message requests).
  // Ordered after the per-contact loop so relay connections are reused.
  await nostrManager.subscribeToIncoming(async (payload, senderPubkey) => {
    /* ── the ENTIRE existing onInviteAccepted + onSocialMessage + onMessageRequest
       wiring moves here VERBATIM from the old .then() block (boot.js:384–513) —
       every subtype branch, unchanged. Do not edit handler bodies. ── */
  }, async (subtype, payload, senderPubkey) => {
    /* verbatim onSocialMessage ladder */
  }, async (senderPubkey, content, event) => {
    /* verbatim onMessageRequest wiring */
  });
  console.log("[sharing] Subscribed to incoming Nostr messages");
}

/**
 * Run wireNostrReceive with health reporting + bounded-backoff retry.
 * Never rejects. The retry timer is unref'd so it can never hold the
 * process open.
 */
export function startNostrReceive(managers, opts = {}) {
  const baseMs = opts.baseMs ?? 15_000;
  const maxMs = opts.maxMs ?? 300_000;
  const schedule = opts.schedule ?? ((fn, ms) => {
    const t = setTimeout(fn, ms);
    if (t.unref) t.unref();
    return t;
  });
  let attempt = 0;
  const run = async () => {
    try {
      await wireNostrReceive(managers);
      setReceiveWired(true);
    } catch (err) {
      setReceiveWired(false, err);
      const delay = Math.min(baseMs * 2 ** attempt, maxMs);
      attempt += 1;
      console.warn(`[sharing] Nostr receive wiring failed (retry in ${Math.round(delay / 1000)}s):`, err?.message);
      schedule(run, delay);
    }
  };
  return run();
}
```

*(Accepted, per review round 1 minor: the retry chain has no disarm — unref'd timers can't hold the process open, the gateway's `NostrManager` lives for the process lifetime, and tests inject `schedule` so no real timers leak. A disarm handle wired to `destroy()` is a logged follow-up, not this plan.)*

**Move semantics for the ladder:** the three callback bodies currently passed to `nostrManager.subscribeToIncoming` inside the `.then()` block (`boot.js:384–513`, ending at `console.log("[sharing] Subscribed to incoming Nostr messages")`) move **unchanged** into `wireNostrReceive`. The old `try { ... } catch { console.warn("Failed to subscribe...") }` wrapper is **dropped** — the throw now propagates to `startNostrReceive` (which records + retries). Also **delete** the stale trailing comment at `boot.js:816–817` ("subscribeToIncoming is now set up inside peerManager.start().then()...") — it becomes false.

**(c)** In `initSharingRuntime`, immediately BEFORE `peerManager.start().then(...)` (`boot.js:335`), add:

```js
  // R8: the Nostr receive path must never depend on Hyperswarm coming up.
  // Fire-and-forget (never rejects); failures are health-visible + retried.
  startNostrReceive(managers);
```

**(d)** Slim the `.then()` block to Hyperswarm-only. The contacts loop keeps ONLY the DHT/sync work for FULL contacts (both partial states skip — they have no usable ed25519 key):

```js
  peerManager.start().then(async () => {
    try {
      const contacts = await db.execute({
        sql: "SELECT id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, request_status FROM contacts WHERE is_blocked = 0",
        args: [],
      });
      for (const c of contacts.rows) {
        try {
          // Nostr subscriptions are handled by wireNostrReceive (R8). Only
          // FULL contacts (request_status NULL) join DHT topics / sync —
          // partial rows lack a usable ed25519 key.
          if (c.request_status === "pending" || c.request_status === "accepted") continue;
          await syncManager.initContact(c.id, null);
          await peerManager.joinContact({
            crowId: c.crow_id,
            ed25519Pubkey: c.ed25519_pubkey,
          });
        } catch (err) {
          console.warn(`[sharing] Failed to join topic for ${c.crow_id}:`, err.message);
        }
      }
      if (contacts.rows.length > 0) {
        console.log(`[sharing] Joined DHT topics for ${contacts.rows.length} contact(s)`);
      }
    } catch (err) {
      console.warn("[sharing] Failed to load contacts on startup:", err.message);
    }

    // Join instance sync topic for cross-instance discovery
    ...everything from `peerManager.joinInstanceSync()` down stays EXACTLY as-is...
  }).catch((err) => {
    console.warn("[sharing] PeerManager start failed:", err.message);
  });
```

- [ ] **Step 5: Run the decouple tests**

Run: `node --test tests/boot-receive-decouple.test.js`
Expected: PASS (5/5). If the `initSharingRuntime` test trips on a stub gap (the function also assigns `peerManager.onInstanceConnected/onPeerConnected/onPeerData/localInstanceId/getFeedKeyForInstance/onInstanceKeyReceived` — plain property assignments that a plain object absorbs), extend the stub minimally rather than weakening the assertions.

- [ ] **Step 6: Run every suite that touches the moved code**

Run: `node --test tests/boot-receive-decouple.test.js tests/message-requests.test.js tests/delivery-receipt-handler.test.js tests/handshake-promote.test.js tests/nostr-resubscribe.test.js tests/crow-accept-bot-invite.test.js`
Expected: ALL PASS — the ladder moved verbatim; any failure here means behavior drifted, fix before proceeding.

- [ ] **Step 7: Isolated gateway boot smoke**

Run: `CROW_GATEWAY_URL= CROW_DATA_DIR=$(mktemp -d) PORT=3999 timeout 25 node servers/gateway/index.js --no-auth 2>&1 | grep -E "\[sharing\]|\[nostr\]|listening" | head -20`
Expected: both `[nostr] Subscribed to incoming on N relay(s)` and `[sharing] Subscribed to incoming Nostr messages` appear (N≥1), no new error lines. (On crow, `--no-auth` only boots with the isolated env vars shown — public `.ts.net` guard.)

- [ ] **Step 8: Commit**

```bash
git add tests/boot-receive-decouple.test.js
git commit servers/sharing/boot.js tests/boot-receive-decouple.test.js -m "feat(sharing): decouple Nostr receive wiring from peerManager.start (R8/L11 never run deaf)"
git show --stat HEAD
```

---

## Task 3: `messagesSignal` + i18n (R7 + R3-residual)

**Files:**
- Modify: `servers/gateway/dashboard/panels/nest/health-signals.js`
- Modify: `servers/gateway/dashboard/shared/i18n.js`
- Test: `tests/messages-health-signal.test.js`

**Interfaces:**
- Consumes: `getReceiveHealth`, plus setters for tests, from Task 1.
- Produces: signal id `"messages"` in `collectHealthSignals` output; i18n keys `signals.messages.{label,off,down,downIssue,noRelays,noRelaysIssue,action,relays,lastIn,pending,undecryptable}`.

**Precedence (from the spec — first match wins):**
1. `receiveWired === null` → `off` (no issue)
2. `receiveWired === false` → **warn** "Crow isn't receiving messages"
3. `relaysConnected === 0` → **warn** "No message relays connected"
4. otherwise → `ok`; value = `"{N} relays · last in {age}"` (+ optional `· {p} pending` / `· {d} undecryptable`), all display-only.

- [ ] **Step 1: Write the failing signal tests**

Create `tests/messages-health-signal.test.js`:

```js
/**
 * messagesSignal — R7 (+R3 residual relay-state). Warn ONLY on
 * receiveWired===false or relaysConnected===0. A quiet mailbox (old/no
 * lastInboundAt) and a pending-outbound backlog NEVER warn. receiveWired null
 * (never attempted) renders off, no issue.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectHealthSignals, invalidateHealthCache,
} from "../servers/gateway/dashboard/panels/nest/health-signals.js";
import {
  setReceiveWired, setRelaysConnected, markInbound, markDecryptFailure,
  _resetReceiveHealth,
} from "../servers/sharing/receive-health.js";

// Generic stub: message_retry_queue COUNT returns `retryRows`; everything else empty.
function makeDb(retryRows = 0) {
  return {
    execute: async ({ sql }) =>
      /FROM message_retry_queue/.test(sql)
        ? { rows: [{ n: retryRows }] }
        : { rows: [] },
  };
}

async function messagesDetail(db, now) {
  invalidateHealthCache();
  const r = await collectHealthSignals(db, now ? { now } : {});
  return {
    detail: r.details.find((d) => d.id === "messages"),
    issue: r.issues.find((i) => i.id === "messages"),
  };
}

test("never attempted (receiveWired null) → off, no issue", async () => {
  _resetReceiveHealth();
  const { detail, issue } = await messagesDetail(makeDb());
  assert.equal(detail.state, "off");
  assert.equal(issue, undefined);
});

test("receiveWired=false → warn issue (R8's loud signal)", async () => {
  _resetReceiveHealth();
  setReceiveWired(false, new Error("DHT boom"));
  const { detail, issue } = await messagesDetail(makeDb());
  assert.equal(detail.state, "warn");
  assert.ok(issue);
  assert.equal(issue.severity, "warn");
});

test("wired but 0 relays → warn", async () => {
  _resetReceiveHealth();
  setReceiveWired(true);
  setRelaysConnected(0);
  const { detail, issue } = await messagesDetail(makeDb());
  assert.equal(detail.state, "warn");
  assert.ok(issue);
});

test("healthy: relays count in value, ok, no issue", async () => {
  _resetReceiveHealth();
  setReceiveWired(true);
  setRelaysConnected(4);
  const { detail, issue } = await messagesDetail(makeDb());
  assert.equal(detail.state, "ok");
  assert.match(detail.value, /4/);
  assert.equal(issue, undefined);
});

test("quiet mailbox: 10-day-old inbound stays ok (display-only)", async () => {
  _resetReceiveHealth();
  setReceiveWired(true);
  setRelaysConnected(4);
  const NOW = 1_800_000_000_000;
  markInbound(NOW - 10 * 24 * 60 * 60 * 1000);
  const { detail, issue } = await messagesDetail(makeDb(), () => NOW);
  assert.equal(detail.state, "ok");
  assert.equal(issue, undefined);
  assert.match(detail.value, /10d/);
});

test("pending outbound + decrypt failures are display-only, never an issue", async () => {
  _resetReceiveHealth();
  setReceiveWired(true);
  setRelaysConnected(4);
  markDecryptFailure();
  const { detail, issue } = await messagesDetail(makeDb(3));
  assert.equal(detail.state, "ok");
  assert.equal(issue, undefined);
  assert.match(detail.value, /3/); // pending count surfaced
});

test("retry-queue read failure degrades gracefully (still ok, no throw)", async () => {
  _resetReceiveHealth();
  setReceiveWired(true);
  setRelaysConnected(4);
  const badDb = { execute: async () => { throw new Error("db gone"); } };
  const { detail } = await messagesDetail(badDb);
  assert.equal(detail.state, "ok");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/messages-health-signal.test.js`
Expected: FAIL — no `messages` detail in results.

- [ ] **Step 3: Add the i18n strings**

In `servers/gateway/dashboard/shared/i18n.js`, directly after the `signals.federationAudit.*` block (`i18n.js:204`), matching sibling style:

```js
  "signals.messages.label": { en: "Messages", es: "Mensajes" },
  "signals.messages.off": { en: "not active", es: "no activo" },
  "signals.messages.down": { en: "not receiving", es: "sin recibir" },
  "signals.messages.downIssue": { en: "Crow isn't receiving messages — the receive path failed to start and is retrying. Messages sent to you are held on relays until it recovers.", es: "Crow no está recibiendo mensajes — la ruta de recepción no pudo iniciarse y está reintentando. Los mensajes que te envíen quedan retenidos en los relés hasta que se recupere." },
  "signals.messages.noRelays": { en: "no relays", es: "sin relés" },
  "signals.messages.noRelaysIssue": { en: "No message relays are connected — Crow can't send or receive messages right now.", es: "No hay relés de mensajes conectados — Crow no puede enviar ni recibir mensajes ahora mismo." },
  "signals.messages.action": { en: "Open Messages", es: "Abrir Mensajes" },
  "signals.messages.relays": { en: "{n} relays", es: "{n} relés" },
  "signals.messages.lastIn": { en: "last in {age}", es: "último hace {age}" },
  "signals.messages.pending": { en: "{n} pending out", es: "{n} salientes pendientes" },
  "signals.messages.undecryptable": { en: "{n} undecryptable", es: "{n} indescifrables" },
```

- [ ] **Step 4: Implement `messagesSignal`**

In `health-signals.js`, add the import next to the `isAuditDegraded` import (`health-signals.js:27`):

```js
import { getReceiveHealth } from "../../../../sharing/receive-health.js";
```

Add the collector after `federationAuditSignal` (`health-signals.js:~578`):

```js
// Messages receive-path health (R8+R7). Reads the pure receive-health module —
// NEVER the sharing client (importing the live client opens relay sockets).
// Warn ONLY on a dead receive path or zero relays; a quiet mailbox, queued
// outbound retries, and decrypt failures are display-only, never issues.
function formatAge(ms) {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

async function messagesSignal(db, lang, nowFn) {
  const h = getReceiveHealth();
  const label = t("signals.messages.label", lang);
  const action = { actionLabel: t("signals.messages.action", lang), actionHref: "/dashboard/messages" };

  if (h.receiveWired === null) {
    return { id: "messages", severity: null, state: "off", label, value: t("signals.messages.off", lang) };
  }
  if (h.receiveWired === false) {
    return {
      id: "messages", severity: "warn", state: "warn", label,
      value: t("signals.messages.down", lang),
      issueLabel: t("signals.messages.downIssue", lang), ...action,
    };
  }
  if (h.relaysConnected === 0) {
    return {
      id: "messages", severity: "warn", state: "warn", label,
      value: t("signals.messages.noRelays", lang),
      issueLabel: t("signals.messages.noRelaysIssue", lang), ...action,
    };
  }

  // Healthy — everything below is display-only.
  let pendingOut = 0;
  try {
    const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM message_retry_queue", args: [] });
    pendingOut = Number(rows[0]?.n ?? 0);
  } catch {} // table missing / DB hiccup → just omit the count

  const parts = [t("signals.messages.relays", lang).replace("{n}", String(h.relaysConnected))];
  if (h.lastInboundAt) {
    parts.push(t("signals.messages.lastIn", lang).replace("{age}", formatAge(nowFn() - h.lastInboundAt)));
  }
  if (pendingOut > 0) {
    parts.push(t("signals.messages.pending", lang).replace("{n}", String(pendingOut)));
  }
  if (h.decryptFailures > 0) {
    parts.push(t("signals.messages.undecryptable", lang).replace("{n}", String(h.decryptFailures)));
  }
  return { id: "messages", severity: null, state: "ok", label, value: parts.join(" · ") };
}
```

Wire it into `collectHealthSignals` — append to the `Promise.all` array after `federationAuditSignal(lang)` (`health-signals.js:608`):

```js
    federationAuditSignal(lang),
    messagesSignal(db, lang, nowFn),
```

- [ ] **Step 5: Run the signal tests**

Run: `node --test tests/messages-health-signal.test.js`
Expected: PASS (7/7).

- [ ] **Step 6: Run the neighboring signal/monitor suites**

Run: `node --test tests/health-signals.test.js tests/security-signals.test.js tests/health-monitor-dedupe.test.js tests/health-monitor-noauth-skip.test.js`
Expected: ALL PASS. (`tests/health-signals.test.js` iterates real signals with a stub db — the new collector must not disturb its counts; if a test asserts an exact `details.length`, update it deliberately and note it in the ledger.)

- [ ] **Step 7: Commit**

```bash
git add tests/messages-health-signal.test.js
git commit servers/gateway/dashboard/panels/nest/health-signals.js servers/gateway/dashboard/shared/i18n.js tests/messages-health-signal.test.js -m "feat(nest): messages receive-path health signal (R7/L8 + R3 relay state)"
git show --stat HEAD
```

---

## Task 4: Full suite + boot verify + final review + ledger → PR

**Files:**
- Modify: `.superpowers/sdd/progress.md` (ledger — git-ignored, do NOT git add)
- Commit: `docs/superpowers/plans/2026-07-03-messages-r8-r7-receive-robustness.md` (this plan, with Review/Execution sections filled)

- [ ] **Step 1: Full suite**

Run: `node --test tests/ 2>&1 | tail -15`
Expected: ALL PASS (961 baseline + 21 new = 982). Zero regressions.

- [ ] **Step 2: Isolated gateway boot + live-signal spot-check**

Run the Task 2 Step 7 isolated boot again; additionally confirm via the boot log that no `[sharing] Nostr receive wiring failed` line appears on a healthy boot.

- [ ] **Step 3: Final whole-branch review (opus) — do NOT skip**

Dispatch the final reviewer over `a67c2eff..HEAD` (the R4 precedent: final review caught a critical). Focus areas to name explicitly: (1) the handler ladder moved VERBATIM — diff the moved block against `main`'s version token-by-token; (2) no behavior change to L6/R4/R5 trust boundaries; (3) the retry loop cannot double-wire concurrently or leak timers; (4) `health-signals.js` import chain stays socket-free (verify `receive-health.js` still has zero imports); (5) warn conditions match the spec's precedence table exactly.

- [ ] **Step 4: Ledger + plan Review section**

Append the task-by-task record to `.superpowers/sdd/progress.md` (git-ignored — never `git add` it). Fill this plan's **Review** and **Execution & Final Review** sections; commit the plan doc:

```bash
git add docs/superpowers/plans/2026-07-03-messages-r8-r7-receive-robustness.md
git commit docs/superpowers/plans/2026-07-03-messages-r8-r7-receive-robustness.md -m "docs(messages): R8+R7 execution plan + review record"
```

- [ ] **Step 5: Push + PR (operator-gated merge)**

```bash
git pull --rebase origin main   # rebase the branch onto latest main first if main moved
git push -u origin feat/messages-r8-r7-receive-robustness
```
PR via github MCP (`mcp__github__create_pull_request`, owner=`kh0pper`, repo=`crow`) — title `feat(messages): never run deaf (R8) + messages health signal (R7)`. Before merge: verify **check-runs** (`https://api.github.com/repos/kh0pper/crow/commits/<sha>/check-runs` — every run `completed`/`success`; port-allocation is path-filtered off this diff). Merge with a merge commit (operator-gated).

- [ ] **Step 6: Deploy on crow + live verify**

```bash
cd ~/crow && git checkout main && git pull --rebase
echo '8r00kly^' | sudo -S systemctl restart crow-gateway.service
sleep 8
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/health   # 200
grep -E "Subscribed to incoming" /var/log/crow-inference/gateway.log | tail -2
sqlite3 ~/.crow/data/crow.db "PRAGMA integrity_check; PRAGMA user_version;"  # ok / 3 (no bump)
```
Then confirm the nest shows the **Messages** signal `ok` with the relay count (dashboard → nest). No schema migration expected (`user_version` stays 3).

---

## Self-Review (against the design spec)

- **Spec coverage:** wireNostrReceive split + bounded retry (spec §1) → Task 2; receive-health module incl. decrypt-failure counter (spec §2 + master-plan R7/L8) → Task 1; messagesSignal with 4-row precedence + false-alarm discipline + pending-outbound display (spec §3) → Task 3; never-throw + off-state + no-schema (spec §4–5) → Global Constraints + Task 3 Step 4; all spec §Testing cases have concrete test code; optional Gitea-harness scenario stays optional (follow-ups). ✓
- **Placeholder scan:** the two `/* verbatim ... */` markers in Task 2 Step 4(b) are deliberate MOVE instructions (the 130-line ladder is quoted by exact source range `boot.js:384–513`, not paraphrased) — with the verbatim-move check named as final-review focus #1. No TBDs. ✓
- **Type consistency:** `setReceiveWired(ok, err)` / `getReceiveHealth()` shapes match across Tasks 1→2→3; `messagesSignal(db, lang, nowFn)` matches its `collectHealthSignals` call; i18n keys in Task 3 Steps 3/4 match 1:1. ✓

## Review

**Round 2 (2026-07-03, adversarial opus subagent): REVISE → all addressed. Round-1 fixes BOTH VERIFIED correct and complete** (destructure covers every free variable of the moved ladder — full identifier enumeration of `boot.js:384–513` confirmed `instanceSyncManager` appears only in the non-moving instance-sync tail; the ladder-scope test genuinely catches the critical because each free variable is evaluated in the argument-building expression in caller scope, so a `ReferenceError` fires before any tolerated stub-db error). Also verified: the room_message drive can't hang (stub db → `getRoomByUid` null → early return after one db call) and `room-inbound.js`'s import chain is socket/timer-free (no QW2 trap). New findings, all fixed: **[IMPORTANT]** the backoff-cap test drove 6 attempts against a 5-element expected array (off-by-one; loop corrected to `i < 4` → 5 attempts, `receiveWired` stays false); **[MINOR]** the bot_relay drive early-returns before `handleIncomingBotRelay` so it never exercises `identity` — comment corrected (identity coverage = the room_message drive); **[MINOR]** stale new-test totals (~15/~16 → 21: 5+4+5+7; full-suite expectation 982).

**Round 1 (2026-07-03, adversarial opus subagent): REVISE — all findings addressed:**
1. **[CRITICAL, fixed]** `wireNostrReceive` destructured only `{ db, nostrManager }` while the moved ladder references `syncManager`/`peerManager` (`boot.js:385`), `identity` (`boot.js:477,497`), and `managers` itself (`boot.js:505`) — a ReferenceError silently swallowed by `subscribeToIncoming`'s `handled=true` try/catch would have broken R4 invite promotion. Destructure corrected to all five + `managers` kept in scope; rationale comment added at the destructure site.
2. **[IMPORTANT, fixed]** No test exercised the moved ladder, so #1 would have shipped undetected. Added the ladder-scope test: the stub captures the three real callbacks and drives `invite_accepted`, `room_message`, `bot_relay`, `reaction`, and the request fallback, asserting no `ReferenceError` (stub-db failures tolerated).
3. **[MINOR, noted]** `relaysConnected` reflects the last `_doConnectRelays` run — a post-boot total socket loss doesn't drop it to 0 (`connectRelays` short-circuits at `nostr.js:82`; the PR #115 health loop reconnects without repopulating the Map). Accepted per spec ("mirror of relays.size"); live-count = logged follow-up. Boot-time all-relays-fail IS covered honestly (verified: `_doConnectRelays` never throws, `subscribeToIncoming` no-ops on an empty Map → `receiveWired=true` + `relaysConnected=0` → warn row 3 fires — the L9-adjacent case).
4. **[MINOR, noted]** `startNostrReceive` retry chain has no disarm — accepted (unref'd, process-lifetime manager, tests inject `schedule`); disarm-on-destroy = logged follow-up.
5. **[MINOR, confirmed intended]** the monitor notification title is the descriptive `issueLabel` (`post-listen.js:242-249`, `health-signals.js:630`); monitor path verified allowlist-free — every `severity==="warn"` issue notifies, new signal included automatically.
Reviewer verified sound: idempotent re-subscribe close-and-replace both paths + `nostr_event_id` UNIQUE re-delivery guard; `makeResilientSub` wrapper invokes the real `onevent` synchronously through decrypt; `readIncomingSince`/`persistIncomingCursor` null-db safe; `initSharingRuntime` stub survival (only `ensureColumn` + property assignments outside the `.then`); `t()` returns key on miss; import path + zero-import chain socket-free; no `SCHEMA_GENERATION` bump needed.

## Execution & Final Review

*(Filled at Task 4.)*
