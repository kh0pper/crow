# Item 2c — Lamport-preserving re-emit + boot-window emit loss (design)

**Date:** 2026-07-14 · **Status:** REV 3 — round-1 (2 CRITICAL, 3 MAJOR, 3 MINOR) and
round-2 (3 MAJOR, 4 MINOR, 1 latent-bug observation) findings folded — see §8; pending
round-3 closure check
**Scope:** `servers/sharing/instance-sync.js`, `servers/sharing/contact-sync.js`,
`servers/sharing/group-sync.js`, `tests/` (new two-instance gate + one harness fix).
**No schema change. No wire-format change.** The migration rail is NOT needed.

Item 2c of the master plan (`docs/superpowers/plans/2026-07-11-opus-autonomous-arc.md`
§4), with the Item-3-triage bug folded in, per the plan (~line 512). Designed under the
2a law: every convergence claim below is backed by an EXECUTABLE, MULTI-INSTANCE gate
exercising the MUTUAL case (§5) — the prose in §4 is an argument, not the proof.

---

## 1. Defects (all verified in current code, main `870f7b01`)

### D-A — Boot backfills fabricate recency (the 2c core, I-B1 class)

`backfillContactsOnce` re-emits every syncable contact through plain `emitChange`
(`instance-sync.js:661`), which **mints a fresh lamport** (`:1068`) and **re-stamps the
local row with it** (`:1109-1114`). A stale local value is thereby republished as the
newest write in the fleet. The I-B1 inbound drain (`:634-636`) only covers peer entries
*already replicated to local disk* — anything in flight (peer wrote, not yet delivered)
is clobbered when the fresh-lamport re-emit lands there: peer's newer write loses LWW
to a value that is actually older. Silent — no conflict row is written on the winning
path.

Same class, verified:
- `reemitSyncableSettingsOnce` (`:566`) — `dashboard_settings` LWW apply
  (`_applyDashboardSetting`: `lamportTs < localTs → return`, tie+different → incoming
  wins), so a fresh-lamport re-emit of a stale value beats a peer's newer in-flight
  save. The R1 MAJOR-2 empty-profile guard (`:559-564`) exists precisely because of
  one instance of this class; the class itself remains.
- `backfillGroupsOnce` → `emitGroupUpsert` (`group-sync.js`) — `_applyContactGroup` is
  "LWW by lamport_ts, exactly like _applyContact" (`:1933`), same exposure, plus
  whole-set membership replacement.

**NOT in this class (leave alone):** `backfillProvidersForNewPeers` emits `op="insert"`
(`:776`), applied via `_applyInsert`'s `INSERT OR IGNORE` — it cannot overwrite an
existing row regardless of lamport, so its fresh mint is clobber-proof (counter thrash
only). `reemitGroupTombstones` (W4) re-emits group deletes with fresh lamports **by
design** — group tombstones are strict delete-wins (2b), re-adds are supposed to lose.
Do not "fix" either.

### D-B — Zero/partial-feed emits are silently dropped while reporting success (folded Item-3 bug)

`emitChange` (`:1052-1130`) has no guard on `outFeeds`: with the map empty (or missing
some paired peer mid-boot) it mints a lamport, stamps the local row, appends to
whatever feeds exist — possibly none — and **returns a valid lamport**. The boot
comment at `servers/gateway/boot/mcp-mounts.js:55-59` documents the hazard; the
`backfillContactsOnce` no-peers guard (`:622-626`) records it *observed live on
grackle 2026-07-06* (4 paired peers, feeds not yet open).

Worst consumer: `emitContactDelete` (`contact-sync.js:45-50`), the #155 user-initiated
contact delete. It has a designed fallback — nullish emit ⇒ tombstone at the row's own
lamport — but a zero-feed emit returns a *minted* lamport, so the fallback never
engages, the tombstone is written locally, the delete reaches **nobody**, and the
caller reports success. From then on the local tombstone drops every incoming
`op="update"` for that contact (delete-wins, `:1663`) ⇒ permanent divergence, zero
conflict rows, nothing logged.

### D-C — Contact deletes are emitted exactly once, ever (durability gap behind D-B)

