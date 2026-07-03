# Messages R8 + R7 (+ R3-residual) — "receive path is robust and observable" (design spec)

> **Status: DESIGN (approved by operator 2026-07-03).** Next: writing-plans →
> execution plan in `docs/superpowers/plans/` (R5-plan format) → 2-round
> adversarial review → subagent-driven execution → final review → PR → deploy.
> This closes **Phase 1** of the Crow Messages usability arc.
> Master plan: `docs/superpowers/plans/2026-07-01-crow-messages-usability-arc.md`.
> Failure map: `.superpowers/messages-plan/delivery-failure-map.md` (L1–L12).

## Why

Phase 1b shipped the full delivery-hardening chain (L6 #126, R2 #129, R4 #130,
R5 #131, Task 6 relay #132) — a DM now either arrives or the sender sees it
didn't, and offline recipients are covered by the self-hosted long-retention
relay. **But one severe silent-loss mode remains: the recipient can boot deaf.**

`servers/sharing/boot.js:335` wraps the **entire** receive path in
`peerManager.start().then(...)`. If the Hyperswarm/DHT `peerManager.start()`
rejects at boot, the `.catch` at `boot.js:546` does nothing but
`console.warn("[sharing] PeerManager start failed")` — and **no Nostr
subscription is ever wired**. The gateway then receives *nothing*, forever,
until a manual restart, with no health signal and no notification. This is **L11**
(the map lists it among the four most-likely real-world causes) and it quietly
negates the entire Phase-1b investment: all the delivery machinery is worthless
if the recipient's gateway never subscribed.

PR #115's self-heal (`makeResilientSub`/`ensureHealthy` in
`resilient-subscribe.js`) does **not** cover this: it recreates a *dropped
socket* on a sub that was already created; it cannot heal a subscription whose
*creation code never ran*.

## Scope (locked with operator 2026-07-03)

| # | Decision |
|---|---|
| S1 | **R6 deferred** — this plan is R8 + R7 + R3-residual only. R6 (per-contact reconnect cursor / backfill overlap, L2/L7) becomes its own small fast-follow PR. |
| S2 | **R3-residual = nest health signal only** — no new Messages settings section. The signal's relays-connected surface satisfies the observability need. |
| S3 | **R8 = Nostr receive path only** — decouple Nostr subscription wiring so DM receipt survives a `peerManager.start()` rejection. Hyperswarm/instance-sync retry is **out of scope** (logged as a follow-up). |

DMs are Nostr kind:4 (map, verified) and need no Hyperswarm, so the decoupling is
safe: instance-sync (Hypercore replication) legitimately depends on
`peerManager.start()`, DM receipt does not.

## Components

### 1. `wireNostrReceive(deps)` — the split (R8)

Extract the Nostr receive wiring out of the `peerManager.start().then()` block so
it runs **unconditionally** at boot, independent of Hyperswarm:

```
wireNostrReceive(deps)                         // NEW, runs regardless of peerManager
  ├─ for each non-blocked contact: subscribeToContact (Nostr only)
  │     · respect request_status exactly as today:
  │         'pending'  → skip (broad subscribeToIncoming still receives it)
  │         'accepted' → subscribeToContact only (secp-only; no ed25519)
  │         NULL(full) → subscribeToContact
  ├─ subscribeToIncoming(...)                  // preserves subs-first→relay-reuse ordering
  ├─ on success: setReceiveWired(true)
  └─ on throw:   setReceiveWired(false, err) + schedule bounded-backoff retry
                 (15s → 30s → 60s → … → 5min cap, unref'd timer, self-limiting)

peerManager.start().then(async () => {         // now Hyperswarm-ONLY responsibility
  for each full contact: joinContact + syncManager.initContact
  ... instance-sync feeds ...
}).catch(warn)                                 // a rejection here NO LONGER kills DM receipt
```

- The current single per-contact loop (`boot.js:341–380`) is split: the **Nostr
  `subscribeToContact`** calls move into `wireNostrReceive`; the **Hyperswarm
  `joinContact` + `syncManager.initContact`** calls stay in the
  `peerManager.start().then()` block (full contacts only). Two loops over the
  same `contacts` query — minor duplication, clearer boundaries.
- Ordering preserved: `subscribeToContact` loop **before** `subscribeToIncoming`
  (the existing comment at `boot.js:382` notes relay connections are reused).
- `connectRelays()` is already never-throw (falls back to `DEFAULT_RELAYS` on a
  DB-read failure, `nostr.js:569`), so wiring rarely throws; the retry exists for
  the case where `subscribeToIncoming` itself rejects (relay socket setup, etc.).

### 2. `servers/sharing/receive-health.js` — per-process state carrier (R8 + R7)

A new pure module: a per-process singleton mirroring the `isAuditDegraded()`
precedent in `shared/cross-host-auth.js` (which `federationAuditSignal` already
reads with a plain import, no DB). Holds:

```
{ receiveWired: boolean|null,   // null = not yet attempted; false = failed; true = wired
  lastError: string|null,
  relaysConnected: number,      // mirror of nostrManager.relays.size after connectRelays
  lastInboundAt: number|null }  // epoch ms, stamped on each decrypted inbound DM
```

Setters called by the sharing layer:
- `boot.js` / `wireNostrReceive` → `setReceiveWired(bool, err?)`.
- `nostr.js connectRelays()` → `setRelaysConnected(this.relays.size)` after connect.
- `nostr.js` inbound decrypt path → `markInbound(now)` on each successfully
  decrypted DM.

