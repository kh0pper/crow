# Item 2d — In-feed key rotation: live swap + applied-seq integrity

**Date:** 2026-07-15 · **Status:** DRAFT (rev 1, pre-review) · **Author:** autonomous arc session
**Plan doc:** `docs/superpowers/plans/2026-07-11-opus-autonomous-arc.md` §4 Item 2d
**Prereq reading:** the 2a six-bug lesson (executable/multi-instance/mutual gates) and the 2c
boot-liveness lesson (no unbounded boot awaits) — both shaped this design.

## 0. TL;DR

When a peer's outbound Hypercore feed key changes (storage loss → hypercore mints a fresh
keypair), the receiving side today: (a) persists the new key but **never swaps the open
in-feed** — replication in that direction is silently dead until restart; and (b) even after
restart, keeps the **old feed's applied-seq high-water mark**, so every entry of the new feed
below that mark is **silently skipped forever**. This spec fixes both: a key-aware
`initInstance` that swaps the in-feed live (bounded, boot-safe), and an applied-seq record
that is keyed to the feed it was earned on.

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

All changes live in `servers/sharing/instance-sync.js` plus one line-level touch each in
`tailnet-sync.js` (C4) and none elsewhere. Detection points are untouched — they already
call `initInstance` with the new key; the fix makes that call honest.

### C1 — Key-aware in-feed open/swap (fixes D1)

In `_initInstanceInner`, replace the in-feed guard with key-aware logic:

```
const current = this.inFeeds.get(remoteInstanceId);
if (current && theirFeedKey && !current.key.equals(theirFeedKey)) {
  // ROTATION: bounded close, then open the new core in the same dir.
  this.inFeeds.delete(remoteInstanceId);          // unmap first — no new reads route to it
  const closed = await boundedClose(current, 5_000); // Promise.race close vs cap
  if (!closed) {
    // rocksdb lock still held by the zombie session — same-dir open would throw.
    // Defer: loud log; sync_url is already persisted, so the next boot heals
    // (multi-core store + C2 seq reset). Do NOT hang the _initLocks chain.
    console.error(`[instance-sync] ROTATION DEFERRED for ${id}: old in-feed close timed out; restart will complete it`);
    return this.outFeeds.get(remoteInstanceId);
  }
  await this._resetAppliedSeqForKey(remoteInstanceId, theirFeedKey); // C2, s=0
  console.warn(`[instance-sync] in-feed ROTATED for ${id}: ${oldKey8}… → ${newKey8}…`);
}
if (!this.inFeeds.has(remoteInstanceId) && theirFeedKey) {
  … existing open path, PLUS: reconcile C2 record (if stored k ≠ this key → reset s=0),
  PLUS: attach to tracked live streams (C3) …
}
```

Properties:
- Runs inside the existing `_initLocks` per-peer chain — no concurrent-swap races, and
  close cannot interleave with another `initInstance` (same serialization
  `closeInstanceFeeds` already relies on).
- **Bounded** (2c lesson): the only await added to a boot-reachable path is the 5s-capped
  close. A hung close (the real grackle incident class) degrades to today's behavior
  (stale until restart) with a loud, greppable log line — never a boot hang.