Even with D-B fixed for the in-process boot window, a contact delete that misses its
peers is never re-delivered: nothing re-emits contact tombstones. Missed-delivery
vectors: a crash inside the boot window; a peer re-pair (out-feeds are born EMPTY at
pairing — no history replay, `:686`); a delete performed by a secondary process whose
feeds never open (session-spawned stdio MCP server sharing the prod DB — the known
harness-lesson writer class). Groups already solved exactly this with W4's flagless
per-boot `reemitGroupTombstones` (`:997`, wired `:920`); contacts have no mirror.
Note: the contacts mirror is **only safe with lamport preservation** — re-emitting a
contact delete at a *fresh* lamport would beat a peer's genuinely-newer re-add and wipe
it (contacts, unlike groups, allow re-add-after-delete: `:1636-1666`).

### D-D — Known-fail suite test is a harness-env artifact

`tests/instance-sync.test.js` test 18 ("crow_context emitChange stamps local row's
lamport_ts") fails under the mandated scratch env because `CROW_DISABLE_INSTANCE_SYNC=1`
makes every constructed manager `feedsDisabled` (`:313`, `:274-278`) ⇒ `emitChange`
returns at `:1054` before stamping ⇒ `got 0`. The 2b fixture already solves this
(`tests/group-tombstones.test.js:83` sets `mgr.feedsDisabled = false`); `makeManager`
(`tests/instance-sync.test.js:73`) predates that pattern. This is one of the suite's 3
known fails; fixing it moves the baseline to **1932 pass / 2 known fails / 0 skips**.

---

## 2. Approaches considered

**A. Minimal:** preserve lamports in `backfillContactsOnce` only; make zero-feed
`emitChange` return `null` so `emitContactDelete`'s fallback engages. Rejected: the
peer still never learns the delete (fallback only fixes the *local* tombstone lamport);
partial-feed loss unaddressed; settings/groups keep the D-A class.

**B. Preserve + boot-window queue + contacts tombstone re-emit (CHOSEN):** an explicit
envelope-lamport option on `emitChange`; convert the three LWW re-emitters; queue
entries for paired-but-not-yet-armed peers and drain on feed-open; mirror W4 for
contact tombstones (preserved lamports make it safe); dedupe exact-repeat conflict
rows; fix the test-18 harness. No schema, no wire change, mixed-fleet safe.

**C. Maximal:** durable `pending_emits` outbox table + a `reemit` envelope flag to
suppress conflict logging on redelivery. Rejected: schema bump invokes the §3 migration
rail (backups ×5, fleet auto-update freeze) for a residual (crash *inside* the boot
window) that C still doesn't fully close (outbox write can be lost to the same crash),
and a wire-format flag buys only cosmetic conflict suppression that the DB-side dedupe
in B already provides against ALL senders, old peers included.

---

## 3. Design (approach B)

### C1 — `emitChange(table, op, row, opts = {})` gains `opts.lamportTs`

When `opts.lamportTs` is a finite number ≥ 0, `emitChange`:
- **skips the mint** — the envelope carries `opts.lamportTs` verbatim;
- **skips the local row re-stamp** (`:1092-1118` block) — the row keeps its lamport;
- **keeps the counter floor** (`:1064-1067`) — future *fresh* mints must still exceed
  any re-emitted value; additionally floor at `opts.lamportTs` itself.

All existing callers pass no opts and are byte-identical in behavior. Callers with
`opts.lamportTs` are exactly the re-emit paths (C2, C4) — a live mutation must never
use it.

### C2 — Convert the three LWW re-emitters to preserved lamports

- `backfillContactsOnce` (`:661`): `emitChange("contacts", "update", row,
  { lamportTs: Number(row.lamport_ts) || 0 })`.
- `reemitSyncableSettingsOnce` (`:566`): same, from the row's `lamport_ts` (already
  SELECTed at `:548`).
- `emitGroupUpsert(db, groupId, opts)` gains a pass-through; only
  `_backfillGroupsOnceGated` (`:957`) passes `{ preserveLamport: true }`, which maps to
  `{ lamportTs: Number(row.lamport_ts) || 0 }` at the `emitChange` call. Live group
  create/rename paths keep minting.

