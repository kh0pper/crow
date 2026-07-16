# 2c follow-up pool (F1–F6) — design spec

**Date:** 2026-07-15 · **Status:** rev 3 (rounds 1+2 adversarial findings folded — BUILD-READY)
**Scope:** the six follow-ups pooled in the arc plan §4 Item 2c block, Kevin-approved
2026-07-15 as one batch PR (except F6, which is an uncommitted working-tree edit — see §F6).
**Branch:** `fix/2c-followup-pool` · **No schema bump** (no rail needed).

Baselines this PR must not regress: suite 1974 pass / 2 known fails
(bundles-validate-install) / 0 skips on scratch env; sync_conflicts 219/183/162/0.

---

## F1 — uncaught `SendingOnClosedConnection` crashes the gateway (URGENT-ish)

### Incident
2026-07-15 23:49:26 (during the 2c deploy): grackle's gateway process died once with an
unhandled rejection:

```
SendingOnClosedConnection
  Relay.send → Subscription.fire → Relay.subscribe → doSubscribe (resilient-subscribe.js:54)
  → NostrManager.subscribeToContact (nostr.js:600) → wireFullContact (contact-promote.js:85)
```

### Mechanism (verified against vendored nostr-tools 2.23.3)
- `AbstractRelay.send()` is an **async** method that `throw`s `SendingOnClosedConnection`
  when `connectionPromise` is null (`node_modules/nostr-tools/lib/cjs/index.js:856-858`).
  Because the method is async, that throw is a **rejected promise**, never a synchronous
  exception.
- `Subscription.fire()` calls `this.relay.send(...)` **without await or catch**
  (`index.js:1090`). The rejection is orphaned → Node's default
  `--unhandled-rejections=throw` kills the process.
- The `try/catch` in `resilient-subscribe.js` `doSubscribe()` cannot catch it (async
  rejection, not a sync throw).
- **The deterministic hole:** `makeResilientSub()` calls `doSubscribe()` at construction
  (line 62) with **no `connected` guard**. `wireFullContact → subscribeToContact`
  constructs subs on relays that may have dropped between connect and wire — exactly the
  crash stack. The `ensureHealthy()` path already checks `relay.connected` with no await
  before `doSubscribe()` (lines 85-86), so it is safe today.
- **R1-1.2: a second unguarded path exists outside makeResilientSub** —
  `scripts/pi-bots/gateways/nostr-client.mjs:93-99` exports a raw `subscribe()` that
  calls `relay.subscribe(...)` directly. Same crash class, in the **pi-bots host
  process**.

### Invariant that makes a `connected` guard sufficient (R1-1.1: verified, incl. the
residual path)
In nostr-tools 2.23.3, `relay.connected` (getter over `_connected`, `index.js:715`) and
`connectionPromise` are mutated together at every synchronous quiescent point (`onopen`
sets `_connected=true` inside the live executor; `handleHardClose` clears both;
`onerror` clears `connectionPromise` while `_connected` is still false; `close()` sets
`_connected=false` leaving `connectionPromise` stale — the harmless inverse). So
`connected === true` ⇒ `connectionPromise` non-null, and a check-then-call with **no
await between** cannot interleave (single-threaded). Residual: `send()`'s internal
`connectionPromise.then(() => this.ws?.send(...))` on a CLOSING/CLOSED ws silently
drops in `ws` (no throw, no emit) — no crash there either. Same argument
safe-relay-publish.js already relies on.
Also verified and RECORDED so it isn't re-derived: `Subscription.close()`'s send is
guarded by `this.relay.connected` (index.js:1101) → safe under the same invariant;
`resilient-subscribe.js` `close()` likewise.

### Change C1a — guard `doSubscribe()`
In `servers/sharing/resilient-subscribe.js`:

```js
function doSubscribe() {
  if (!relay.connected) { sub = null; return; } // ensureHealthy retries next tick
  ...existing body...
}
```

Single choke point covering construction + ensureHealthy (redundant in the latter —
fine). A skipped construction-time subscribe is healed by the caller's existing periodic
`ensureHealthy()` loop.

