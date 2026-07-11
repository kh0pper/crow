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
2. **Counts the map, not liveness:** even at connect time, `this.relays.size`
   counts stale entries from earlier connects (entries are only ever added or
   overwritten by URL, never removed), so the boot count itself can overcount.

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
   `CROW_NOSTR_HEALTH_MS` interval) — before the `ensureHealthy` sweep, so the
   signal reflects the pre-heal truth each tick and the next tick reports the
   healed state.

Honesty contract: the signal reflects live socket state within
≤ ping-timeout + one health tick (~45-60s) of a socket death, and recovers on
the tick after `ensureHealthy` reconnects. The S8 repro (kill all sockets)
now drives the signal to `[warn] "0 relays"` instead of a permanent green.

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
2. `connectRelays` end-state: pre-seed the map with a dead (`connected:false`)
   stub, call `connectRelays([])` → count is 0, not 1 (pins the overcount fix;
   the existing "mirrors relay count" test in nostr-receive-health-hooks stays
   green).
3. Health-loop tick refresh: `CROW_NOSTR_HEALTH_MS=50`, start the loop, flip a
   stub relay's `connected` false → poll until `relaysConnected` drops (bounded
   waitFor, no fixed sleep); flip back true → poll until it recovers.
   **Mutation:** removing the tick's refresh call must redden this.
4. Full suite ≥ current baseline (1385-class / 1 pre-existing foreign fail / 1
   skip); gateway boots clean.

## 5. Verification beyond the suite

Post-deploy live E2E (repeat the S8 probe that proved the finding): on
black-swan, kill all relay sockets (`ss -K`, deadman-armed per the unattended
-window rule if the window is long — here it is seconds and self-healing) →
the Messages nest signal must leave `[ok]` and show the degraded count/warn
within ~1 minute → sockets self-heal via ensureHealthy → signal returns to
`[ok] "4 relays"`. This is the exact scenario that stayed green in the
walkthrough.

## 6. Risks / review focus

- `relay.connected` getter semantics across nostr-tools versions (pinned
  dependency; ensureHealthy already relies on it — no new coupling).
- The refresh runs inside the interval callback — must never throw (wrap; a
  throw in an interval is an uncaughtException).
- Signal flap risk: a relay mid-reconnect at tick time shows a lower count for
  one tick — cosmetic, honest, and the warn threshold (0) makes flapping warns
  unlikely unless ALL relays are down (which deserves the warn).
