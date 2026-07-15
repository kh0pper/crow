# Item 2d — In-feed key rotation: live swap + applied-seq integrity

**Date:** 2026-07-15 · **Status:** rev 3 (R1+R2 findings folded; awaiting round-3 closure review) · **Author:** autonomous arc session
**Plan doc:** `docs/superpowers/plans/2026-07-11-opus-autonomous-arc.md` §4 Item 2d
**Prereq reading:** the 2a six-bug lesson (executable/multi-instance/mutual gates) and the 2c
boot-liveness lesson (no unbounded boot awaits) — both shaped this design.
**Review record:** §11.

## 0. TL;DR

When a peer's outbound Hypercore feed key changes (storage loss → hypercore mints a fresh
keypair), the receiving side today: (a) persists the new key but **never swaps the open
in-feed** — replication in that direction is silently dead until restart; and (b) even after
restart, keeps the **old feed's applied-seq high-water mark**, so every entry of the new feed
below that mark is **silently skipped forever**. This spec fixes both: a key-aware
`initInstance` that swaps the in-feed live (bounded, boot-safe), and an applied-seq record
that is keyed to the feed it was earned on — with the key **stamped by the feed being
processed** and the legacy/reset decision **frozen at feed-open time** (both R1 CRITICAL
fixes; §11).

No schema bump (the applied-seq store is an existing JSON TEXT column). No new transport or
trust surface.

## 1. The four questions the plan doc required answering from code

**Q1 — Which key rotates?** The per-peer **outbound Hypercore feed keypair**. It is minted by
hypercore itself (`crypto.keyPair()`, `node_modules/hypercore/lib/core.js:186`) the first time
the out-feed storage at `~/.crow/data/instance-sync/<peerId>/out` is created, and it lives
*only* in that feed's storage header — not in the DB, not derived from identity. Explicitly
NOT rotating: the shared instance-identity ed25519 (`identity.json` — signs handshakes and
entries; no rotation path exists and none is in scope) and Noise statics (`NoiseSecretStream`
is constructed per-connection without a keyPair → ephemeral).

**Q2 — What code path performs a rotation today?** None deliberately. Rotation is *implicit*:
any event that loses the `out/` storage while the pairing row persists — restore-from-backup
that misses `instance-sync/`, incident-recovery deletion of feed dirs, a data-dir migration —
causes the next `_initInstanceInner` (`servers/sharing/instance-sync.js:446`) to mint a fresh
keypair. Verified empirically: key-less reopen of existing storage resumes the same key;
key-less open of empty storage mints a new one. Additionally `crow_update_instance`
(`servers/sharing/tools/instances.js`) can rewrite `sync_url` by hand with no feed action.

**Q3 — How does a peer detect it today?** The feed-key exchange runs on **every** connection
on both transports and all three receipt points persist a changed key and call
`initInstance`:
- tailnet-sync server: `servers/sharing/tailnet-sync.js:249` (persist + initInstance :255)
- tailnet-sync client: `tailnet-sync.js:433–452`
- Hyperswarm challenge-response piggyback: `peer-manager.js:269/:301` →
  `boot.js:850 onInstanceKeyReceived` (persist :858, initInstance :867)

But `_initInstanceInner`'s in-feed guard is `!this.inFeeds.has(remoteInstanceId)`
(`instance-sync.js:459`) — with a stale-keyed feed already open, the call **no-ops**. That is
defect **D1**. After a restart the new key opens a fresh core (see Q4), but
`last_applied_seq_per_peer` (JSON blob in `sync_state`, keyed **by peer id only**,
`instance-sync.js:2652–2698`) still holds the old feed's high-water mark, and
`_processNewEntriesInner` starts its loop at that mark (`instance-sync.js:1408`) — every
entry of the new feed below it is silently skipped, forever. That is defect **D2**, and it
is the more dangerous of the two (silent divergence for `memories`, `research_notes`, etc.,
which have no re-emit healing).

**Q4 — What does "recreate the storage" mean for an open Hypercore?** Empirically (probes run
against the vendored hypercore 11.27.7, 2026-07-15): the feed directory is a **multi-core
store**, not a single-core store —
- Opening existing storage with a *different* key does **not** throw `STORAGE_CONFLICT`; it
  creates/joins a fresh core (length 0) alongside the old one.
- The old core's blocks remain readable by reopening with the old key (verified: 3 blocks
  survived a different-key open in the same dir).
- Key-less reopen resumes the original (default) core with its data — out-feed keys are
  stable across restarts.
- **Constraint:** a second core in the same dir cannot be opened while another core in that
  dir is open in the same process — rocksdb `File descriptor could not be locked`. So a live
  swap must close-then-open, and a hung close blocks the swap (mitigation in §3 C1).

So "recreate the storage" requires **no destructive filesystem operation at all**: close the
old in-feed session, open `new Hypercore(sameDir, newKey)`, reset the applied-seq. Old blocks
stay readable (acceptance's "existing blocks still readable" is satisfied by the store
itself).

