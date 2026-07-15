# Item 2c — Lamport-preserving re-emit + boot-window emit loss (design)

**Date:** 2026-07-14 · **Status:** DRAFT (pending 2-round adversarial review)
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
The #147 `done:<n>` flag logic is untouched (only a completed armed run writes it,
`:668-676`).

### C3 — Boot-window pending queue (fixes D-B)

In `emitChange`, after the entry is built and signed: fetch the paired-peer id set
(`SELECT id FROM crow_instances WHERE status IN ('active','offline') AND id != ?` —
the same predicate `eagerInitPairedPeers` uses). For every paired id **without an open
outFeed**, push the signed entry onto `this._pendingPeerEmits` (Map peerId → FIFO
array, capped at 256 entries per peer; on overflow drop the oldest with a one-line
warn — LWW makes oldest-first the safe drop direction). Append to open feeds as today. Return the
envelope lamport (delivery is now pending, not lost — the return stays honest).

Drain: at the end of `initInstance`'s inner body, when an outFeed for that peer is
(newly or already) open, append that peer's pending entries FIFO and clear the slot.
`initInstance` is the single choke point every feed-open path converges on (boot loop,
`eagerInitPairedPeers`, hyperswarm connect, tailnet-sync, handshake), so the drain
covers all of them. On instance revoke, drop the peer's pending slot.

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
flagless). Drain inbound first (I-B1 — load-bearing here: an already-delivered re-add
must clear our tombstone via rule (a) *before* we re-emit it). Then for every
`contact_tombstones` row **`WHERE kind IS NULL`** (authoritative user deletes ONLY —
`kind='prune'` is local GC and must never ride the wire, 2a):
`emitChange("contacts", "delete", { crow_id }, { lamportTs: tomb.lamport_ts })`.

The preserved lamport is the original global delete lamport, so the re-emit beats
exactly what the original broadcast would have beaten — no more, no less. Receiver
outcomes (`_applyContact`): no local row → tombstone UPSERT, same-kind MAX (`:1608`,
idempotent); older local row → delete + tombstone (heals the divergence D-B/D-C
created, including re-pairs); **newer local row (a genuine re-add) → survives** with
one conflict row (`:1626`), and when the re-add syncs back, rule (a) (`:1584-1587`)
clears our tombstone and the re-emit stops. Volume: authoritative tombstones are
user deletes — rare, never pruned (`contact-delete.js:10`), one tiny SELECT per boot.

### C5 — Exact-repeat conflict dedupe

`_insertConflictRow` gains a pre-check: skip the INSERT when a row with identical
(`table_name`, `row_id`, `op`, `winning_lamport_ts`, `losing_lamport_ts`,
`winning_data`, `losing_data`) already exists. Full-identity match: only *literal
redeliveries* are suppressed; any evolution of either side (new lamport, new data)
still logs. Without this, C4's per-boot re-emit against a still-divergent peer (the
G5 window) would grow `sync_conflicts` — the fleet's red-flag metric — on every boot.
`_notifyConflict` is only called after a real insert (both call sites follow the
insert), so notification behavior follows automatically.

### C6 — Test-18 harness fix

`makeManager` (`tests/instance-sync.test.js:73`) sets `mgr.feedsDisabled = false`
after construction, with a comment citing the 2b fixture precedent. Verify test 18
passes and record the new suite baseline (expected 1932/2/0).

---

## 4. Convergence analysis (what the gate in §5 proves executably)

1. **Preserved-lamport re-emit can never fabricate recency.** The envelope carries a
   lamport ≤ the row's original emit lamport, so it wins LWW only where the original
   write would have won. Fresh peers still receive rows (insert branch is
   lamport-independent); converged peers no-op (`rowsEquivalent`/value-equal skip);
   newer peers keep their rows.
2. **Mutual backfill converges.** A and B backfill simultaneously with divergent rows:
   each side's re-emit carries its row's own lamport; the higher one wins on both
   sides; the lower side logs exactly one truthful conflict row; redelivery adds
   nothing (C5).
3. **Boot-window emits are delivered, not dropped.** The entry (with its already-minted
   lamport, already signed) is appended verbatim when the peer's feed opens; the
   counter floor keeps subsequent live mints strictly above it, so causality on the
   feed is preserved.
4. **Tombstone re-emit is self-limiting.** Divergent peer with newer re-add: re-emit
   loses (row survives), re-add syncs back, rule (a) clears the tombstone, next boot
   re-emits nothing. Mutual concurrent deletes: same-kind MAX upsert on both sides,
   idempotent. Converged peers: tombstone UPSERT is a no-op row-wise and writes no
   conflicts.
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
| G1 | A stale contact@5, B same crow_id newer@10, divergent values; A runs backfill; deliver both ways | B keeps its @10 values; **A's local row still @5** (no re-stamp); A converges to B's @10; final rows byte-equal |
| G2 | BOTH sides backfill concurrently (same divergent pair), deliver interleaved; then re-deliver the same wire again | Both converge to @10; exactly 1 conflict row total (on the stale side); **re-delivery adds 0 rows** (C5) |
| G3 | B paired in A's `crow_instances` but A's outFeeds EMPTY; `deleteContactLocal` on A; then arm A's feed for B and drain | Wire empty at delete time; entry rides on arm; B's row deleted + tombstoned; A's tombstone lamport == envelope lamport |
| G4 | A deletes (delivered to nobody — skimWire); A restarts; gated backfill already `done:` | `finally`-path tombstone re-emit delivers; B (row@old) deletes + tombstones; both sides converged |
| G5 | A tombstone@10; B re-added@20 (not yet synced); A boots twice; then B's re-add delivers to A | B's re-add SURVIVES both boots; boot 1 logs exactly 1 conflict row, **boot 2 logs 0** (C5); A applies re-add, clears tombstone; boot 3 re-emits nothing |
| G6 | A legacy row lamport NULL; B holds same crow_id @7 with different values; A backfills; then the same emit against a peer that lacks the row entirely | Envelope lamport 0; B's row untouched; A's row lamport stays NULL; the missing-row peer receives the row |
| G7 | #147 flag: run G1's backfill twice | First run writes `done:<n>`; second run emits 0 entries (wire length unchanged) |
| G8 | Settings + groups preserve: rows@L re-emitted via their one-shots | Envelope lamport == L (not fresh); local lamports unchanged |
| G9 | Suite: test 18 | Green under scratch env; suite baseline recorded 1932/2/0 |

**Mutation matrix (every guard, per 2a lesson 3 — verify the harness actually reaches
the mechanism):** revert C2's opts on contacts → G1/G2 red. Remove C3's drain-on-arm →
G3 red. Remove the `finally` re-emit → G4 red. Re-emit with minted lamport instead of
tombstone's → G5 red (re-add wiped). Remove C5 dedupe → G5-boot-2 red. Remove the
`kind IS NULL` filter → new assertion in G4 red (seed a `'prune'` tombstone; it must
NOT ride). Each mutation checked against the NAMED test before restore.

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
