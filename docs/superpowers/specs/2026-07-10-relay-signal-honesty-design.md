# Relay-signal honesty — Cluster D design (F-HEALTH-2)

Date: 2026-07-10 · Arc: Crow Messages usability overhaul, P4 walkthrough Cluster D
Finding: F-HEALTH-2 [S8-MAJOR] — the messages nest signal is blind to post-boot
relay socket loss. Live-verified: all of black-swan's relay sockets were killed
(`ss -K`) and the signal stayed `[ok] "4 relays"`. This is the long-standing R7
follow-up. Independent of Clusters B/C.

## 1. Problem

`setRelaysConnected(this.relays.size)` runs ONLY at the end of
`connectRelays()` (servers/sharing/nostr.js:123). Two defects compound:

1. **Never refreshed:** `this.relays` is a Map populated at connect and never
   pruned; sockets die, `relay.connected` flips false (via `enablePing` — the
   PR #115 mechanism that is already load-bearing for `ensureHealthy()`), but
   `relaysConnected` keeps the boot-time value forever. The nest signal
   (health-signals.js:611, `relaysConnected === 0 → warn`) can effectively
   only fire for a boot-time all-relays-down.
2. **(Defensive only — R1 F2 correction):** the originally-claimed "stale
   entries from earlier connects overcount at boot" state is UNREACHABLE —
   `connectRelays` early-returns when the map is non-empty (nostr.js:84), so
   `_doConnectRelays` only ever runs from an empty map and `size === live` at
   line 123 today. Replacing the size-count with the live-count at connect is
   kept as defensive correctness (a relay that drops between `.set()` and the
   count reads honest), not as a bug fix. The REAL defect is #1 alone.

Meanwhile the receive path's own resilience (makeResilientSub + the 45s
`_startHealthLoop`) reconnects within seconds — delivery self-heals while the
signal lies. The operator-facing honesty is the missing half.

## 2. Non-goals

- No change to reconnect behavior (#115's `ensureHealthy` engine is untouched).
- No per-relay detail in the signal (it renders a count; partial outages show
  the honest lower count, warn stays keyed on 0 — unchanged threshold).
- No schema change — **SCHEMA_GENERATION stays 6**. No new env knobs (reuses
  `CROW_NOSTR_HEALTH_MS`).
- pi-bots' adapter keeps its own loop (it doesn't feed the gateway signal).

## 3. Design

One private helper on `NostrManager`:

```js
  /** F-HEALTH-2: mirror LIVE socket state into receive-health. relay.connected
   * is the canonical liveness bit — enablePing flips it false on a silently-
   * dead socket (the same signal ensureHealthy keys on), and ensureHealthy's
   * relay.connect() flips it back true, so the count self-heals both ways. */
  _refreshRelayHealth() {
    let live = 0;
    for (const relay of this.relays.values()) {
      if (relay && relay.connected === true) live++;
    }
    setRelaysConnected(live);
  }
```

Called from exactly two places:
1. **End of `connectRelays()`** — replacing `setRelaysConnected(this.relays.size)`
   (fixes the stale-entry overcount at connect time too).
2. **Top of every `_startHealthLoop` tick** (the existing 45s
   `CROW_NOSTR_HEALTH_MS` interval) — **before** the `ensureHealthy` sweep.
   **This ordering is LOAD-BEARING (R1 F5):** the same tick's `ensureHealthy`
   reconnects the socket; refreshed *after* the sweep, the reconnect would
   erase the degraded reading and re-hide the outage — the F-HEALTH-2 bug
   class reintroduced. Refresh-first latches the degraded count for one full
   tick. A code comment must pin this against future reordering.

Honesty contract (R1 F3 — pinned nostr-tools 2.23.3 defaults: pingFrequency
29s, pingTimeout 20s): the signal reflects a **hard close** (RST / `ss -K`)
within ≤ one health tick (~45s), and a **silent half-open** (NAT idle-drop)
within ≤ pingFrequency + pingTimeout + one tick (~95s). It recovers on the
tick after `ensureHealthy` reconnects. The S8 repro (hard kill) now drives the
signal to `[warn] "0 relays"` for at least one full tick instead of a
permanent green.

### Alternatives rejected

- **Event-driven decrement (relay onclose/onerror):** the exact approach #115
  disproved — close events do not fire on RST/half-open/idle-timeout paths;
  `enablePing` + polling is the proven pattern, and nostr.js:101-104 already
  documents `relay.connected` as "the ONLY signal ensureHealthy() has".
- **Compute at signal read time:** the nest signal reads `receive-health.js`,
  which is deliberately ZERO-imports (the pre-QW2 suite-hang trap); reaching
  into the live NostrManager from the gateway signal would reintroduce exactly
  the import-pulls-up-sharing-sockets hazard that module exists to prevent.