## 2. Defect inventory

| # | Defect | Effect | Fixed by |
|---|--------|--------|----------|
| D1 | Open in-feed never swapped on key change (`!inFeeds.has()` guard) | That direction silently dead until restart | C1 |
| D2 | `last_applied_seq_per_peer` not keyed to the feed it was earned on | After restart, new feed's entries below the stale mark skipped forever — silent divergence | C2 |
| D3 | Manual `sync_url` edit (`crow_update_instance`) touches DB only | Live manager never notices | C4 (60s heal loop) |
| D4 | Rotated instance's once-flags (`__contacts_backfill_v1`, `__sync_reemit_allowlist_v2`) survive its own out-feed loss | Fresh out-feed never carries the catch-up backfill | C5 |

Live state note: crow's blob today is legacy-numeric — `{"49cf…": 2412, "520a…": 1109}`
(grackle, MPA). Black-swan is NOT a stale-feed case (its pairing was deliberately deleted
2026-07-11; crow holds no bswan row) — do not "heal" it.

## 3. Design

Changes live in `servers/sharing/instance-sync.js`, plus **two** line-level touches in
`tailnet-sync.js` (C4's refresh call, and the R1-F3 fix at `:238` — see C1) and one
insertion point in `servers/gateway/boot/mcp-mounts.js` (C5 ordering). Detection points are
otherwise untouched — they already call `initInstance` with the new key; the fix makes that
call honest.

### C1 — Key-aware in-feed open/swap (fixes D1)

In `_initInstanceInner`, replace the in-feed guard with key-aware logic:

```
const current = this.inFeeds.get(remoteInstanceId);
if (current && theirFeedKey && !current.key.equals(theirFeedKey)) {
  // ROTATION: detach, unmap, bounded close, then open the new core in the same dir.
  current.removeListener("append", this._inFeedListeners.get(id)); // per-peer stored ref (R2 #9)
  current.on("error", () => {});                     // swallow late close-races (R2 #9)
  this.inFeeds.delete(remoteInstanceId);             // entry-bail kills queued runs (R1 F1)
  const closed = await boundedClose(current, 5_000); // Promise.race close vs cap
  if (!closed) {
    // rocksdb lock still held by the zombie session — same-dir open below would
    // throw. Defer: loud log; sync_url is already persisted, so the next boot
    // heals (multi-core store + C2 open-time reconcile). Do NOT hang the chain.
    console.error(`[instance-sync] ROTATION DEFERRED for ${id}: old in-feed close timed out; restart will complete it`);
    this._deferredRotations.add(remoteInstanceId);   // suppress repeat open attempts (R2 #1)
    return this.outFeeds.get(remoteInstanceId);
  }
  console.warn(`[instance-sync] in-feed ROTATED for ${id}: ${oldKey8}… → ${newKey8}…`);
}
if (!this.inFeeds.has(remoteInstanceId) && theirFeedKey
    && !this._deferredRotations.has(remoteInstanceId)) {
  try {
    … open new Hypercore(dir, theirFeedKey), await ready() …
    await this._reconcileAppliedSeqAtOpen(remoteInstanceId, inFeed);  // C2 — ALWAYS, every open
    … wire append listener; store its ref in _inFeedListeners (R2 #9) …
    … attach to tracked live streams (C3) …
    this.inFeeds.set(remoteInstanceId, inFeed);
  } catch (err) {
    // R2 #1 (CRITICAL): an open failure must degrade to out-only, never throw
    // out of initInstance. Without this, a still-held rocksdb lock after a
    // deferred rotation turns every subsequent open attempt into a throw that
    // kills the tailnet client's whole handshake (both directions dead,
    // reconnect throw-loop) and, on the C4 interval, an unhandled rejection
    // that would CRASH the gateway once a minute (no unhandledRejection
    // handler exists in servers/).
    console.error(`[instance-sync] in-feed open failed for ${id}: ${err.message} — continuing out-only`);
  }
}
```

The `_deferredRotations` set suppresses repeated same-process open attempts against a dir
whose rocksdb lock is still held by the zombie session. The abandoned close promise keeps
a `.then(() => this._deferredRotations.delete(id))` attached — a close that was merely
SLOW (resolves after the cap) releases the lock and un-defers the peer, so the next
connection or C4 tick completes the rotation without a restart; a truly hung close keeps
the suppression until the restart that also releases the lock. The try/catch is the real
safety net: it also covers open failures from any other cause (disk, corruption) with the
same out-only degradation the spec promises. C4's per-peer `initInstance` call is
additionally wrapped in its own try/catch (defense in depth for the interval path).

Properties:
- Runs inside the existing `_initLocks` per-peer chain — no concurrent-swap races, and
  close cannot interleave with another `initInstance` (the serialization
  `closeInstanceFeeds` already relies on). Coordination with the **separate**
  `_processLocks` chain is NOT by locking — it is by the C2 stamping rules (see C2's
  interleave analysis), the listener removal, and `_processNewEntriesInner`'s
  feed-identity bail. This trio was R1 finding F1; the convergence argument is §3.1.
- **Bounded** (2c lesson): the only await added to a boot-reachable path is the 5s-capped
  close. A hung close (the real grackle incident class) degrades to today's dataflow
  (that direction receives nothing) with a loud, greppable log line — never a boot hang.
  The abandoned close promise's eventual resolution touches only the already-unmapped
  feed object (no Map access, no double-close hazard: `closeInstanceFeeds` tolerates
  closed feeds, and the swap already deleted the entry).
- Key validation via a shared helper called at all three receipt points **before the
  `sync_url` persist** (R2 #8 — validating only at open would persist a poison key that
  then fails every subsequent open): exactly 32 bytes (64 hex chars), and **not equal to
  our own out-feed key for that peer** (a peer echoing our key back would otherwise make
  us re-apply our own history — R1 F7; entries verify against the *shared* identity so
  they would apply). Malformed/self keys are logged and ignored — no persist, no open.
- **R1 F3 fix — the tailnet server's pre-exchange init no longer passes a key:**
  `tailnet-sync.js:238` becomes `initInstance(remoteInstanceId, null)`. That call's only
  job is arming the out-feed for `getOutFeedKey` (`:239`); passing the *snapshot*
  `peerRow.sync_url` read at `:222` was harmless under D1 but becomes a
  swap-back-to-stale-key vector once C1 is destructive (hyperswarm updates the key
  mid-handshake → the stale snapshot swaps it back → re-swap forward: thrash + double
  reset). The authenticated receipt at `:249-255` remains the swap driver. The tailnet
  *client* (`:435`) keeps passing its received key — that value is the fresh
  authenticated exchange, not a snapshot (its init-before-persist ordering is therefore
  safe). Boot/eager/refresh paths pass the persisted `sync_url`, which is authoritative
  at rest.
- The unmap-before-close ordering means `replicate()`/`getSyncStatus` see either the old
  feed (pre-swap) or the new one (post-swap), never a closing zombie.
- The rotated old core is left in the store (acceptance: blocks readable). GC is an
  explicit non-goal (§8).

### C2 — Feed-keyed applied-seq (fixes D2)

`last_applied_seq_per_peer` values change from `2412` (numeric) to
`{"k": "<feedKeyHex>", "s": 2412}`. This is a JSON-blob format evolution inside an existing
TEXT column — **no schema generation bump, no migration rail**.

**Writers.** `_setLastAppliedSeq(peerId, seq, feedKeyHex)` — the key is **threaded from the
feed being processed** (`_processNewEntriesInner` is the sole production caller, `:1418`),
NEVER read from "the current in-feed" (R1 F1: a stale processing run bound to the old feed
object must stamp the OLD key, so key-gated readers ignore it). The existing suite's direct
callers (`tests/instance-sync.test.js:288-293` etc.) are migrated to pass a key (R1 F6).

**Readers.** `_getLastAppliedSeq(peerId, feed)`:
- record `k === feed.key.hex` → return `s`; `k ≠ feed.key.hex` → foreign record → return 0.
- Display-only callers without a feed handle (`getSyncStatus` when the in-feed is not open)
  pass `feed = null` and get the raw `s` back — cosmetic, never gates application. Every
  `getSyncStatus` consumer of the blob unwraps `.s` (a raw-object read would make
  `pendingEntries = length - {object} = NaN` — R2 #7).
- A legacy numeric reaching a *processing* read is impossible after the open-time
  reconcile below; if seen (defensive), treat as foreign → 0.

**SQL note (R2 #7):** the current writer uses `json_set(..., ?, CAST(? AS INTEGER))`
(`:2691`); the object format requires `json_set(..., ?, json(?))` — keeping the CAST (or
passing a pre-stringified object without `json()`) stores a JSON *string*, and every
reader's `.s`/`.k` reads `undefined`. This is a named implementation checkpoint, mutation-
covered by G2 (a string-stored record makes the key-gate read return 0 forever → visible
as perpetual replay, and G4a's apply-count-0 assertion goes red).

**Open-time reconcile — the decision is frozen once, at feed open (R1 F2).**
`_reconcileAppliedSeqAtOpen(peerId, feed)` runs on EVERY in-feed open (boot, eager,
rotation, un-revoke), inside the `_initLocks` chain, before the append listener is wired:
- record is `{k,s}` with `k === feed.key.hex` → keep (normal restart).
- record is `{k,s}` with `k ≠ feed.key.hex` → rotated → write `{k: feed.key.hex, s: 0}`.
- record is legacy numeric `n`: compare against `feed.length` **at open** — a mark earned
  on feed F always satisfies `n ≤ F.length` (checkpoints write at most `seq+1 = length`,
  `:1408-1418`), and a rotated fresh core has `length 0` at open, before any replication
  can grow it (the listener isn't wired yet and `_processNewEntries` bails on unmapped
  feeds). `n > length` → provably foreign → `{k, s: 0}`; `n ≤ length` → plausibly this
  feed's → `{k, s: n}`. Either way the record is now new-format — the decision is **never
  re-derived against a growing length** (R1 F2's burst-crossing hole: a lazily-evaluated
  rule flips from reset to trust once a backlog batch pushes `length ≥ n` before the
  first checkpoint).
- residual, stated honestly: a peer that rotated *long before this code deploys*, whose
  fresh feed already regrew past the stale mark, is indistinguishable from a healthy feed
  (`n ≤ length`) — the pre-deploy gap is unrecoverable (§4.4). Post-deploy rotations
  always hit the `length 0 < n` or `k ≠` branches and are exact.

**Why not replay legacy feeds from 0 to heal past skips:** replaying a long-established
feed re-applies old `insert` entries for rows later deleted *locally with no tombstone
table* (`memories`, `research_notes`, …) → resurrection. Fresh (rotated) feeds carry only
post-rotation history, so reset-to-0 on an actual key change replays nothing stale.
2c's boot re-emits heal contacts/settings/groups/tombstones across boots; that class is
covered regardless.

#### 3.1 Interleave analysis (the F1 scenario, post-fix)

An in-flight `_processNewEntriesInner` bound to the OLD feed across a swap:
- Started pre-swap: it read its start seq under the old record (old key match) — it
  continues applying *old-feed* entries (legitimately emitted pre-rotation; signature-valid,
  LWW-gated, idempotent) and stamps `{k: old, s}`. If it stamps AFTER the swap's reset, the
  record's `k` flips to `old` — but every new-feed read is key-gated (`k ≠ new` → 0), so
  the worst case is the new feed re-processing entries `0..m` it already applied: a fresh
  rotated feed replayed from 0 is safe (post-rotation history only; LWW + conflict-dedupe
  make re-application convergent), and the first new-feed checkpoint rewrites `{k: new}`.
  Convergent under every interleaving; no divergence, bounded waste. One honest caveat
  (R2 #10): "the first new-feed checkpoint rewrites `{k:new}`" is not guaranteed terminal
  within the session — a slow old-feed run can land the LAST write as `{k:old}`; in that
  case convergence completes at the next reconcile (next open/boot) at the cost of one
  extra fresh-feed reprocess. Safe either way.
- Started post-swap (queued): `_processNewEntriesInner` **bails at entry** when
  `this.inFeeds.get(id) !== feed` (the swap deleted/replaced the entry) — no old-feed
  replay-from-0 (which WOULD have been the resurrection hazard), no stamp.
- Mid-loop after close: probe-verified (R2 #5), `feed.length` reads **0** after `close()`
  and `feed.get` throws `SESSION_CLOSED` — so an in-flight loop's `seq < feed.length`
  condition goes false and it terminates immediately on its next iteration. No poison-skip
  churn occurs; no per-iteration bail is needed (rev 2's was defending a mechanism that
  doesn't exist — dropped, YAGNI). The old feed's `.key` remains readable after close
  (probe-verified), so a post-close stamp still carries the OLD key and stays key-gated.

### C3 — Live-stream attach after swap

`replicate(remoteInstanceId, stream)` records the stream in
`_activeStreams: Map<peerId, Set<stream>>` (entry removed on the stream's `close` event,
AND the peer's whole set dropped by `_closeInstanceFeedsInner` — R2 #2: revoke closes
feeds but not transports, so without that teardown the set leaks per revoke/re-pair cycle
and a later swap would attach the new feed to a stale stream whose cores were all closed).
Memory bound: ≤ live transport connections per active peer, cleared on stream close and
on revoke. After a C1 swap, the new in-feed calls `.replicate(existingStream, {live:true})`
on every tracked live stream. This closes the Hyperswarm ordering hole: `onInstanceConnected` may
`replicate()` *before* the challenge-response key reaches `onInstanceKeyReceived`, so the
triggering connection would otherwise carry only the dead core. (On the tailnet paths the
key exchange strictly precedes `replicate()`, so the triggering connection there picks up
the new feed naturally.) Multiplexing an additional core onto an already-active stream is
standard hypercore protomux behavior — but the load-bearing case is attaching **after the
old core (which was replicating on that same stream) was just closed**; the gate exercises
exactly that precondition (G8, tightened per R1 F5).

### C4 — 60s convergence loop (fixes D3, belt-and-suspenders for everything)

`startTailnetSyncClients`' existing 60s `refresh()` (`tailnet-sync.js:503`) already re-reads
each peer's row. Add: `instanceSyncManager.initInstance(peer.id, syncUrlKeyOrNull)` per
refreshed peer. With C1's key-equality fast path this is a Map lookup + Buffer compare per
minute per peer when nothing changed; when `sync_url` changed by any means (manual tool
edit, missed exchange), the swap converges within 60s with no restart. Not a boot-path
call (interval only). Passing `null` (peer with no stored key) never closes or swaps
anything (verified: the swap branch requires `theirFeedKey`). The call is wrapped in its
own try/catch (R2 #1): `refresh()` runs on a bare `setInterval` and the repo has no
`unhandledRejection` handler — an escaped rejection here would crash the gateway.

### C5 — Backfill-flag premise reset (fixes D4)

At boot, **between** `eagerInitPairedPeers` and the once-backfill calls — concretely in
`servers/gateway/boot/mcp-mounts.js` after `:62` and before `reemitSyncableSettingsOnce`
(`:110`) / `backfillContactsOnce` (`:122`) / `backfillGroupsOnce` (`:132`) /
`backfillProvidersForNewPeers` (`:144`), the ordering R1 F4 requires — check each armed
out-feed with a paired row for `length === 0`. For each such peer: delete its per-peer
`__providers_backfill_v1:<peerId>` flag (R2 #4 — the providers backfill has the identical
premise-death; skipping it would leave provider rows permanently missing on the rotated
peer while everything else re-flows). If ANY such peer exists: clear the three global
flags (`__contacts_backfill_v1`, `__sync_reemit_allowlist_v2`, `__groups_backfill_v1` —
the groups flag has the same premise and was missed by both the original draft and R1/R2;
folded here for completeness) so the once-backfills re-run **this same boot**.
Post-2c this is safe by construction: re-emits are preserve-mode (no lamport fabrication),
redelivery-noise-skipped on the receiving side, and conflict-deduped.

Two accepted side effects, stated plainly:
- A brand-new pairing (also a length-0 out-feed) triggers a re-run — desirable (the new
  peer needs the backfill; existing peers no-op it).
- A paired peer to whom nothing syncable was ever emitted keeps a length-0 out-feed with
  no rotation → the flags clear and the backfills re-run **every boot** until a first
  emit lands (R1 F9). Harmless (each re-run is a no-op wire-wise for peers that have the
  data, and the flags are global) but not zero-cost; accepted for simplicity and noted
  in the re-run log line.

Separable if round-2 review judges it scope creep, but without it a real rotation leaves
the peer permanently missing whatever the once-backfills cover.

## 4. Alternatives considered and rejected

1. **Explicit `rotateInFeed()` API called from the three detection points.** Same mechanics,
   more wiring, and every *future* caller of `initInstance` (boot, eager, refresh) must
   remember to call it. Key-awareness inside `_initInstanceInner` heals every path that
   exists or will exist. Rejected.
2. **Connection-bounce:** on key receipt, close feeds + drop the connection; let the
   dialer/swarm reconnect and reopen. Least code, but: does nothing about D2; reconnect
   timing is transport-dependent (Hyperswarm reconnection is not promptly guaranteed);
   and it races the deterministic dialer election. Rejected.
3. **Per-key sibling dirs (`in-<key16>/`)** to dodge the rocksdb lock so a hung close can't
   defer the swap. Robust against the hung-close case, but adds dir-resolution state that
   must stay consistent across restarts (which dir serves which key), a probe-open on
   every boot, and a restart-divergence trap (boot opening the legacy dir would silently
   create an empty twin of a sibling-dir core). The hung-close case is rare (one incident;
   its known instance — the contact-teardown chain — was bounded by PR #195, though
   hypercore close in general remains unbounded) and its degraded mode here equals today's
   dataflow (that direction receives nothing) plus a complete restart heal. Simplicity
   wins (the 2a six-bug lesson cuts both ways: every mechanism added is a bug surface).
   Rejected.
4. **Replay legacy feeds from seq 0 to heal past D2 skips.** Resurrection hazard for
   deleted rows in tables without tombstones (§3 C2). Rejected — with the residual loss
   stated honestly.
5. **Cross-chain locking (`_initLocks` ↔ `_processLocks`) to serialize swap vs processing.**
   Considered for R1 F1; rejected in favor of feed-keyed stamping + feed-identity bails
   (§3.1) — a lock spanning both chains would put `_applyEntry`'s DB awaits inside the
   boot-reachable `_initLocks` chain, recreating the 2c boot-liveness hazard the bounded
   close exists to avoid.

## 5. Security / trust model (unchanged)

`feed_key_hex` frames already rewrite `sync_url` today on all three receipt points; this
design changes what the *local manager* does with the same authenticated signal, not who
is trusted. The frames ride channels authenticated by the shared instance identity
(ed25519 challenge/handshake; tailnet WS is additionally TLS'd via Serve or
Noise-wrapped; Hyperswarm conns are NoiseSecretStreams). The frame itself is not
independently signed — same as today; an attacker who can forge it holds the shared
identity key and has full sync authority anyway. Net new hardening: 32-byte key
validation and self-key rejection (C1) where today malformed hex flows unchecked into
`Buffer.from` and an echoed own-key would open a self-applying in-feed.

Rollback/thrash: swaps fire only on key *difference*, serialized per peer via
`_initLocks`; each connection delivers its key once at handshake; the one stale-snapshot
init that could thrash (tailnet server `:238`) is defanged by passing null (C1/R1 F3); a
re-rotation back to a previously-seen key is just another swap (seq record follows `k`).
No hot loop exists (C4 is 1/min and fast-paths on equality).

## 6. Boot-liveness analysis (2c lesson applied)

New awaits reachable from boot (`eagerInitPairedPeers` → `initInstance`): exactly one —
the 5s-capped old-feed close, only on the rotation path, only when a key actually changed
across a restart boundary (rare). The defer branch returns immediately. The open-time
reconcile (C2) is one local SQLite read + write. C3's `.replicate()` is synchronous setup
on an existing stream. C4 is interval-only. C5 runs between existing boot steps and adds
two flag reads/writes (local SQLite). No cross-chain lock exists (§4.5). Gate rows G6/G6b
make the hung-close case explicit (the 2c G11/G12 precedent: harness stubs must not be
allowed to hide a hang class).

## 7. Executable gate — `tests/feed-rotation.test.js`

Real two-manager harness: two `InstanceSyncManager`s with `mgr.dataDir = mkdtemp` (per the
2c harness gotcha), real init-db SQLite per side, **real Hypercores and real replication**
over paired `NoiseSecretStream`s on an in-process duplex pair (new harness capability —
existing suites apply entries directly and by design cannot see replication-layer
defects; that blindness is exactly what let D1/D2 ship).

| # | Case | Mutation check (guard → named red test) |
|---|------|------------------------------------------|
| G1 | Live rotation, single actor: A rotates (out storage wiped, re-init mints new key), key delivered to B live, B swaps without restart, A's new emit applies on B, `sync_conflicts` flat | Remove C1 key-compare → G1 red (entry never applies) |
| G2 | Seq reset on rotation: B held `{k: old, s: 40}`; fresh feed's seq 0..2 all apply | Remove open-time `k ≠` reset → G2 red |
| G3 | **MUTUAL** simultaneous rotation (both sides) → both swap, both directions converge, conflicts flat | (covered by G1/G2 mutations firing on either side) |
| G4a | Legacy numeric `n ≤ feed.length` at open → adopted as `{k, s:n}`, no replay (apply-count 0 on reconnect) | Remove legacy-adopt branch → G4a red (spurious replay) |
| G4b | Legacy numeric `n > feed.length` at open → `{k, s:0}`, full apply | Remove impossibility check → G4b red (entries skipped) |
| G4c | **Burst-crossing (R1 F2):** legacy `n`, rotated fresh feed opens at length 0, then replicates a backlog `> n` in one batch → ALL entries `0..n-1` apply | Re-introduce lazy per-read legacy evaluation → G4c red |
| G5 | Same-key re-exchange: no swap (feed object identity preserved), seq untouched | Remove equality fast-path → G5 red |
| G6 | Hung old-feed close: `close()` never resolves → `initInstance` returns ≤ cap, no hang, loud defer log | Remove `boundedClose` cap → G6 red (timeout) |
| G6b | After G6's defer, a restarted manager (new objects, same dirs+DB) completes the rotation and applies backlog | Remove open-time reconcile → G6b red |
| G6c | **Defer-then-reopen (R2 #1):** after a defer with the lock still held, a subsequent `initInstance(id, newKey)` returns the out-feed WITHOUT throwing; a C4-style call wrapped the same way; when the slow close finally resolves, the next `initInstance` completes the rotation | Remove the open try/catch → G6c red (throw escapes); remove the `_deferredRotations` un-defer `.then` → G6c red (rotation never completes) |
| G7 | Replay safety: rotated fresh feed carrying insert→delete converges deleted; locally-newer row survives an older replayed entry (LWW holds at seq 0) | (LWW gates pre-exist; case pins them under rotation) |
| G8 | **Old core actively replicating on a real stream** → rotation (real bounded close of that core) → new feed attached to the SAME still-open stream → new data flows (R1 F5 preconditions) | Remove `_activeStreams` attach → G8 red |
| G9 | Old core's blocks still readable after swap (open by old key, read block 0) | — acceptance pin, no guard |
| G10 | C5: armed out-feed length 0 + flags `done:` → flags cleared **before** `reemitSyncableSettingsOnce`/`backfillContactsOnce` run, and the backfill re-runs in the same boot sequence (R1 F4 ordering); non-empty out-feed → flags untouched | Remove premise check → G10 red; reorder after backfills → G10 red |
| G11 | Malformed `feed_key_hex` (odd length, non-hex, 16 bytes) → ignored, logged, no swap, no crash | Remove validation → G11 red |
| G11b | Peer echoes OUR out-feed key → rejected, no in-feed opened on our own key (R1 F7) | Remove self-key check → G11b red |
| G12 | **Cross-chain interleave (R1 F1):** a `_processNewEntries` run in flight on the OLD feed across the swap → new feed's record ends `{k: new}` with no skipped entries; queued post-swap runs on the old feed bail with no stamp | Stamp with "current in-feed" key instead of processed-feed key → G12 red; remove entry bail → G12 red |
| G13 | Stale-snapshot swap-back (R1 F3): hyperswarm-delivered new key + concurrent tailnet-server handshake holding the old snapshot → converges on the NEW key, exactly one swap. **Must drive the REAL tailnet WS server** (R2 #6): the harness mounts `setupTailnetSyncServer` on a real local http server and dials it with a real signed WS handshake, pausing between the server's `:222` snapshot read and its `:238` init to land the hyperswarm-path key write — simulating the race by calling `initInstance` twice directly would not execute `:238` and the mutation could never go red | Restore `:238` snapshot-key init → G13 red |

Full mutation matrix run recorded in the PR (the 2c precedent). The MUTUAL case (G3) is
mandatory per the 2a lesson.

**Existing-suite migration (R1 F6, scope corrected per R2 #3):** the change is NOT limited
to the four direct `_getLastAppliedSeq`/`_setLastAppliedSeq` call lines — every test that
drives `_processNewEntries` on a `makeStubFeed()` (`tests/instance-sync.test.js:98-107`,
used at :240, :254, :333-334 and ~10 more sites) breaks, because the stub has no `.key`.
`makeStubFeed` grows a synthetic 32-byte `.key` (deterministic per harness, overridable).
**Non-vacuity guard:** Test 3's cross-restart resumption asserts seqs 0-1 are NOT
re-applied — that only tests resumption when `feed2` and `feed` carry the SAME synthetic
key; the migration must set that deliberately and comment it (different keys would make
the key-gate return 0, replay from a fresh db2, and pass the assertion vacuously — the
exact 2a vacuous-test tell). The no-feed display read is pinned by a small case there.

## 8. Non-goals / follow-ups

- **GC of dead cores** in the in-feed store after rotation (unbounded only in number of
  rotations; each is small). Follow-up if ever needed.
- **Healing past D2 skips** for non-re-emitted tables — unrecoverable safely (§4.4),
  including the pre-deploy regrown-feed case (§3 C2 residual).
- **Per-peer backfill flags** (`backfillProvidersForNewPeers`' flag survives revoke/re-pair —
  pre-existing hole noted at 2b; own PR, already in the pool).
- **Identity-key rotation** — different problem, no code path, out of scope.
- The `local-cli-mcp` feed dir (session MCP servers) — untouched by this design.

## 9. Live verification plan (crow↔grackle, real rotation)

1. Pre-check fleet baselines (health ×4, conflicts 219/182/162/0, feed lengths, marks).
2. Deploy through the standard pipeline (no rail needed — no schema bump).
3. **Real rotation:** stop grackle's gateway briefly, move
   `~/.crow/data/instance-sync/<crow-peer-id>/out` aside (kept, not deleted), start.
   Grackle mints a new out-feed key at boot. The stop window is minutes, monitored, with
   prod restored before anything else proceeds (unattended-window rule).
4. Prove on **crow, without any crow restart**: journal shows the ROTATED line; `sync_url`
   updated; a fresh grackle-side row (throwaway memory/contact) converges on crow;
   `getSyncStatus` shows the new in-feed advancing from 0; conflicts flat ×4; MPA
   unaffected.
5. Prove grackle's own C5: its fresh out-feed repopulates via the re-run backfills; crow's
   dedupe keeps conflicts flat.
6. Confirm the moved-aside old feed dir is inert; restore-path not needed (blocks were
   also duplicated nowhere — the moved dir IS the archive).
7. Post-item CDP bug-hunt round per standing rule.

## 10. Acceptance mapping (item text → this design)

- "rotate, replication resumes with NO restart on either side" → C1+C3 (G1/G3/G8; live §9.4
  — the *detecting* side never restarts; the rotated side's restart is the rotation event
  itself in the wild, and the executable gate additionally proves a fully live-swap on
  both sides in G3).
- "existing blocks readable" → multi-core store keeps the old core (G9; §9.6).
- "conflicts flat" → every gate case asserts it; live baselines 219/182/162/0.
- "which key / what path / how detected / what recreate means" → §1, answered from code
  with empirical probes.

## 11. Review record

**Round 1 (fresh Opus subagent, 2026-07-15) — verdict REVISE.** Three CRITICALs, three
IMPORTANTs, one MINOR, two NOTEs; all folded into rev 2:
- **F1 (CRITICAL)** current-in-feed key stamping + uncoordinated `_processLocks` chain →
  old-feed run across a swap corrupts the new record and replays the old feed from 0.
  *Fixed:* stamp threaded from the processed feed; entry + per-iteration feed-identity
  bail; listener removal on swap; interleave analysis §3.1; gate G12.
- **F2 (CRITICAL)** legacy `n > length` rule evaluated lazily flips to "trust" once a
  replication burst crosses `n`. *Fixed:* decision frozen at feed-open
  (`_reconcileAppliedSeqAtOpen`), always stamps new format; gate G4c.
- **F3 (CRITICAL)** `tailnet-sync.js:238` stale-snapshot init becomes a swap-back vector.
  *Fixed:* pass null there; scope statement corrected; gate G13.
- **F4 (IMPORTANT)** C5 ordering unpinned vs the once-backfill readers. *Fixed:* pinned in
  `mcp-mounts.js` between `:62` and `:110`; G10 extended with the ordering mutation.
- **F5 (IMPORTANT)** G8 risked vacuity (must exercise old-core-was-replicating + real
  bounded close on the same stream). *Fixed:* preconditions pinned in G8.
- **F6 (IMPORTANT)** existing suite calls the old signatures/format. *Fixed:* migration
  scoped into the PR; no-feed display read defined (§3 C2) and pinned.
- **F7 (MINOR)** self-key echo unguarded. *Fixed:* C1 validation + G11b.
- **F8 (NOTE)** old append listener leak. *Fixed:* removeListener in C1.
- **F9 (NOTE)** never-emitted peers re-trigger C5 each boot. *Documented* as accepted
  cost (§3 C5).
- Reviewer verified-holds worth keeping: `boot.js:793-803` passes null (no thrash vector
  there); C4 null-key safety; feedsDisabled inertness; revoked/paused exclusion at every
  path; happy-path boot-liveness.

**Round 2 (fresh Opus subagent, 2026-07-15) — verdict REVISE.** One CRITICAL, three
IMPORTANTs, three MINORs, three NOTEs — concentrated, as predicted, in rev 2's own fixes;
all folded into rev 3:
- **#1 (CRITICAL)** the C1 defer branch left `inFeeds` absent with the rocksdb lock held;
  the NEXT open attempt throws out of `initInstance` — killing the tailnet client's whole
  handshake (both directions dead, reconnect throw-loop) and crashing the gateway via
  unhandled rejection on the C4 interval. *Fixed:* try/catch around the in-feed open
  (degrade out-only), `_deferredRotations` suppression with un-defer on late close
  resolution, C4 per-peer wrap; gate G6c with two mutations.
- **#2 (IMPORTANT)** `_activeStreams` leaked on revoke and could attach a swap to a stale
  stream. *Fixed:* teardown in `_closeInstanceFeedsInner`; memory bound stated (C3).
- **#3 (IMPORTANT)** F6 migration scope was understated (~10+ `makeStubFeed` sites break;
  Test 3 could go vacuous under different synthetic keys). *Fixed:* scope corrected in §7
  with an explicit non-vacuity guard.
- **#4 (IMPORTANT)** C5 skipped the providers per-peer backfill flag (identical premise-
  death → provider rows permanently missing post-rotation). *Fixed:* per-peer providers
  flag reset folded into C5, plus the `__groups_backfill_v1` global flag both rounds
  missed.
- **#5 (MINOR)** §3.1's mid-loop poison-skip mechanism was wrong (probe: `length` reads 0
  after close; loop exits immediately). *Fixed:* analysis corrected; rev 2's per-iteration
  bail dropped (YAGNI — defended a nonexistent mechanism).
- **#6 (MINOR)** G13 as written could be simulated into vacuity. *Fixed:* pinned to drive
  the real `setupTailnetSyncServer` WS endpoint.
- **#7 (MINOR)** `json_set` needs `json(?)` not `CAST` for the object format;
  `getSyncStatus` must unwrap `.s`. *Fixed:* SQL note in C2.
- **#8 (NOTE)** validate before persist. *Fixed:* shared helper gates the `sync_url`
  write at all three receipt points.
- **#9 (NOTE)** listener refs must be per-peer; add a no-op error listener during swap.
  *Fixed* in C1.
- **#10 (NOTE)** §3.1 finality overstated. *Fixed:* caveat added (next-boot reconcile is
  the terminal guarantee).
- R2 verified-holds worth keeping: §3.1 interleave convergence under the per-entry
  checkpoint pattern; `json_set` single-statement atomicity (no cross-chain lost update);
  open→reconcile→listen→attach ordering closes F2 airtight; reconcile runs on first key'd
  open after null-key no-ops; `emitChange`/out-feed untouched by swap; C5's length read
  ordering valid (`mcp-mounts.js:62` awaited); `.key` readable after close; boot stays
  clean (fresh process holds no zombie lock).