- Key validation: `theirFeedKey` must be exactly 32 bytes (`feed_key_hex` = 64 hex chars)
  at all three receipt points' entry into `initInstance`; malformed keys are logged and
  ignored (today they'd flow into `Buffer.from(hex,"hex")` unchecked).
- The unmap-before-close ordering means `replicate()`/`getSyncStatus` see either the old
  feed (pre-swap) or the new one (post-swap), never a closing zombie.
- The rotated old core is left in the store (acceptance: blocks readable). GC is an
  explicit non-goal (§8).

### C2 — Feed-keyed applied-seq (fixes D2)

`last_applied_seq_per_peer` values change from `2412` (numeric) to
`{"k": "<feedKeyHex>", "s": 2412}`. This is a JSON-blob format evolution inside an existing
TEXT column — **no schema generation bump, no migration rail**.

- `_setLastAppliedSeq(peerId, seq)` gains the current in-feed's key and always writes the
  new format.
- `_getLastAppliedSeq(peerId)` becomes `_getLastAppliedSeq(peerId, feed)`:
  - New-format value: `k === feed.key.hex` → return `s`; `k ≠ feed.key.hex` → the record
    belongs to a dead feed → return 0 (and the next set overwrites `k`).
  - Display-only callers without a feed handle (`getSyncStatus` when the in-feed is not
    open) pass `feed = null` and get the raw `s` back — a cosmetic counter, never used
    to gate application.
  - **Legacy numeric `n`:** if `n > feed.length` the mark is *provably foreign* (a mark
    earned on feed F always satisfies `mark ≤ F.length`) → return 0. Otherwise trust it
    (`return n`) — it is *plausibly* this feed's mark, and replaying a long-lived feed
    from 0 is NOT safe (see below). First subsequent write upgrades the format.
- **Why not replay legacy feeds from 0 to heal past skips:** replaying a long-established
  feed re-applies old `insert` entries for rows that were later deleted *locally with no
  tombstone table* (`memories`, `research_notes`, …) → resurrection. The seq mechanism is
  what protects that class today. Fresh (rotated) feeds carry only post-rotation history,
  so reset-to-0 on an actual key change replays nothing stale. Consequence stated
  honestly: entries already skipped by D2 *in the past* are unrecoverable for
  non-re-emitted tables; 2c's boot re-emits heal contacts/settings/groups/tombstones over
  subsequent boots. (Fleet check found no currently-broken peer: crow↔grackle↔MPA marks
  are all plausible for their live feeds.)

### C3 — Live-stream attach after swap

`replicate(remoteInstanceId, stream)` records the stream in
`_activeStreams: Map<peerId, Set<stream>>` (entry removed on the stream's `close` event).
After a C1 swap, the new in-feed calls `.replicate(existingStream, {live:true})` on every
tracked live stream. This closes the Hyperswarm ordering hole: `onInstanceConnected` may
`replicate()` *before* the challenge-response key reaches `onInstanceKeyReceived`, so the
triggering connection would otherwise carry only the dead core. (On the tailnet paths the
key exchange strictly precedes `replicate()`, so the triggering connection there picks up
the new feed naturally.) Multiplexing an additional core onto an already-active stream is
standard hypercore protomux behavior; the gate proves it with real streams (G8).

### C4 — 60s convergence loop (fixes D3, belt-and-suspenders for everything)

`startTailnetSyncClients`' existing 60s `refresh()` (`tailnet-sync.js:503`) already re-reads
each peer's row. Add: `instanceSyncManager.initInstance(peer.id, syncUrlKeyOrNull)` per
refreshed peer. With C1's key-equality fast path this is a Map lookup + Buffer compare per
minute per peer when nothing changed; when `sync_url` changed by any means (manual tool
edit, missed exchange), the swap converges within 60s with no restart. Not a boot-path
call (interval only).

### C5 — Backfill-flag premise reset (fixes D4)

At boot, after `eagerInitPairedPeers` arms feeds: if any armed out-feed with a paired row
has `length === 0` while `__contacts_backfill_v1` / `__sync_reemit_allowlist_v2` read
`done:` — the flags' premise ("peers have received this") died with the feed — clear both
flags so the once-backfills re-run this boot. Post-2c this is safe by construction:
re-emits are preserve-mode (no lamport fabrication), redelivery-noise-skipped on the
receiving side, and conflict-deduped. Side effect: a brand-new pairing (also a length-0
out-feed) triggers the same re-run — desirable (the new peer needs the backfill; existing
peers no-op it). Separable if review judges it scope creep, but without it a real rotation
leaves the peer permanently missing whatever the once-backfills cover.

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
   create an empty twin of a sibling-dir core). The hung-close case is rare (one incident; its known
   instance — the contact-teardown chain — was bounded by PR #195, though hypercore close
   in general remains unbounded) and its degraded mode here equals today's dataflow (that
   direction receives nothing) plus a complete restart heal. Simplicity wins (the 2a six-bug lesson cuts both
   ways: every mechanism added is a bug surface). Rejected.
4. **Replay legacy feeds from seq 0 to heal past D2 skips.** Resurrection hazard for
   deleted rows in tables without tombstones (§3 C2). Rejected — with the residual loss
   stated honestly.

## 5. Security / trust model (unchanged)