### Change C1a′ (R1-1.2) — guard the raw pi-bots `subscribe()`
`scripts/pi-bots/gateways/nostr-client.mjs` raw `subscribe()`: skip relays where
`!relay.connected` (same no-await check-then-call). Its callers already tolerate
per-relay skip (multi-relay fan-out).

### Change C1b — process-level narrow net (defense in depth)
The guards remove the deterministic triggers, but library-internal `fire()` paths we
cannot wrap (e.g. future nostr-tools changes) would still be fatal. Add a narrowly-scoped
handler, installed via an **exported, idempotent function** (module-level once flag) in
a shared module (e.g. `servers/sharing/nostr-crash-guard.js`):

```js
let installed = false; let swallowed = 0;
export function handleRejection(err) {           // exported for unit tests (R1 test note)
  if (err?.name === "SendingOnClosedConnection") {
    swallowed++;
    // Rate-limited observability (R1-1.4): don't let a stuck-relay loop hide
    // behind one warn — log count at 1, 10, 100, 1000, ...
    if (Number.isInteger(Math.log10(swallowed))) {
      console.warn(`[nostr] swallowed SendingOnClosedConnection #${swallowed} (relay dropped mid-send)`);
    }
    return true;
  }
  return false;
}
let listener = null;
export function installNostrCrashGuard() {
  if (installed) return; installed = true;
  listener = (err) => { if (!handleRejection(err)) throw err; }; // crash-on-unknown preserved
  process.on("unhandledRejection", listener);
}
// R2-2: test-only uninstall — a permanent throwing global listener in the node:test
// process would fight the runner (a stray non-nostr rejection in ANY later test in the
// file becomes an uncaughtException attributed to no test). Tests MUST uninstall in
// finally; prod never calls this.
export function uninstallNostrCrashGuard() {
  if (listener) process.off("unhandledRejection", listener);
  listener = null; installed = false; swallowed = 0;
}
```

Install sites (R1-1.3, both processes that run nostr):
1. gateway: sharing manager init (where NostrManager is constructed);
2. pi-bots host: inside `nostr-client.mjs` at connect/start (imported by
   `crow-messages.mjs`, whose `start()` runs in `gateway_runner.mjs` — the one pi-bots
   process that talks nostr; bridge_tick/discord_gateway never do — T1 review
   correction).

Verified 2026-07-15: NO unhandledRejection or uncaughtException handler exists anywhere
in servers/ or scripts/pi-bots/ today — throw-inside-handler → uncaughtException →
default fatal, same observable outcome (process dies, systemd restarts). `err.name` is
reliable (class sets it in its constructor, index.js:654-657). Masking risk accepted
consciously: the name is library-specific and the rate-limited counter keeps a
runaway-swallow loop visible (R1-1.4).
**Consequential comment fix:** `tailnet-sync.js:532-533` ("no unhandledRejection handler
exists in servers/") becomes false after C1b — update that comment in the same task.

### Tests (RED first)
- G-F1-1: stub relay with `connected=false` whose `subscribe()` mimics nostr-tools'
  ASYNC-throw shape — it must orphan a rejection out-of-band (e.g. an un-awaited
  `(async () => { throw new SendingOnClosedConnectionStub(); })()` inside subscribe),
  NOT a sync throw (a sync throw is caught by the existing try/catch and passes against
  OLD code — vacuous; R1 test note). Construct `makeResilientSub` → no
  unhandledRejection (test installs/removes its own capture handler), `sub` stays null;
  flip `connected=true` → `ensureHealthy()` subscribes.
- G-F1-2 (mutation check): comment out the C1a guard → G-F1-1 goes red via the
  rejection capture.
- G-F1-3: unit-call the exported `handleRejection`: name-match → true (swallow);
  other error → false (caller rethrows). NO real process-event emission (flaky, kills
  the runner; R1 test note). Install-idempotence: `installNostrCrashGuard()` twice →
  one listener (`process.listenerCount`).
- G-F1-4: pi-bots raw-subscribe guard — same stub as G-F1-1 against `nostr-client.mjs
  subscribe()`; mutation check by reverting the guard.

## F2 — apply-path unbounded network awaits (general audit + bounds)

The 2c incident class: an inbound-entry apply hook awaiting a network operation without
a bound wedges either boot (via the boot drain) or the live apply loop. PR #195 bounded
the two known: 10s boot-drain cap (`_drainInboundCapped`, instance-sync.js:924 — used
ONLY by `reemitContactTombstones`), 5s-per-step unwire teardown caps
(`withStepCap`, contact-delete.js:161-168).

### Audit findings (full apply-path trace + round-1 corrections)

**A2-1 [BOOT- and LIVE-BLOCKING — the real F2]. Notification push fan-out is
timeout-less.** Two awaited chains from `_applyEntry` reach `createNotification`
(`servers/shared/notifications.js`): messages via `_notifyMessageApplied`
(instance-sync.js:2275) and conflicts via `_notifyConflict` (8 call sites; body :2675).
`createNotification` awaits, **serially**: `sendPushToAll` → `web-push.js:52-76` loops
`webpush.sendNotification` over EVERY push_subscriptions row with no timeout —
**R1-2.3: the fan-out compounds serially, so N half-open endpoints = N×cap even with a
per-send timeout**; `sendNtfyNotification` → `ntfy.js:86 fetch()` no AbortController;
`sendEmailNotification` → `email.js:103 fetch()` (Resend) no signal. All three senders'
failures ARE caught today (verified: ntfy.js:85-93 and web-push.js:57-75 swallow
silently, email.js:102-123 logs) — a capped send == an already-tolerated failed send.

**A2-2 [BOOT-BLOCKING]. Three boot drains are uncapped.** Only the tombstone re-emit
drain got cap #1. `_backfillContactsOnceGated` (:786), `backfillGroupsOnce` (:1196),
`backfillProvidersForNewPeers` (:1003) all await `_processNewEntries` directly, before
HTTP listen (`mcp-mounts.js:137/148/160`).
**R1-2.4/2.5 (critical correction): the three drains are NOT equivalent under a cap.**
- contacts backfill re-emits **lamport-preserving** (:817) and groups likewise
  (`preserveLamport: true`, :1214) → a capped drain degrades to truthful, deferred
  convergence. Safe; their unconditional done-flag writes keep their existing semantics.
- providers backfill re-emits with a **FRESH mint** (:1034; `EXCLUDED_COLUMNS.providers`
  strips `lamport_ts` from the wire, :94) and its I-B1 pre-drain exists precisely to
  avoid re-emitting stale rows over a peer's newer edit (:1000-1008). Verified apply
  semantics: `_applyInsert` is INSERT OR IGNORE — the incoming stale row is **never
  applied** over an existing peer row, so there is NO data loss; the harm is a
  **spurious (though truthfully-labeled) unresolved conflict row on the peer**
  (`_insertConflictRow` fires when data differs, :~1116-1131) — i.e. sync_conflicts
  baseline growth, our red-flag metric. NOTE: this exposure ALREADY exists today when
  the I-B1 drain throws (its catch proceeds to emit); the cap must not widen it.

**A2-3 [background leak only — NOT boot/live-blocking].** `wireFullContact`
(contact-promote.js:77) is dispatched fire-and-forget from `_afterContactApplied`
(:2192). Inside it (R1-2.6 corrections):
- `syncManager.initContact` → hypercore `ready()` is **local disk I/O, not network** —
  and MUST NOT be capped: `_initContactInner` (sync.js:70-90) registers feeds in
  `outFeeds`/`inFeeds` only AFTER `await ready()`; an abandoned Hypercore instance holds
  the rocksdb dir lock, so a capped-then-retried init hits the known
  concurrent-same-dir lock error (2d Q4 probe) — capping setup here can wedge the
  contact's feed until restart. OUT of C2c.
- `peerManager.joinContact` → `discovery.flushed()` (peer-manager.js:78-79) IS an
  unbounded network await (DHT announce confirmation). Safe to cap: `topics.set` happens
  BEFORE `swarm.join`, and the announce still fires — only the confirmation await is
  abandoned.
- `subscribeToContact` already 10s-bounded via `connectRelays`.

**Already bounded / no change:** unwireContact steps (cap #2); nostr connectRelays (10s
per relay); feed-rotation close race (5s, 2d); all DB-only apply handlers.
**Known adjacent gap, deliberately out of scope (R1 item 10):** the Nostr inbound path
(`boot.js onSocialMessage` → room fan-out relay publish) can stall a relay's message
loop; not reachable from `_applyEntry`. Recorded here so it isn't silently omitted;
candidate for a future pool.

### Changes
- **C2a — bound the notification senders at the SENDER level** (bounds every caller):
  - ntfy + Resend fetches: `AbortController` + 10_000 ms timeout (timer cleared on
    completion).
  - web-push: pass `timeout: 10_000` in `sendNotification` options — supported by
    vendored web-push@3.6.7 (web-push-lib.js:222-223 → 356-358 → destroy-on-timeout
    :395-398; rejects → existing catch). **Units are ms; it is a socket-IDLE timeout,
    not an overall deadline — a slow-drip endpoint evades it; accepted for the half-open
    failure mode (R1-2.2).**
  - **R1-2.3 — bound the fan-out, not just the send:** `sendPushToAll` switches from a
    serial await-loop to `Promise.allSettled` over the per-subscription sends (each
    individually try/caught as today, preserving per-endpoint cleanup semantics such as
    410-pruning — READ the loop body before converting). Overall bound ≈ one send cap
    instead of N×cap. Push has no cross-endpoint ordering semantics.
- **C2b — cap the three uncapped boot drains** via `_drainInboundCapped` (same 10s
  `_drainCapMs`), with per-drain contracts (R1-2.4/2.5):
  - contacts + groups: route through the cap; keep their unconditional done-flag writes
    (their re-emits are lamport-preserving — capped-drain degradation is truthful
    deferred convergence, the #195 semantics).
  - providers: **defer-on-cap with a bounded escape hatch (R2-1).**
    `_drainInboundCapped` already returns a boolean (:922/934/936) and its sole caller
    ignores it — providers consumes it with zero change to the tombstone path (R2
    verified). If the drain did NOT complete: skip the re-emit, and record the deferral
    by writing the per-peer flag as `deferred:<n>` (UPSERT; only `done:*` is terminal,
    so this stays retryable). **After 3 consecutive deferrals, proceed to emit anyway**
    (today's tolerated exposure: INSERT OR IGNORE means no data loss, at worst
    truthfully-labeled spurious conflict rows) and write `done:*`. Without the escape
    hatch, one always-slow inbound feed would permanently block providers backfill to
    EVERY new peer — a functional regression vs today's emit-on-drain-failure (R2-1:
    peer B could never route to this instance's models). Deferral bounded ⇒ worst
    added noise is one boot's worth, same as today's failure mode.
  **True boot bound, stated honestly (R2-3):** the pre-listen path runs TWO capped
  drain-loops over the same feeds (tombstone re-emit + providers pre-drain) plus the
  per-contact `joinContact → flushed()` loop (boot.js:730-744, capped by C2c). A wedged
  feed's `_processLocks` chain is inherited by the second loop, so worst case ≈
  `2 × N_wedged_feeds × 10s + N_contacts × 10s` — finite (the goal), NOT a flat 10s.
  Deduping the two drain loops was considered and DECLINED: it couples the tombstone and
  providers premise semantics for a constant-factor win on an already-bounded path.
- **C2c — cap ONLY `discovery.flushed()`** inside `peerManager.joinContact` (10s, timer
  cleared on win; the topic registration and announce precede it). Do NOT cap
  `initContact` (see A2-3). `withStepCap` stays a teardown-only primitive.
  **Build-time extension (T4 finding, folded):** `joinInstanceSync()` (peer-manager.js
  ~:129) carries the IDENTICAL unbounded `flushed()` on the same boot path
  (boot.js:754) — same cap applied, gate G-F2-4b. Deliberate semantic delta from
  withStepCap, both sites: flushed() REJECTIONS still propagate (both callers already
  try/catch); only the hang is capped — setup keeps its error semantics, teardown
  swallows.

### Tests (RED first)
- G-F2-1: hung-socket tests against REAL senders where reachable (R1 test note): a
  local HTTP server that accepts and never responds → ntfy and email paths complete
  ≤ cap (AbortController fires). web-push: hung local endpoint if the lib accepts a
  plain-http endpoint URL in test; if not, assert the options object passed to
  `webpush.sendNotification` carries `timeout: 10000` (accepted deviation, recorded).
  Mutation check: remove the abort/timeout → named test red (hang → test timeout).
- G-F2-2 (providers defer-on-cap): construction constraints (R2-5, anti-vacuity): the
  harness MUST arm BOTH maps — an unflagged peer in `outFeeds` AND a hung `inFeeds`
  entry — because :977 early-returns before the drain when `outFeeds` is empty (a
  test that hangs only inFeeds is vacuous green). The barrier parks at FEED-DELIVERY
  level (delay the feed `get`/apply delivery — 2d T7 lesson), NOT notification level
  (C2a now caps notifications at 10s, which would mask the hang and race the drain
  cap). Assertions: capped → no emissions, flag = `deferred:1`; un-park → next run
  emits + `done:*`; third consecutive deferral → emits anyway + `done:*` (escape
  hatch). Mutation checks: revert defer-on-cap → flags written under cap, red; remove
  escape hatch → 3rd-deferral assertion red.
- G-F2-3 (contacts/groups under cap): same feed-delivery barrier → drain capped,
  backfill still emits lamport-preserving entries and writes flags (existing
  semantics), boot path returns ≤ cap.
- G-F2-4 (flushed cap): `joinContact` with a never-resolving `discovery.flushed()`
  (REAL hyperswarm stub at the swarm.join boundary, not a stubbed joinContact —
  vacuity note) → returns ≤ cap, `topics` map contains the topic. Mutation check:
  remove the cap → red by timeout.

## F3 — dashboard Restore button not disabled for natural-key tables

`servers/gateway/dashboard/settings/sections/sync-conflicts.js` `renderConflictRow()`
disables Restore for `op='insert'` and for `crow_context`, but renders a live button for
`contacts` / `contact_groups` — the backend refuses these (C7
`NATURAL_KEY_RESTORE_REFUSALS`, sync-conflict-resolve.js:132-148), so the user gets a
click → refused flash instead of an upfront disabled state.

R1-3.1 verified: the dashboard section already imports from sync-conflict-resolve.js
(line 24) — no import cycle; the backend refusal fires before the stale guard for all
three tables and all ops, so UI-disable by table membership can never disable a restore
the backend would honor. Existing isInsert-first precedence stays (both branches match
the backend).

### Change
- Export `NATURAL_KEY_RESTORE_TABLES` (Set) from `sync-conflict-resolve.js`; derive
  `NATURAL_KEY_RESTORE_REFUSALS`'s coverage from it (single source of truth — UI and
  backend cannot drift).
- In `renderConflictRow()`: replace the `isCrowContext` special-case with set
  membership → muted italic label. Keep the crow_context-specific i18n key for
  crow_context; one new generic key (`syncConflicts.naturalKeyRestoreDisabled`) for
  contacts/contact_groups. i18n is a single file
  (`servers/gateway/dashboard/shared/i18n.js`) with inline `{en, es}` entries; `t()`
  falls back missing-lang → en → raw key (verified i18n.js:1674-1678). New key ships
  both en and es.
- Backend refusal stays (the button is UI sugar, the backend is the gate).

### Tests
- G-F3-1: render a conflict row for each of contacts/contact_groups/crow_context →
  no `<form` with `sync_conflicts_restore_other` in the output; a memories row still
  renders the button. RED first by asserting on current output. Mutation check: revert
  the render condition → named red.
- CDP live proof at deploy time (a curl 200 is not proof a page works).

## F4 — unreachable-pointer comment on the dead INSERT-branch group guard

`sync-conflict-resolve.js:313-342`: the statement-level `contact_groups` tombstone guard
in the INSERT branch became unreachable when 2c C7 added `contact_groups` to
`NATURAL_KEY_RESTORE_REFUSALS` (line 146 returns first). R1-4.1 verified. Per the 2a
lesson (a finding dropped as "unreachable" dies the moment a later change deletes its
premise), the guard STAYS; it gets a comment at the guard site:

```
// NOTE (2c-F4): currently UNREACHABLE — contact_groups is refused upstream by
// NATURAL_KEY_RESTORE_REFUSALS (search this file) before the stale guard / INSERT
// branch. KEEP THIS GUARD: if that refusal is ever relaxed (e.g. natural-key restore
// gets implemented), this statement-level tombstone check becomes load-bearing again —
// without it, Restore re-inserts a tombstoned group_uid and manufactures the
// resurrection zombie (2b design R2 F3').
```

Comment-only; no test. F3's export refactor touches the same file — sequence F4 in the
same task.

## F5 — `_pendingPeerEmits` RAM observability + soak check

State: 256-entry cap per peer with an overflow warn exists (instance-sync.js:1370-1373).
Prod check 2026-07-15: 0 overflow warns in crow's gateway log. Missing: any way to SEE
parked-queue sizes before overflow.

### Change
- Public `pendingEmitStats()` on InstanceSyncManager returning `{peerId: count}` for
  non-empty slots. **Hard requirement (R1-5.2): fully synchronous — a plain loop over
  the Map with no await points**, so it cannot interleave with `_chainAppendTask`
  mutations (which are the map's only writers).
- Call it from the existing 60s rescan loop in `tailnet-sync.js` `refresh()`, logging
  only when non-empty. **Wrapped in its own try/catch** (R1-5.2): refresh runs on a bare
  setInterval, and post-C1b an escaped throw becomes an unhandledRejection that the
  crash guard RETHROWS (non-nostr name) → crash.
- R1-5.1 verified: MPA runs tailnet-sync (post-listen.js:73-94, ungated for any gateway
  with an InstanceSyncManager) — the gauge is meaningful fleet-wide.
- Soak verification at deploy: line absent on crow/grackle/MPA under normal operation;
  recorded in the ledger.

### Tests
- G-F5-1: park entries for an unarmed peer → `pendingEmitStats()` returns the count;
  drain → empty object. Gauge line emitted via the exported `__refreshForTest`
  (tailnet-sync.js:569) — the gauge call goes AFTER the per-peer for loop in
  `refresh()`, so a zero-peer test still reaches it (R2 Q7). Nothing emitted when
  empty. Mutation check: remove the gauge call → named red.

## F6 — capstone-tracker ereader script-block interpolation (Kevin's WIP, uncommitted)

**R1-6.1 reframing (threat model corrected):** the block is
`<script id="er-data" type="application/json">` (ereader.html:964). The engine is
Jinja2 via Starlette `Jinja2Templates` (templates_config.py:11-18) with autoescape ON —
so `|e`/autoescape already entity-encodes `<`, and `&lt;/script&gt;` cannot terminate
the script element. **This is therefore a JSON-correctness + hardening fix, not a live
XSS**: today a title containing `&`, `<`, or `"` … lands entity-encoded (or, for a
double-quote, malformed) inside the JSON island → wrong/corrupt display data. `|tojson`
emits a correct JS/JSON literal AND escapes `<` (`<`), keeping the `</script`
hardening independent of autoescape config.