- **Prune dead relays from the Map:** changes `this.relays` consumers'
  semantics (send paths iterate it; `relays.size === 0` gates reconnects) for
  no signal benefit; counting liveness is strictly smaller.

### Loop-liveness precondition

`_startHealthLoop` is started by `subscribeToIncoming` / `subscribeToContact`
(nostr.js:552/717) — the receive boot always subscribes, so whenever the
messages signal is meaningful the loop exists. If receive wiring failed
entirely, `receiveWired=false` already warns with precedence over the relay
count (R8 ladder — unchanged). A manager that never subscribed (pure-send
usage) keeps the connect-time count, same as today.

## 4. Tests (TDD; mutation-test the guard)

1. `_refreshRelayHealth`: Map seeded with fake relays `{connected:true}` ×2 +
   `{connected:false}` ×1 + a null entry → `getReceiveHealth().relaysConnected === 2`.
   **Mutation:** reverting to `this.relays.size` must redden this.
2. Connect-path end-state (R1 F1 — the naive `connectRelays([])` version is
   VACUOUS: the :84 non-empty-map early-return skips `_doConnectRelays`
   entirely and the assertion passes off the reset state): pre-seed the map
   with a dead (`connected:false`) stub and call **`_doConnectRelays([])`
   directly** — the stub survives the empty connect loop, so `size===1` while
   live===0. Assert `relaysConnected === 0`. **Mutation:** reverting line
   ~123 to `this.relays.size` must redden THIS variant (a genuinely live
   guard).
3. Health-loop tick refresh (R1 F4 — start the loop via
   **`mgr._startHealthLoop()` directly with NO registered subscription**, or
   the same tick's `ensureHealthy` calls the stub's `connect()` which flips it
   back to connected and races the poll): `CROW_NOSTR_HEALTH_MS=50`, seed a
   connected stub in the map, start the loop, poll `relaysConnected===1`; flip
   `stub.connected=false` → poll until it drops to 0 (bounded waitFor, no
   fixed sleep); flip back true → poll until it recovers to 1.
   **Mutation:** removing the tick's refresh call must redden this.
4. Full suite ≥ current baseline (1385-class / 1 pre-existing foreign fail / 1
   skip); gateway boots clean.

## 5. Verification beyond the suite

Post-deploy live E2E (repeat the S8 probe that proved the finding): on
black-swan, kill all relay sockets (`ss -K`, deadman-armed per the unattended
-window rule if the window is long — here it is seconds and self-healing).
**Poll the nest signal at ≤10s cadence across a ~2-minute window (R1 F5)** —
the degraded state latches for exactly one health tick (~45s) before
`ensureHealthy`'s reconnect clears it, so a single glance can miss it. Expect:
`[ok] "4 relays"` → (≤1 tick) degraded count / `[warn] "0 relays"` →
(next tick) back to `[ok] "4 relays"`. This is the exact scenario that stayed
green in the walkthrough.

## 6. Risks / implementation requirements (R2-hardened)

- **HARD REQ (R2 #1):** `_refreshRelayHealth`'s body is wrapped in `try/catch`.
  It is the FIRST synchronous throw-surface in an interval callback that has no
  sync guard (the existing body is pure async-dispatch with per-promise
  `.catch`); an escaped throw is an uncaughtException — the "gateway silently
  dies" class this arc exists to kill. Tested with a throwing `.connected`
  getter stub.
- **HARD REQ (R2 #2):** place `_refreshRelayHealth` adjacent to
  `_startHealthLoop` (~:385) or after `_doConnectRelays` (~:125) — NOT in the
  ~:470-510 window, which is Cluster C (#160)'s onevent hunk; keeps the merge
  conflict-free in either order (B #159 doesn't touch nostr.js at all).
- **HARD REQ (R2 #3):** the health-loop test must `await mgr.destroy()` AND
  restore `CROW_NOSTR_HEALTH_MS` in `finally` (same-file state bleed; the
  50ms interval keeps writing the process-global count).
- **(R2 #4, cleanliness):** `destroy()` additionally calls
  `setRelaysConnected(0)` — not prod-reachable today (the manager is a
  lifetime singleton; destroy is test-only), but a destroyed manager must not
  freeze a stale count into the signal.
- `relay.connected` getter semantics across nostr-tools versions (pinned
  2.23.3; ensureHealthy already relies on it — no new coupling).
- Signal flap risk: a relay mid-reconnect at tick time shows a lower count for
  one tick — cosmetic, honest, and the warn threshold (0) makes flapping warns
  unlikely unless ALL relays are down (which deserves the warn).