**Read with a plain import — never instantiate the sharing client.** This is the
deliberate avoidance of the QW2 trap (importing the live sharing client spins up
relay sockets that never let the process exit — it hung the test suite 44 min).

### 3. `messagesSignal(db)` — the signal (R7 + R3-residual)

New collector appended to `servers/gateway/dashboard/panels/nest/health-signals.js`
and added to the `collectHealthSignals` `Promise.all` array. The existing
`post-listen.js` health-monitor loop then picks it up for **both** the nest render
**and** the `shouldNotify` → `createNotification` path — so R8's "loud
notification when the receive path is down" costs **zero** new plumbing.

Reads: the `receive-health` module (no client import) + one cheap `COUNT` on
`message_retry_queue` (the R5 table) for the pending-outbound display.

Conditions evaluated **in order** (first match wins):

| # | condition | state | issueLabel / value |
|---|---|---|---|
| 1 | `receiveWired === null` (never attempted / sharing disabled) | **off** | no issue — never a false warn on a non-messaging install |
| 2 | `receiveWired === false` | **warn** | "Crow isn't receiving messages" (R8's loud signal); action → nest/restart |
| 3 | `relaysConnected === 0` | **warn** | "No message relays connected" (can't send or receive) |
| 4 | otherwise (wired, ≥1 relay) | **ok** | value = `"{N} relays · last in {age}"` (or `"{N} relays"` if never) |

**False-alarm discipline (load-bearing):**
- A **quiet mailbox is normal** — `lastInboundAt` age is **display-only, never
  warns**. Silence is the common case for a household, not a fault.
- **Unacked-outbound backlog** (the `message_retry_queue` COUNT) is a **display
  detail, not an issue** — a DM queued for a legitimately-offline recipient is
  expected behaviour (that is exactly what R5 built).
- Only a **failed-to-wire receive path** or **zero connected relays** warns (rows
  2–3 above); an install that doesn't use messaging stays `off` (row 1).

R3's residual observability ("show relay state") is satisfied entirely by this
signal's relays-connected surface. No new settings section (S2).

## Data flow

```
boot:  wireNostrReceive() ──sets──▶ receive-health ◀──reads── messagesSignal(db)
          │                              ▲                          │
          │ subscribeToContact/Incoming  │ setRelaysConnected       ▼
          └───────────────▶ nostr.js ────┘ markInbound      collectHealthSignals
                                                                    │
                              post-listen health monitor ──────────┘
                                    └─ shouldNotify → createNotification (warn only)
```

## Error handling

- Every path never-throws, matching `health-signals.js` convention: a failing
  `messagesSignal` degrades to `state:"off"` via the existing per-collector
  `.catch` wrapper (`health-signals.js:609`).
- The retry timer is `unref()`'d and self-limiting (5-min cap), so it can never
  hold the process open or busy-loop.
- No behavioural change to `connectRelays` (already resilient) or to
  `subscribeToContact`/`subscribeToIncoming` internals — only *where* they are
  called from.

## Schema / deploy

**No schema change** — the health state is in-memory (`receive-health.js`) and
`message_retry_queue` already exists (R5). → **No `SCHEMA_GENERATION` bump**,
plain-restart deploy on crow (restart `crow-gateway.service`, verify `/health`
200 + `[nostr] Subscribed to incoming on N relay(s)` + `PRAGMA integrity_check`).

## Testing

- **R8 decouple:** inject a `peerManager` stub whose `start()` *rejects* → assert
  `subscribeToIncoming` still ran and `receiveWired === true` (DM receipt survives
  Hyperswarm failure). Second test: wiring throws → assert `receiveWired === false`
  + a retry was scheduled (injectable timer).
- **R7 signal:** `health-signals` tests driving the `receive-health` setters —
  warn when `receiveWired` false; warn when `relaysConnected === 0`; ok + value
  when healthy; **quiet-mailbox (old `lastInboundAt`) stays ok**; `receiveWired
  null` → off (no issue).
- **i18n:** `signals.messages.*` strings, EN + ES, matching sibling style in
  `shared/i18n.js`.
- **Optional regression (Gitea harness, not the crow PR):** a scenario booting
  black-swan with a forced `peerManager` failure that still receives a DM — added
  to `feat/messages-p1a-harness` (the permanent regression net).

## Task shape (for writing-plans)

~4 subagent-driven tasks, one PR, plain-restart deploy:
1. `receive-health.js` module + `nostr.js` mirror hooks (`setRelaysConnected`,
   `markInbound`) + unit tests.
2. `boot.js` split — `wireNostrReceive` (decouple + bounded-backoff retry) +
   Hyperswarm-only `peerManager.start().then`; decouple test (rejecting stub).
3. `messagesSignal(db)` in `health-signals.js` + `collectHealthSignals` wiring +
   `signals.messages.*` i18n EN/ES + signal tests.
4. Verify (full suite + isolated gateway boot) → final whole-branch review (opus).

## Follow-ups (out of scope, logged)

- **R6** — reconnect-window correctness (L2/L7): per-contact last-received
  `created_at` + backfill overlap on resubscribe. Own small PR.
- **`peerManager.start()` retry** — self-heal the Hyperswarm/instance-sync path
  from a boot failure with bounded backoff (S3 deferred this).
- Optional: extend the Gitea harness with the R8 forced-failure scenario.