### Change (working-tree only — NEVER committed by this PR)
In the `er-data` JSON island, replace the five quoted `"{{ x|e }}"` title interpolations
(lines 972-981) with `{{ x|tojson }}` (dropping the surrounding literal quotes),
matching the file's own idiom at lines 790/985. The neighbouring raw/`|e` siblings in
the same island (`content_type`/`material_type`/`material_key`/`short_title`/
`source_id`/`cache_key`, lines 966-983) get the same treatment ONLY where they are
quoted-string contexts — one mechanical pass over the island; anything ambiguous is
left for Kevin with a note (his WIP, his call). The bundle is untracked: the edit lands
in Kevin's working tree and rides whenever he commits it. The batch PR must contain
zero capstone-tracker paths; verify with `git show --stat` on every commit plus
`git status bundles/capstone-tracker` (must remain untracked).

### Verification
Jinja2 renders `|tojson` on plain str safely (stdlib json + markupsafe escaping) —
mechanical inspection + (only if the bundle happens to be running on :8090) a manual
curl with a hostile title. No test harness exists for the WIP bundle; Kevin owns its
test story.

---

## Sequencing / task shape (SDD)

1. **T1 (F1)** — C1a guard + C1a′ pi-bots guard + C1b exported crash guard installed in
   both processes + tailnet-sync comment fix. RED G-F1-1..4.