Legacy rows with `lamport_ts` NULL emit at **0**: they land where the peer has nothing
(the upsert-on-missing branch `:1669` inserts regardless of lamport) and lose
everywhere else — which is the point: a row nobody ever emitted has no recency claim.
**Accepted non-convergence (R1/m-1):** two instances holding the same legacy crow_id
with *divergent values, both NULL lamports*, do not converge — each side's @0 re-emit
loses to the other's local row (`0 > 0` is false), each logs one deduped conflict row,
and both keep their local values until a real edit (fresh mint) breaks the tie. This
is strictly better than today's fresh-mint behavior (nondeterministic clobber of one
side); the divergence is surfaced, not silent. Gate case G6b.

**Settings tie residual (R1/m-2):** `_applyDashboardSetting` resolves a lamport TIE
with different values as incoming-wins (pre-existing, by design). Lamport counters are
per-instance, so ties are reachable; a preserved-lamport settings re-emit that ties a
peer's independently-written row still overwrites it silently. Pre-existing exposure,
narrowed (a fresh mint used to beat *everything* in flight, a preserved lamport beats
only ties at exactly L); not fully closed. Documented, out of scope to close.

The #147 `done:<n>` flag logic is untouched (only a completed armed run writes it,
`:668-676`).

### C3 — Boot-window pending queue (fixes D-B)

In `emitChange`, after the entry is built and signed: fetch the paired-peer id set
(`SELECT id FROM crow_instances WHERE status IN ('active','offline') AND id != ?` —
the same predicate `eagerInitPairedPeers` uses), then hand the entry to a **per-peer
ordered append chain** for every target peer. `emitChange` returns the envelope
lamport (delivery is now pending, not lost — the return stays honest).

**Per-peer append chain (R2/F2 — the ordering + TOCTOU fix).** All writes toward a
peer's outFeed flow through one FIFO promise chain per peer (`_appendLocks` — the
`_initLocks`/`_processLocks` pattern already in the file). A chained task, when it
executes, decides against *current* state: outFeed open → `feed.append(entry)`;
closed → push onto `this._pendingPeerEmits[peerId]` (FIFO, capped at 256 entries per
peer; on overflow drop the oldest with a one-line warn — LWW makes oldest-first the
safe drop direction). `_drainPendingEmits(peerId)` — the explicit, testable seam
(R1/C-2) — is itself a chained task: it splices the pending slot and appends its
entries FIFO through `outFeeds.get(peerId)`; `_initInstanceInner` enqueues it
immediately after arming the peer's outFeed. Chaining gives two invariants the naive
check-then-push design lacks (both breakable by interleaving `emitChange`'s awaits
against `initInstance` — R2/F2): **(i) no stranding** — an emit that decided "closed"
before the arm is either ahead of the drain in the chain (its pending push is picked
up by the drain) or behind it (it executes after the arm and appends directly);
**(ii) per-feed emit-order preservation** — a queued older entry can never land after
a newer live append, because both flow through the same chain, and the receive path
is order-sensitive (`_processNewEntriesInner` applies in seq order; `:1663` drops
updates behind tombstones — arrival order changes the final state).

Because the drain writes through `outFeeds.get(...)`, the two-instance harness's stub
feeds capture drained entries on the same wire as live emits — the REAL drain code
path runs in the gate, and G3's wiring variant runs the REAL `initInstance` with
`mgr.dataDir` redirected to a mkdtemp scratch dir (in-repo precedent:
`tests/instance-sync-noauth-feeds.test.js:71`) so the spy on `_drainPendingEmits` is
meaningful without touching `~/.crow` (R2/F3). `initInstance` is the single choke
point every feed-open path converges on (boot loop, `eagerInitPairedPeers`,
hyperswarm connect, tailnet-sync, handshake), so the drain covers all of them. On
instance revoke, drop the peer's pending slot and its chain; an enqueue racing the
revoke can recreate a slot that is never drained (R2/F7) — bounded by the 256 cap,
cleared at next revoke/boot; documented residual.

Residuals (documented, accepted): entries queued in a process that exits before its
feeds open are lost — for **deletes** C4 heals this on the next gateway boot; for
inserts/updates this is the pre-existing secondary-process hole (see §6 F-2), strictly
smaller than today (today the entries are lost even when the process *does* arm its
feeds moments later).

### C4 — `reemitContactTombstones()` — the W4 mirror for contacts (fixes D-C)

