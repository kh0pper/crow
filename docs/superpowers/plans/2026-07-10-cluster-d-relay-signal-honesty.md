# Cluster D — Relay-Signal Honesty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The messages nest signal reflects LIVE relay socket state (F-HEALTH-2 / the R7 follow-up) — a post-boot relay outage drives it to `[warn] "0 relays"` within one health tick instead of staying green forever.

**Architecture:** One private `NostrManager._refreshRelayHealth()` (count `relay.connected === true` → `setRelaysConnected`), called at the end of `_doConnectRelays` (replacing the map-size set — defensive only) and at the TOP of each existing `_startHealthLoop` tick, BEFORE the `ensureHealthy` sweep (ordering load-bearing). Spec (2-round adversarially reviewed): `docs/superpowers/specs/2026-07-10-relay-signal-honesty-design.md`.

**Tech Stack:** Node ESM, nostr-tools 2.23.3, node:test.

## Global Constraints

- **No SCHEMA_GENERATION bump**; no new env knobs (reuses `CROW_NOSTR_HEALTH_MS`).
- **NEVER `git commit --amend`.** Positional-path commits only (`git add <path>` for NEW files); `git show --stat HEAD` after every commit. Never `git add -A`.
- Branch: `fix/messages-cluster-d-relay-signal-honesty`. Suite baseline: 1385-class pass / 1 pre-existing foreign fail (bundle-contract) / 1 skip.
- HARD REQ: `_refreshRelayHealth`'s body wrapped in try/catch (first sync throw-surface in an unguarded interval callback).
- HARD REQ: place the new method adjacent to `_startHealthLoop` (~line 385) — NOT in lines ~470-510 (Cluster C #160's onevent hunk; merges must stay clean in either order).
- HARD REQ: the refresh call in the tick goes BEFORE the `ensureHealthy` for-loop (a same-tick reconnect must not re-hide the outage) with a comment pinning the ordering.
- HARD REQ: `destroy()` additionally calls `setRelaysConnected(0)`.
- Tests: `await mgr.destroy()` + restore `CROW_NOSTR_HEALTH_MS` in `finally`; bounded waitFor polling, no fixed sleeps.

---

### Task 1: `_refreshRelayHealth` + call sites + tests

**Files:**
- Modify: `servers/sharing/nostr.js` (line ~123 in `_doConnectRelays`; `_startHealthLoop` ~385-399; `destroy()` ~766-784; new method adjacent to `_startHealthLoop`)
- Test: `tests/relay-signal-honesty.test.js` (new)

**Interfaces:**
- Consumes: `setRelaysConnected`, `getReceiveHealth`, `_resetReceiveHealth` from `servers/sharing/receive-health.js` (setRelaysConnected already imported in nostr.js).
- Produces: `NostrManager._refreshRelayHealth()` (private; tests may call it).

- [ ] **Step 1: Write the failing test**

Create `tests/relay-signal-honesty.test.js`:

```js
/**
 * Cluster D (F-HEALTH-2) — relaysConnected mirrors LIVE socket state:
 * refreshed on every health tick (before the ensureHealthy sweep) and at
 * connect; a throwing stub can't kill the interval; destroy zeroes the count.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getPublicKey } from "nostr-tools";
import { NostrManager } from "../servers/sharing/nostr.js";
import { getReceiveHealth, _resetReceiveHealth } from "../servers/sharing/receive-health.js";

const ourPriv = new Uint8Array(32).fill(1);
const identity = { secp256k1Pubkey: getPublicKey(ourPriv), secp256k1Priv: ourPriv };

const waitFor = async (fn, ms = 3000, step = 25) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, step)); }
  return fn();
};

test("_refreshRelayHealth counts only live sockets (not map size)", async () => {
  _resetReceiveHealth();
  const mgr = new NostrManager(identity, null);
  mgr.relays.set("wss://a", { connected: true });
  mgr.relays.set("wss://b", { connected: true });
  mgr.relays.set("wss://c", { connected: false });
  mgr.relays.set("wss://d", null);
  mgr._refreshRelayHealth();
  assert.equal(getReceiveHealth().relaysConnected, 2, "2 live of 4 entries");
  await mgr.destroy();
});

test("_doConnectRelays end-state uses the live count (direct call — the connectRelays wrapper early-returns on a non-empty map)", async () => {
  _resetReceiveHealth();
  const mgr = new NostrManager(identity, null);
  mgr.relays.set("wss://dead", { connected: false }); // survives the empty connect loop
  await mgr._doConnectRelays([]);
  assert.equal(getReceiveHealth().relaysConnected, 0, "size===1 but live===0 — the size-count mutation reddens here");
  await mgr.destroy();
});

test("health-loop tick refreshes the count both ways; throwing getter never kills the loop; destroy zeroes", async () => {
  _resetReceiveHealth();
  const prev = process.env.CROW_NOSTR_HEALTH_MS;
  process.env.CROW_NOSTR_HEALTH_MS = "50";
  const mgr = new NostrManager(identity, null);
  try {
    const stub = { connected: true };
    mgr.relays.set("wss://stub", stub);
    // A hostile entry whose getter throws — the tick must survive it (HARD REQ).
    mgr.relays.set("wss://evil", { get connected() { throw new Error("boom"); } });
    // Start the loop DIRECTLY with no registered subscription — a registered
    // resilient sub's ensureHealthy would call stub.connect() and resurrect it.
    mgr._startHealthLoop();
    assert.ok(await waitFor(() => getReceiveHealth().relaysConnected === 1), "tick counts the one live stub (evil getter swallowed)");
    stub.connected = false;
    assert.ok(await waitFor(() => getReceiveHealth().relaysConnected === 0), "tick notices the post-boot socket death (F-HEALTH-2)");
    stub.connected = true;
    assert.ok(await waitFor(() => getReceiveHealth().relaysConnected === 1), "tick recovers after reconnect");
    await mgr.destroy();
    assert.equal(getReceiveHealth().relaysConnected, 0, "destroy zeroes the count");
  } finally {
    if (prev === undefined) delete process.env.CROW_NOSTR_HEALTH_MS; else process.env.CROW_NOSTR_HEALTH_MS = prev;
    await mgr.destroy().catch(() => {});
  }
});
```

NOTE FOR THE IMPLEMENTER: if the throwing-getter entry makes the WHOLE tick abort under a naive implementation, that is exactly the RED the try/catch requirement exists for — the final implementation may catch per-iteration or whole-body (spec allows either) as long as the live stub is still counted OR the loop provably survives; if whole-body catch makes assertion 1 unreachable with the evil entry present, count entries defensively per-iteration (try around the getter access) so both hold. Choose the implementation that keeps all three assertions green.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/relay-signal-honesty.test.js`
Expected: FAIL — `_refreshRelayHealth` is not a function.

- [ ] **Step 3: Implement**

In `servers/sharing/nostr.js`:

1. New method directly ABOVE `_startHealthLoop` (~line 385; NOT in the 470-510 window — Cluster C's hunk):

```js
  /**
   * F-HEALTH-2: mirror LIVE socket state into receive-health. relay.connected
   * is the canonical liveness bit — enablePing flips it false on a silently-
   * dead socket (the same signal ensureHealthy keys on), and ensureHealthy's
   * relay.connect() flips it back true, so the count self-heals both ways.
   * Fully guarded: this runs synchronously inside the interval callback, and
   * an escaped throw there is an uncaughtException (per-entry try so one
   * hostile/broken relay object can't hide the others).
   */
  _refreshRelayHealth() {
    let live = 0;
    for (const relay of this.relays.values()) {
      try { if (relay && relay.connected === true) live++; } catch { /* count it dead */ }
    }
    try { setRelaysConnected(live); } catch { /* never escape the interval */ }
  }
```

2. In `_startHealthLoop`, at the TOP of the interval callback (before the `for` over subscriptions):

```js
    this._healthTimer = setInterval(() => {
      // F-HEALTH-2: refresh BEFORE the ensureHealthy sweep — the sweep
      // reconnects this same tick, and refreshing after it would erase the
      // degraded reading and re-hide the outage (the exact bug class this
      // fixes). Ordering is load-bearing; do not move below the loop.
      this._refreshRelayHealth();
      for (const h of this.subscriptions.values()) {
```

3. In `_doConnectRelays`, replace `setRelaysConnected(this.relays.size);` with:

```js
    // F-HEALTH-2: live count, not map size (defensive — at connect time they
    // match today because the wrapper only runs from an empty map, but a
    // relay dropping between .set() and here reads honest).
    this._refreshRelayHealth();
```

4. In `destroy()`, after the relays are closed/cleared, add:

```js
    setRelaysConnected(0); // a destroyed manager must not freeze a stale count
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/relay-signal-honesty.test.js tests/nostr-receive-health-hooks.test.js tests/nostr-resubscribe.test.js tests/receive-health.test.js tests/messages-health-signal.test.js`
Expected: ALL PASS (the four pre-existing suites pin the signal ladder + receive-path behavior).

- [ ] **Step 5: Commit**

```bash
git add tests/relay-signal-honesty.test.js
git commit tests/relay-signal-honesty.test.js servers/sharing/nostr.js -m "fix(sharing): messages signal mirrors LIVE relay socket state — refresh on every health tick, before the ensureHealthy sweep (F-HEALTH-2, the R7 follow-up)"
git show --stat HEAD
```

---

### Task 2: Full suite, boot check, mutation evidence

**Files:** none (evidence to `.superpowers/sdd/progress.md` — git-IGNORED).

- [ ] **Step 1: Full suite** — `node --test tests/*.test.js 2>&1 | tail -6`. Expected ≥ baseline (+3), the 1 pre-existing foreign fail only.
- [ ] **Step 2: Boot check** — `CROW_GATEWAY_URL=http://localhost:3097 PORT=3097 timeout 25 node servers/gateway/index.js --no-auth 2>&1 | head -50` — clean, no new warnings.
- [ ] **Step 3: Mutations** (apply → named test RED → revert → clean):

| # | Mutation | Test that must go RED |
|---|---|---|
| M1 | `_refreshRelayHealth`: count `this.relays.size` instead of live | test 1 ("2 live of 4") AND test 2 |
| M2 | remove the tick's `_refreshRelayHealth()` call | test 3 ("tick notices the post-boot socket death") |
| M3 | move the refresh call BELOW the ensureHealthy for-loop | must stay GREEN in test 3 (no sub registered) — instead verify by INSPECTION + the code comment; record that this mutation is guarded by comment + final review, not a test (the test can't see sweep ordering without a registered sub, and registering one resurrects the stub — documented limitation) |
| M4 | remove the per-entry try/catch (naive `relay.connected === true` without try) | test 3 (the evil-getter entry throws → loop dies or count wrong) |
| M5 | remove `setRelaysConnected(0)` from destroy() | test 3 final assertion |

- [ ] **Step 4: Append evidence to the progress ledger.**

---

## Post-implementation (controller)

1. Final whole-branch Opus review → PR → Kevin gate.
2. Post-merge deploy fleet; live E2E per spec §5: `ss -K` the relay sockets on black-swan, poll the nest signal at ≤10s cadence over ~2 minutes — expect ok → degraded/warn (latched exactly one ~45s tick) → ok.