2. **T2 (F2/C2a)** — sender-level timeouts + allSettled fan-out. RED G-F2-1.
3. **T3 (F2/C2b)** — cap three boot drains; providers defer-on-cap contract. RED
   G-F2-2..3.
4. **T4 (F2/C2c)** — flushed() cap in joinContact. RED G-F2-4.
5. **T5 (F3+F4)** — natural-key set export + UI disable + i18n (en+es) + F4 comment.
   RED G-F3-1.
6. **T6 (F5)** — pendingEmitStats + refresh gauge. RED G-F5-1.
7. **T7 (F6)** — working-tree-only ereader edit + untracked-ness verification.
8. Whole-branch review → gates → PR → merge → fleet deploy → live verify (CDP for F3;
   log-grep soak for F1/F5) → ledger/plan/memory updates.

## Risks

- **F1 stub fidelity**: G-F1-1's stub must orphan an ASYNC rejection (vacuous-test tell:
  a sync-throw stub passes against OLD code).
- **F1b global handler**: rethrow-on-unknown is load-bearing; the rate-limited counter
  keeps swallow volume visible. Any NEW same-name error class from other code would be
  masked — accepted (name is library-specific).
- **C2a allSettled conversion**: the current serial loop's per-endpoint bookkeeping
  (e.g. pruning dead subscriptions on 410) must survive parallelization — read before
  converting.