Flagless, every boot, mirroring `backfillGroupsOnce`'s shape exactly: wrap the current
`backfillContactsOnce` body as `_backfillContactsOnceGated()` and re-emit tombstones in
a `finally` (`:902-922` pattern), so the mcp-mounts call site is unchanged.

Body: if `feedsDisabled` or `outFeeds.size === 0` → return 0 (retry next boot,
flagless). Drain inbound first (I-B1 — load-bearing here: an already-delivered
re-add-as-insert must clear our tombstone *before* we re-emit it). Then select every
`contact_tombstones` row **`WHERE kind IS NULL`** (authoritative user deletes ONLY —
`kind='prune'` is local GC and must never ride the wire, 2a) **AND with no coexisting
live `contacts` row** (LEFT JOIN filter — the anomalous row-beside-tombstone state is
reachable via races/manual edits; never broadcast a delete for a contact we still
hold live; mirrors `emitGroupUpsert`'s belt-and-braces, `group-sync.js:46-54`)
(R1/m-3). For each: `emitChange("contacts", "delete", { crow_id },
{ lamportTs: tomb.lamport_ts })`.

The preserved lamport is the original global delete lamport, so the re-emit beats
exactly what the original broadcast would have beaten — no more, no less. Receiver
outcomes (`_applyContact`): no local row → tombstone UPSERT, same-kind MAX (`:1608`,
idempotent); older local row → delete + tombstone (heals the divergence D-B/D-C
created, including re-pairs); **newer local row → survives** with one conflict row
(`:1626`), deduped across boots (C5). Volume: authoritative tombstones are user
deletes — rare, never pruned (`contact-delete.js:10`), one tiny SELECT per boot.

**Termination — precise, qualified (R1/M-1):** the re-emit stops when this instance's
tombstone clears, and the clear paths are: an inbound **`op="insert"`** for the
crow_id with lamport > tombstone (the `clearTombAfterApply` block, `:1661-1666` +
`:1733`/`:1748` — `contact-promote.js` emits re-adds as `insert`, so the genuine
re-add flow clears us), or any local path that re-creates the row (rule (a),
`:1584-1587`, fires on the *next* inbound entry once a local row exists). An inbound
**`op="update"`** carrying a newer edit does NOT clear the tombstone — it is dropped
unconditionally (`:1663`, the #155 delete-wins-over-updates rule, deliberate: every
resurrection defect was an update). So a concurrent edit-vs-delete pair (A deletes
X@10 while B renames X@12 without having seen the delete) stays divergent: B keeps
its row (the re-emitted delete@10 loses LWW there), A keeps its tombstone, and the
re-emit repeats each boot. **This divergence is pre-existing #155 semantics, not
introduced by C4** — today it is silent and permanent; with C4 it is *visible*
(exactly one deduped conflict row on B) and *bounded* (C5 holds `sync_conflicts`
flat across boots). Gate case G5b proves the boundedness executably.

### C5 — Repeat-delivery conflict dedupe (STABLE key — R1/C-1)

`_insertConflictRow` gains a pre-check: skip the INSERT when an **unresolved**
(`resolved = 0`) row with identical (`table_name`, `row_id`, `op`,
`winning_lamport_ts`, `losing_lamport_ts`, **`losing_instance_id`**) already exists.

- The data blobs are deliberately EXCLUDED: `winning_data` is
  `JSON.stringify(localRow)` and carries volatile never-synced columns —
  `contacts.last_seen` is bumped on every inbound DM (`servers/sharing/boot.js:889`)
  *without* moving `lamport_ts` — so a data-inclusive key would treat every boot's
  redelivery as "new" and grow `sync_conflicts` (the fleet's red-flag metric) forever
  (R1/C-1).
- `losing_instance_id` is INCLUDED (R2/F1): lamport counters are per-instance, so two
  different peers can present the same lamport pair for the same row with *different*
  divergent values — collapsing them would hide the second peer's divergence. The
  origin id is stable per peer, so same-peer redelivery still dedupes.
- Scoped to `resolved = 0` (R2/F5): resolving a conflict does not fix the underlying
  divergence; if the same conflict re-presents after an operator resolved it, it
  re-surfaces exactly once (a new unresolved row, which then dedupes future
  redeliveries). Silence-after-resolve would let the operator believe a
  still-divergent pair was settled.
- Legacy-DB guard (R2/F4): `_insertConflictRow` already degrades when the `op` column
  is missing (pre-migration window); the pre-check must degrade identically — on
  `no such column: op`, retry the pre-check without the `op` predicate rather than
  letting the error escape (which would turn EVERY conflict log into a silent
  failure, worse than today).
- No new index: `sync_conflicts` is small (hundreds of rows fleet-wide) and indexed
  on `table_name`; a composite index is a recorded follow-up if C4's re-emit volume
  ever makes the pre-check measurable.

The lamport pair + origin is the correct identity: any *material* change to either
side rides an emit and therefore moves a lamport (the only non-emitting local writes
are excluded-column bumps — exactly the noise to suppress). `_notifyConflict` is only
called after a real insert (both call sites follow the insert), so notification
behavior follows automatically. The gate mutates `last_seen` between two redeliveries
and asserts zero new rows (G5), and proves the two-peer distinctness case (G2b).

### C6 — Test-18 harness fix

`makeManager` (`tests/instance-sync.test.js:73`) sets `mgr.feedsDisabled = false`
after construction, with a comment citing the 2b fixture precedent. Verify test 18
passes and record the new suite baseline (expected 1932/2/0).

### C7 — `restoreConflict` refuses natural-key tables (R2/F8 — latent corruption made reachable)

`sync-conflict-resolve.js` already refuses `op=insert` and `table=crow_context`
(JSON-composite `row_id`), but not `contacts`, whose conflict `row_id` is ALSO JSON
(`JSON.stringify({crow_id})`, `instance-sync.js:1572`). Its stale-snapshot guard runs
`SELECT * FROM contacts WHERE id = '{"crow_id":…}'` → 0 rows → overwrites
`winning_data` with `'null'` (destroying the recorded snapshot) and its delete branch
no-ops. Pre-existing latent bug; C4 turns contacts delete-conflicts into a routine
operator-visible class (G5b), so the Restore button must refuse contacts the same way
it refuses crow_context, with a test. (A real restore path for natural-key tables is
out of scope — recorded follow-up.)

---

## 4. Convergence analysis (what the gate in §5 proves executably)

1. **Preserved-lamport re-emit can never fabricate recency.** The envelope carries a
   lamport ≤ the row's original emit lamport, so it wins LWW only where the original
   write would have won. Fresh peers still receive rows (insert branch is
   lamport-independent); converged peers no-op (`rowsEquivalent`/value-equal skip);
   newer peers keep their rows.
2. **Mutual backfill converges.** A and B backfill simultaneously with divergent rows:
   each side's re-emit carries its row's own lamport; the higher one wins on both
   sides; exactly one truthful conflict row is logged **on the higher-lamport side**
   (the receiver whose local row beats the incoming stale value, `:1784-1788` —
   R1/M-2); redelivery adds nothing (C5).
3. **Boot-window emits are delivered, not dropped.** The entry (with its already-minted
   lamport, already signed) is appended verbatim when the peer's feed opens; the
   counter floor keeps subsequent live mints strictly above it, so causality on the
   feed is preserved.
4. **Tombstone re-emit is self-limiting for the insert-carried re-add, and bounded
   otherwise (R1/M-1).** Genuine re-add (rides as `op="insert"`, per
   `contact-promote.js`): the re-emit loses on the peer (row survives), the re-add
   syncs back and clears our tombstone via `clearTombAfterApply`
   (`:1661-1666`/`:1748`), next boot re-emits nothing. Update-carried newer edit:
   never clears the tombstone (dropped at `:1663`, #155 delete-wins) — the divergence
   persists (pre-existing semantics), the re-emit repeats each boot, and C5 bounds
   the observable cost to one conflict row total. Mutual concurrent deletes:
   same-kind MAX upsert on both sides, idempotent. Converged peers: tombstone UPSERT
   is a no-op row-wise and writes no conflicts.
5. **#147 flag semantics intact.** Preserve-mode changes neither the flag read
   (`done:` prefix is terminal) nor the write (UPSERT after a completed armed run);
   the tombstone re-emit is deliberately flagless (W4 rationale: per-peer flags
   reintroduce the re-pair hole, R2 F1').

## 5. Executable acceptance gate — `tests/lamport-reemit.test.js`

Two REAL instances, harness adapted from `tests/group-tombstones.test.js` (mkdtemp +
real `scripts/init-db.js` per side, real `InstanceSyncManager`, `feedsDisabled=false`,
captured-wire out-feeds, `deliver()`/`skimWire()`/`restart()`; contact emits route
through `contact-sync.js`'s `__setEmitSinkForTest`). NEVER pointed at `~/.crow`.

| # | Case (MUTUAL where meaningful) | Red-line assertion |
|---|---|---|
| G1 | A stale contact@5, B same crow_id newer@10, divergent values; A runs backfill; deliver both ways | B keeps its @10 values; **A's local row still @5** (no re-stamp); A converges to B's @10; final rows equal over the **synced-column projection** (wire columns only — `id`/`created_at`/`last_seen`/`verified` are per-instance and legitimately differ, R1/M-3) |
| G2 | BOTH sides backfill concurrently (same divergent pair), deliver interleaved; then re-deliver the same wire again | Both converge to @10; exactly 1 conflict row total, **on the higher-lamport side** (R1/M-2), asserted via its `winning_lamport_ts=10`/`losing_lamport_ts=5` columns, not by guessing the DB; **re-delivery adds 0 rows** (C5) |
| G2b | Receiver B@12 gets the same row at the same lamport pair from TWO different origin instances with different values (R2/F1) | BOTH conflicts logged (`losing_instance_id` distinguishes); redelivery from EITHER origin adds 0 |
| G3 | B paired in A's `crow_instances` but A's outFeeds EMPTY; `deleteContactLocal` on A; then arm A's stub outFeed and let the chained `_drainPendingEmits` run (R1/C-2) | Wire empty at delete time; entry rides on drain with its original envelope lamport; B's row deleted + tombstoned; A's tombstone lamport == envelope lamport |
| G3b | WIRING variant (R2/F3): real `mgr.initInstance` with `mgr.dataDir` redirected to mkdtemp (precedent `tests/instance-sync-noauth-feeds.test.js:71`), pending entry queued beforehand; feeds closed + scratch dir removed after | Spy proves `_initInstanceInner` invoked `_drainPendingEmits` after arming; the pending entry is readable from the REAL Hypercore |
| G3c | ORDERING (R2/F2): entry E1 enqueued while the feed is closed; concurrently arm the feed (chained drain) and emit a later entry E2 while the drain is still in flight | E1 lands on the feed strictly BEFORE E2 (chain preserves emit order across the open transition); no entry appears twice; nothing is stranded in the pending slot afterwards |
| G4 | A deletes (delivered to nobody — skimWire); A restarts; gated backfill already `done:`; a seeded `kind='prune'` tombstone also present | `finally`-path tombstone re-emit delivers the authoritative delete; the `'prune'` tombstone does NOT ride; B (row@old) deletes + tombstones; both sides converged |
| G5 | A tombstone@10; B re-added@20 via **insert** (not yet synced); A boots twice, with B's row `last_seen` mutated between boots (R1/C-1); then B's re-add delivers to A | B's re-add SURVIVES both boots; boot 1 logs exactly 1 conflict row, **boot 2 logs 0 despite the `last_seen` change** (C5 stable key); A applies the insert, clears tombstone (`clearTombAfterApply`); boot 3 re-emits nothing |
| G5b | A tombstone@10; B edits the contact as **op=update**@12 (concurrent edit-vs-delete, R1/M-1); deliver both ways; A boots twice more | B's update is DROPPED on A (tombstone stands); B keeps its row (delete@10 loses); exactly 1 conflict row total on B across all boots (C5); divergence persists — asserted explicitly as the accepted #155 semantics |
| G6 | A legacy row lamport NULL; B holds same crow_id @7 with different values; A backfills; then the same emit against a peer that lacks the row entirely | Envelope lamport 0; B's row untouched; A's row lamport stays NULL; the missing-row peer receives the row |
| G6b | MUTUAL legacy: A and B hold the same crow_id, divergent values, BOTH lamport NULL; both backfill; deliver both ways twice (R1/m-1) | Neither side changes values (accepted non-convergence); exactly 1 conflict row per side; second delivery adds 0 (C5) |
| G7 | #147 flag: run G1's backfill twice | First run writes `done:<n>`; second run emits 0 entries (wire length unchanged) |
| G8 | Settings + groups preserve: rows@L re-emitted via their one-shots | Envelope lamport == L (not fresh); local lamports unchanged |
| G9 | Suite: test 18 | Green under scratch env; suite baseline recorded 1932/2/0 |

**Mutation matrix (every guard, per 2a lesson 3 — verify the harness actually reaches
the mechanism):** revert C2's opts on contacts → G1/G2 red. Delete the
`_drainPendingEmits` call from `_initInstanceInner` → G3b's spy red; gut
`_drainPendingEmits`' append → G3's delivery assertion red. Bypass the append chain
(append directly) → G3c's ordering assertion red. Remove the `finally` re-emit → G4
red. Re-emit with minted lamport instead of the tombstone's → G5 red (re-add wiped).
Remove C5 dedupe → G5-boot-2 red. Drop `losing_instance_id` from the C5 key → G2b
red. Drop the `resolved = 0` scope → dedicated resolve-then-redeliver assertion red.
Remove the `kind IS NULL` filter → G4's prune assertion red. Remove the live-row
LEFT JOIN filter (C4/m-3) → dedicated assertion red (seed the anomalous
row-beside-tombstone state; no delete may ride). Remove C7's contacts refusal → its
named test red. Each mutation checked against the NAMED test before restore.

## 6. Non-goals, follow-ups, risks

- **F-1 providers backfill:** left minting (INSERT OR IGNORE is clobber-proof). Noted
  in code comment.
- **F-2 secondary-process live edits** (stdio MCP servers sharing the prod DB, feeds
  never armed): their insert/update emits still reach nobody — pre-existing hole,
  unchanged by 2c, now *documented*; deletes ARE healed by C4 at next gateway boot.
  Recorded in the follow-up pool.
- **F-3 groups delete-wins:** `reemitGroupTombstones`' fresh mints are 2b-designed
  (re-adds lose, uid is deterministic). Excluded deliberately.
- **R-1 mixed fleet during rolling deploy:** envelope unchanged; old receivers apply
  preserved-lamport entries by the same LWW rules; old senders unchanged. No flag day.
  Old receivers lack C5, so a divergent old peer may log duplicate conflict rows until
  auto-update converges (hours) — cosmetic, bounded.
- **R-2 deploy-day tombstone surfacing:** first post-deploy boot re-emits every
  standing authoritative tombstone fleet-wide. Converged peers no-op. A peer holding a
  LIVE NEWER row for a tombstoned crow_id will log one truthful conflict row —
  surfacing REAL pre-existing divergence (today it is silent). Pre-deploy audit:
  enumerate `contact_tombstones WHERE kind IS NULL` × fleet rows and predict the delta
  before restarting anything; soak gate = conflicts flat *after* the predicted
  one-time surfacing, and dedupe holds it flat across a second restart.
- **R-3 emit hot-path cost:** one extra indexed SELECT on `crow_instances` per emit
  (a small table; emits are mutation-rate). Acceptable; measured in review if
  contested.
- **R-4 outFeed growth (R2/F6):** the per-boot tombstone re-emit appends one entry
  per standing tombstone per peer per boot to append-only Hypercores that are never
  truncated. Bounded in practice (authoritative tombstones = rare user deletes; boots
  = deploys), shared with the shipped W4 pattern, but a standing never-cleared
  tombstone (G5b divergence) accretes forever. Accepted residual; a feed-compaction
  story is a recorded follow-up (pre-existing need — W4 has the same shape).
- **R-5 conflict-index follow-up:** composite index on `sync_conflicts(table_name,
  row_id, op)` only if C5's pre-check ever shows up in profiles (table is tiny).

## 7. Live verification plan (crow↔grackle, real rows)

1. Pre-deploy audit per R-2 on all four instances (crow, MPA, grackle, black-swan).
2. Deploy in runbook order; watch first-boot logs for the re-emit lines.
3. Soak: `/health` ×4, `sync_conflicts` vs 219/182/162/0 (allowing only the
   R-2-predicted one-time delta, then flat), stash 4/17, no new error classes.
4. Real-row proof: create a throwaway contact on crow → converge to grackle → verify
   row lamports EQUAL on both sides. Stop crow's gateway briefly (deploy window),
   clear `__contacts_backfill_v1` on crow, restart → backfill re-runs with preserved
   lamports → grackle's row lamport UNCHANGED (snapshot before/after), conflicts flat.
5. Delete the throwaway contact on crow → converges to grackle (row gone both sides,
   tombstones both sides). Restart crow → `reemitContactTombstones` fires (log line),
   grackle row count and conflicts UNCHANGED across the restart.
6. Post-item CDP bug-hunt round per the standing directive.

---

## 8. Review log

**Round 1 (2026-07-14, fresh Opus subagent): REVISE — folded in this revision.**
- **C-1** dedupe key carried volatile `winning_data` (`last_seen` bumps at
  `servers/sharing/boot.js:889` without lamport movement) → conflicts would grow per
  boot in prod while the frozen-clock harness passed. Fixed: C5 stable lamport-pair
  key + G5 mutates `last_seen` between boots.
- **C-2** the reused harness never calls `initInstance`, so the drain-on-arm was
  untestable (vacuous G3). Fixed: `_drainPendingEmits(peerId)` seam writing through
  `outFeeds.get(...)`, real drain exercised against stub feeds + spy on the
  `_initInstanceInner` call.
- **M-1** "self-limiting" tombstone re-emit cited the wrong clear path and omitted the
  update-carried-edit case (never clears, `:1663`). Fixed: C4 termination rewritten +
  §4.4 qualified + G5b added; the persistent divergence is pre-existing #155
  delete-wins semantics, now visible and C5-bounded.
- **M-2** conflict row lands on the higher-lamport side, not "the stale side". Fixed
  in G2/§4.2 + lamport-column assertions.
- **M-3** "byte-equal" unsatisfiable (per-instance columns). Fixed: synced-column
  projection.
- **m-1** NULL-vs-NULL divergent legacy rows: accepted non-convergence documented +
  G6b. **m-2** settings lamport-tie residual documented (C2). **m-3** C4 gains the
  live-row LEFT JOIN belt-and-braces + mutation entry.
- Reviewer verified 10 spec claims correct against code (D-A..D-D mechanisms,
  providers exclusion, W4 fresh-mint rationale, wire compat incl. `row.lamport_ts`
  redundancy, counter-floor invariant, C3 queue race soundness in the in-process
  model, `req:`/prune tombstone handling).

**Round 2 (2026-07-14, fresh Opus subagent): REVISE — folded in this revision.**
- **F1 (MAJOR)** C5 key without origin collapsed two different peers' divergences at
  the same lamport pair. Fixed: `losing_instance_id` added to the key + G2b.
- **F2 (MAJOR)** naive check-then-push raced `initInstance`: entries strandable until
  reboot, and drain-vs-live-append could reorder a feed (receive path is
  order-sensitive). Fixed: per-peer ordered append chain (`_appendLocks`) through
  which live appends, pending pushes, and the drain all flow + G3c.
- **F3 (MAJOR)** G3's spy needed the real `_initInstanceInner`, which writes
  Hypercores to the process-default data dir — prod-polluting or vacuous as specced.
  Fixed: G3b wiring variant with `mgr.dataDir` → mkdtemp
  (`tests/instance-sync-noauth-feeds.test.js:71` precedent).
- **F4** C5 pre-check must mirror the op-column-absent fallback or pre-migration DBs
  lose ALL conflict logging. Folded. **F5** pre-check scoped to `resolved = 0`
  (re-surface once after resolution) + index deferred (R-5). **F6** outFeed growth
  residual documented (R-4). **F7** revoke-race pending-slot leak bounded +
  documented (C3).
- **F8 (latent bug, folded as C7):** `restoreConflict` corrupts contacts conflict
  rows (JSON row_id treated as scalar id) — refusal guard + test added to scope.
- Reviewer re-verified sound: C4's live-row filter, §7.4 no-op re-emit claim
  (`_afterContactApplied` fires only on winning branches), same-lamport cross-peer
  independence, null-`theirFeedKey` drain correctness, the gated-backfill refactor's
  return contract, counter floor, delete-wins termination, settings tie residual.