`feed_key_hex` frames already rewrite `sync_url` today on all three receipt points; this
design changes what the *local manager* does with the same authenticated signal, not who
is trusted. The frames ride channels authenticated by the shared instance identity
(ed25519 challenge/handshake; tailnet WS is additionally TLS'd via Serve or
Noise-wrapped; Hyperswarm conns are NoiseSecretStreams). The frame itself is not
independently signed — same as today; an attacker who can forge it holds the shared
identity key and has full sync authority anyway. Net new hardening: 32-byte key
validation (C1) where today malformed hex flows unchecked into `Buffer.from`.

Rollback/thrash: swaps fire only on key *difference*, serialized per peer via
`_initLocks`; each connection delivers its key once at handshake; a re-rotation back to a
previously-seen key is just another swap (seq record follows `k`). No hot loop exists
(C4 is 1/min and fast-paths on equality).

## 6. Boot-liveness analysis (2c lesson applied)

New awaits reachable from boot (`eagerInitPairedPeers` → `initInstance`): exactly one —
the 5s-capped old-feed close, only on the rotation path, only when a key actually changed
across a restart boundary (rare). The defer branch returns immediately. C3's
`.replicate()` is synchronous setup on an existing stream. C4 is interval-only. C5 runs
after feed-arm in the existing boot sequence and adds two flag reads/writes (local SQLite).
Gate rows G6/G6b make the hung-close case explicit (the 2c G11/G12 precedent: harness
stubs must not be allowed to hide a hang class).

## 7. Executable gate — `tests/feed-rotation.test.js`

Real two-manager harness: two `InstanceSyncManager`s with `mgr.dataDir = mkdtemp` (per the
2c harness gotcha), real init-db SQLite per side, **real Hypercores and real replication**
over paired `NoiseSecretStream`s on an in-process duplex pair (new harness capability —
existing suites apply entries directly and by design cannot see replication-layer
defects; that blindness is exactly what let D1/D2 ship).

| # | Case | Mutation check (guard → named red test) |
|---|------|------------------------------------------|
| G1 | Live rotation, single actor: A rotates (out storage wiped, re-init mints new key), key delivered to B live, B swaps without restart, A's new emit applies on B, `sync_conflicts` flat | Remove C1 key-compare → G1 red (entry never applies) |
| G2 | Seq reset on rotation: B held `{k: old, s: 40}`; fresh feed's seq 0..2 all apply | Remove `_resetAppliedSeqForKey` → G2 red |
| G3 | **MUTUAL** simultaneous rotation (both sides) → both swap, both directions converge, conflicts flat | (covered by G1/G2 mutations firing on either side) |
| G4a | Legacy numeric `n ≤ feed.length` → trusted, no replay (apply-count 0 on reconnect) | Remove legacy-trust branch → G4a red (spurious replay) |
| G4b | Legacy numeric `n > feed.length` → reset to 0, full apply | Remove impossibility check → G4b red (entries skipped) |
| G5 | Same-key re-exchange: no swap (feed object identity preserved), seq untouched | Remove equality fast-path → G5 red |
| G6 | Hung old-feed close: `close()` never resolves → `initInstance` returns ≤ cap, no hang, loud defer log | Remove `boundedClose` cap → G6 red (timeout) |
| G6b | After G6's defer, a restarted manager (new objects, same dirs+DB) completes the rotation and applies backlog | Remove C2 reconcile-on-open → G6b red |
| G7 | Replay safety: rotated fresh feed carrying insert→delete converges deleted; locally-newer row survives an older replayed entry (LWW holds at seq 0) | (LWW gates pre-exist; case pins them under rotation) |
| G8 | Rotation while a real stream is actively replicating: new feed's data flows over the EXISTING stream (C3) | Remove `_activeStreams` attach → G8 red |
| G9 | Old core's blocks still readable after swap (open by old key, read block 0) | — acceptance pin, no guard |
| G10 | C5: armed out-feed length 0 + flags `done:` → flags cleared, backfill re-runs; non-empty out-feed → flags untouched | Remove premise check → G10 red |
| G11 | Malformed `feed_key_hex` (odd length, non-hex, 16 bytes) → ignored, logged, no swap, no crash | Remove validation → G11 red |

Full mutation matrix run recorded in the PR (the 2c precedent). The MUTUAL case (G3) is
mandatory per the 2a lesson.

## 8. Non-goals / follow-ups

- **GC of dead cores** in the in-feed store after rotation (unbounded only in number of
  rotations; each is small). Follow-up if ever needed.
- **Healing past D2 skips** for non-re-emitted tables — unrecoverable safely (§4.4).
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