- **C2b defer-on-cap**: providers backfill must remain exactly-once-per-peer across the
  retry (flag semantics already give this; the deferral just delays flag-writing).
- **F3 i18n**: new key ships en+es in the single i18n.js.
- **F6**: any accidental `git add` of Kevin's WIP is a hard failure — checked at every
  commit via positional-path commits + `git show --stat HEAD`.

## Review record

- **Round 2 (fresh Opus subagent, 2026-07-15):** no new CRITICAL. 4 MUST-folds, all
  folded above: R2-1 providers defer-on-cap needed an escape hatch (3-deferral
  fallback to emit-anyway — without it one slow feed permanently blocks providers
  backfill to every new peer, a functional regression vs today); R2-2 crash guard
  needed a test-only uninstall (a permanent throwing global listener fights node:test);
  R2-3 true boot bound stated (`≈2×N_wedged×10s + N_contacts×10s`, dedupe declined);
  R2-5 G-F2-2/3 anti-vacuity construction constraints encoded (arm both maps;
  feed-delivery-level barrier). Accepted-and-noted: R2-4 (non-default
  `--unhandled-rejections` modes change the "same observable outcome" equivalence;
  fleet runs default). Re-verified round-1 holds: C1a heal path (both call sites start
  the health loop → no silent blackout), allSettled DB-safety (better-sqlite3 execute
  is synchronous; 410-prune survives), `_drainInboundCapped` boolean return
  (non-breaking), C2c all-callers-safe, F3 delete-op precedence, log10 counter at 1.
- **Round 1 (Opus subagent, 2026-07-15):** 1 CRITICAL (2.4 providers fresh-mint ×
  drain-cap interaction — folded as defer-on-cap after code verification downgraded
  "silent data loss" to "spurious conflict rows": `_applyInsert` is INSERT OR IGNORE,
  incoming never applied over an existing row), 5 MAJOR (1.2 pi-bots raw subscribe →
  C1a′; 1.3 pi-bots C1b install site → pinned; 2.3 serial fan-out → allSettled; 2.5
  flag contract → per-drain contracts; 2.6 withStepCap-on-setup → initContact excluded
  [rocksdb-lock hazard verified], flushed()-only cap), plus test-vacuity notes (G-F1-1
  async shape, G-F1-3 exported handler, G-F2-1 real-socket split, G-F2-4 boundary) and
  minors (1.4 rate-limited counter + stale comment; 2.2 ms units/socket-idle; 5.2 sync
  snapshot + try/catch; 6.1 threat-model reframe) — all folded above. Checks-out list:
  C1a invariant, web-push timeout support, F3 import-safety, F4 unreachability, F5 MPA
  coverage.
