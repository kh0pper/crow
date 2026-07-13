# Item 2b — contact_groups offline-peer tombstones (design)

**Status: v3 — both adversarial rounds folded (R1: 2 blocking; R2: 3 blocking, ALL in
R1's fixes — the 2a fix-introduces-bug pattern, caught in prose this time). The
executable multi-instance gate (§5) is the final arbiter per the 2a lesson.**
- R1 blocking: (F1) tombstone gate must be atomic with the write → STATEMENT-LEVEL
  `NOT EXISTS` guards; (F2) a peer that pairs after the delete never hears it →
  tombstone re-emit at boot (§3.7).
- R2 blocking, each against an R1 fix: (F1') the per-peer backfill FLAG survives
  revoke/re-pair (peer ids are install-stable; revoke clears neither flags nor feed
  dirs) → §3.7 now uses NO flag, every-boot re-emit; (F2') rooms ARE listed in the
  Groups view with working delete buttons — refusal would break live UI → W1 routes
  room ids to `deleteRoom()`; (F3') the sync-conflicts RESTORE button re-INSERTs a
  tombstoned uid through a supported UI path → G3 guard added, §2 audit corrected.
Arc: `docs/superpowers/plans/2026-07-11-opus-autonomous-arc.md` §4 Item 2b.
Precedent: `contact_tombstones` (#155, `servers/sharing/contact-delete.js`) — but this
design deliberately DIVERGES from it (see §3.1: strict delete-wins, no lamport gate).
Mandatory prior reading: the 2a lesson (plan §4 Item 2a) — prose review is not
sufficient for distributed state; the acceptance gate here is EXECUTABLE,
MULTI-INSTANCE, and exercises the MUTUAL case (§5).

## 1. The defect (verified in current code, main `d7a5f93a`, 2026-07-13)

Group delete PROPAGATES live: `emitGroupDelete` (`servers/sharing/group-sync.js:61`)
is wired at `panels/contacts/api-handlers.js:332`. But nothing remembers the delete:

- `_applyGroup` (`servers/sharing/instance-sync.js:1859`) applies `op=delete` only if
  `lamportTs > localTs` (`:1894`), writes NO tombstone, and its insert branch
  (`:1911`) inserts unconditionally whenever no local row exists.
- So a peer OFFLINE at delete time keeps the row; ANY later local touch on that peer
  (rename `:315`, membership change, C4 contacts-follow-user side effects) calls
  `emitGroupUpsert` at a fresh lamport, and every other instance — having no local row
  and no memory of the delete — re-INSERTs the group. Resurrection, fleet-wide.

### 1.1 The mutual case (S2) — why the #155 lamport-gated pattern is NOT sufficient

A deletes group G (delete emitted at lamport `d`). B, offline, renames G — B's emit
counter was already ahead, so the rename row carries lamport `r > d`. On reconnect:

- A→B: the delete arrives with `d < r` → B keeps its renamed row (`:1899` conflict row).
- B→A: the rename arrives; A has no row → unconditional INSERT → G is back on A.

Result: the delete is silently lost on BOTH sides. Now add a #155-style tombstone with
its `insert <= tomb.lamport ⇒ drop` gate: `r > d` **passes** the gate — the tombstone
clears and G resurrects anyway. **A lamport-gated tombstone does not fix the mutual
case for groups.** The gate exists for contacts because a contact (a stable external
identity, `crow_id`) can genuinely be re-added and the tombstone must be able to lose.
Groups are different — see §2.

## 2. The load-bearing fact: a group uid can never legitimately return

`contact_groups_group_uid_ai` (`scripts/init-db.js:1960`) assigns every newly inserted
group a **random** uid (`lower(hex(randomblob(16)))`). A user who deletes "Family" and
later re-creates "Family" gets a NEW uid; the tombstoned uid never reappears on any
legitimate path. Therefore an incoming insert/update for a tombstoned `group_uid` is
**always stale state** and can be dropped unconditionally.

**Sole exception — the legacy deterministic backfill.** `_assignDeterministicGroupUids`
(`instance-sync.js:826`) assigns `sha256(pubkey ":" lower(trim(name)))[..32]` to
pre-trigger rows still carrying `group_uid IS NULL`. Two instances that both hold the
same legacy group converge on the SAME uid — so an instance that was offline through a
fleet-wide delete of that legacy group can *regenerate* the tombstoned uid at boot.
Handled in §3.4 (already-paired case) and §3.7 (paired-after-the-delete case).

Full insert/uid-setter audit (R1 F6): `api-handlers.js:306` (create_group,
trigger-random uid), `tools/messaging.js:93` (`crow_create_message_group` — plain-group
creator, trigger-random uid, emits via `emitGroupUpsert` so G2 covers it),
`rooms-store.js:16/:33` (rooms — trigger-random uid, never synced),
`instance-sync.js:1918` (sync apply — G1's statement guard), `instance-sync.js:846`
(deterministic backfill — W3), **`sync-conflict-resolve.js:290-309` (conflict-restore
INSERT — R2 F3', guarded by G3)**, and the trigger itself. Premise holds on every
path — but only WITH G1 and G3 in place; v2's unconditional "holds on every path" was
falsified by the restore path.

Rooms (`room_uid NOT NULL`) are out of scope end to end: `shouldSyncRow` (`:227`) drops
them both directions, the room-close delete (`rooms-store.js:92`) is `getRoom`-guarded,
and `_applyGroup` never matches them (`... AND room_uid IS NULL`). No room tombstones.

## 3. Design

### 3.1 Semantics: STRICT delete-wins, keyed on group_uid, no lamport gate

A standing tombstone for `group_uid` U means: drop every incoming `insert`/`update` for
U, forever. There is no clear-on-higher-lamport path (contrast `contact_tombstones`),
because §2 makes every same-uid reappearance stale by construction. This also removes
the entire lamport-commensurability hazard class that produced three of 2a's six bugs —
`lamport_ts` is recorded on the tombstone for observability only and is consumed by
**nothing**.

Trade-off accepted: in S2, B's offline rename is discarded when the delete wins.
Delete-wins is the documented semantic (#155 set the precedent for contacts); a group
is an organizational label, and losing a rename to a concurrent delete is the correct
resolution of that pair.

### 3.2 Schema (SCHEMA_GENERATION 7 → 8)

```sql
CREATE TABLE IF NOT EXISTS group_tombstones (
  group_uid  TEXT PRIMARY KEY,
  lamport_ts INTEGER NOT NULL DEFAULT 0,   -- observability only; gates nothing
  deleted_at INTEGER NOT NULL              -- unix seconds, first write wins
);
```

- DDL in `scripts/init-db.js` beside the `contact_groups` block (~`:1857`).
- Bump `SCHEMA_GENERATION` in `servers/shared/schema-version.js:13` (7 → 8). That
  module must stay free of side-effecting imports.
- No FTS shadow. Tombstones are LOCAL state — `group_tombstones` is NOT added to
  `SYNCED_TABLES`; each instance derives its own from the delete op (§3.3).
- UPSERT (mirrors `tombstoneStatement` minus the kind machinery):
  `INSERT ... ON CONFLICT(group_uid) DO UPDATE SET lamport_ts = MAX(...)` —
  `deleted_at` preserved on conflict. Single kind — there is exactly one writer class
  (authoritative user delete); no `kind` column, and §3.1 means no cross-clock MAX
  hazard (the field gates nothing).

### 3.3 Write and gate sites (all in existing files; new primitives in a new
`servers/sharing/group-delete.js`, import-free like `contact-delete.js`)

**W1 — originating delete** (`api-handlers.js` `delete_group`, `:327-334`): the local
DELETE and the tombstone MUST be ATOMIC — one `db.batch()` (confirmed available on the
gateway's db client, `servers/db.js:371`, a true single transaction) — per 2a lesson 4
(neither ordering survives its failure modes). Only when the row is a plain group
(`room_uid IS NULL`) with a non-NULL `group_uid`. `emitGroupDelete(gUid)` stays after
the batch, unchanged.
- **Room-id hardening (R1 F3, corrected by R2 F2'):** the handler currently DELETEs
  whatever id it is given, including a ROOM row — and this is a LIVE UI path, not just
  a forged POST: `getGroups` (`panels/contacts/data-queries.js:110`) has no
  `room_uid IS NULL` filter, so rooms render in the Groups view with working Delete
  buttons. v2's "refuse" would have turned that button into a silent no-op. Fix:
  SELECT `group_uid, room_uid`; if `room_uid IS NOT NULL`, ROUTE to
  `deleteRoom(db, gid)` (`rooms-store.js:80` — proper teardown) with NO tombstone and
  NO emit; additionally add `WHERE g.room_uid IS NULL` to `getGroups` so rooms stop
  rendering in the Groups list at all (they have their own UI).
- A NULL-uid plain group (legacy row never booted since C1) deletes WITHOUT a tombstone
  and emits nothing — same as today. Its deterministic uid may later be regenerated by
  a peer's backfill; that peer's copy survives locally but W3's tombstone-check-on-
  assign (§3.4) protects the deleting instance. Documented limitation (pre-existing:
  such rows never synced at all).

**W2 — receive-side apply** (`_applyGroup` delete branch, `:1892-1908`): make it strict
delete-wins —
- Write the tombstone FIRST, unconditionally (even when `!localRow`, protecting against
  update-after-delete arrival reordering and pre-arming third instances), then DELETE
  the local row regardless of lamport comparison, both in one `db.batch()`.
- When the local row was newer (`lamportTs <= localTs`), STILL delete, but keep writing
  the conflict row (`_insertConflictRow`, op "delete") so today's observability
  (`sync_conflicts` + notify) is preserved — the row records that a local edit lost to
  a delete. **R2 F6: the winner/loser arguments must be SWAPPED** (delete = winning,
  the discarded local row = losing) — v2's "update the comment" was insufficient: the
  discarded rename is the only surviving record of the S2 trade-off and must be
  labeled truthfully in the UI.

**G3 — conflict-restore guard (R2 F3', blocking):** `restoreConflict`
(`servers/sharing/sync-conflict-resolve.js:290-309`) plain-INSERTs `losing_data` when
the live row is gone — an operator clicking Restore on an old `contact_groups`
conflict re-inserts a tombstoned uid, manufacturing the zombie through a SUPPORTED UI
path (G1 then quarantines it on peers: permanent, silent). Fix: for `contact_groups`,
apply the same `WHERE NOT EXISTS (SELECT 1 FROM group_tombstones WHERE group_uid=?)`
guard to that INSERT; when it no-ops, surface "group was deleted fleet-wide —
restore refused" rather than success.

**G1 — apply gate, STATEMENT-LEVEL (R1 F1, CRITICAL).** The invariant lives IN the
write statements, not in a prior read: `_processNewEntries` serializes per peer but
different peers' feeds drain CONCURRENTLY, and any read-then-write crosses await
boundaries — a delete applying in that window yields a permanent
live-row-beside-tombstone zombie on the applier (silent, zero `sync_conflicts`).
- Insert branch (`:1917`): `INSERT INTO contact_groups (…) SELECT ?,… WHERE NOT EXISTS
  (SELECT 1 FROM group_tombstones WHERE group_uid = ?)` — one statement, atomic in
  better-sqlite3 — and run `_reconcileGroupMembers` ONLY if `rowsAffected > 0`.
- Update branch (`:1931`): append `AND NOT EXISTS (SELECT 1 FROM group_tombstones
  WHERE group_uid = ?)` to the UPDATE; reconcile members only if `rowsAffected > 0`.
- An early tombstone read MAY remain as a fast-path skip (silent drop, no conflict
  row), but it is an optimization — the statement guard is the correctness mechanism,
  and the mutation check targets the statement guard (T8).
- The same race exists on the ORIGINATING instance (inbound upsert vs. W1's batch in
  `delete_group`) — the statement guard covers it identically.
`op=delete` skips the gate (it re-writes the tombstone idempotently via W2).

**G2 — emit gate** (`emitGroupUpsert`, `group-sync.js:35`): skip the emit when the
row's uid is tombstoned. Defense in depth for the anomalous live-row-beside-tombstone
state; G1 on the receiving side already protects peers, so this is belt-and-braces,
not load-bearing. **FAIL-OPEN (R1 F4):** the tombstone read gets its OWN try/catch —
a read failure (e.g. an un-migrated DB under a stale session-spawned stdio server)
means "not tombstoned", never "swallow the emit"; otherwise a missing table silently
kills ALL group sync emits from that process, including `crow_create_message_group`
(`tools/messaging.js:122`) and the boot backfill.

### 3.4 W3 — the legacy deterministic-uid edge

In `_assignDeterministicGroupUids` (`:826`): after deriving the candidate uid and
BEFORE assigning it, check `group_tombstones`. If tombstoned, the logical group was
deleted fleet-wide while this instance was offline (or pre-C1): DELETE the local legacy
row instead of assigning the uid (log one line, count separately in the boot summary).
Collision-retry slots (`\x1f` suffix) get the same check per candidate. Without W3, a
legacy instance regenerates the tombstoned uid and (G1 on peers) diverges silently —
its copy would live locally forever while every peer drops its emits.

### 3.7 W4 — per-peer tombstone backfill (R1 F2, MAJOR — delivery, not semantics)

Sync feeds are created **EMPTY at first pairing** (`_initInstanceInner` — no history
replay; documented at `instance-sync.js:684-690`). So a peer that pairs (or re-pairs —
this fleet has deleted and re-formed a pairing before) AFTER the delete never receives
the delete op, and W3 reads a tombstone table that peer never populated: it
regenerates the deterministic uid at boot, emits, every established peer G1-drops it,
and that node holds the group forever — silent permanent one-node divergence. The same
gap covers non-full-mesh topologies (applying a synced entry never re-emits) and a
dropped `feed.append` (`:1040` warns and drops; no outbox).

**Fix — NO FLAG, re-emit every boot (R2 F1' replaced v2's per-peer flag design):**
v2 mirrored `backfillProvidersForNewPeers`' per-peer flag — but R2 showed that flag
lifecycle is broken for exactly the motivating case: peer ids are install-stable
(`registerInstance` is `ON CONFLICT(id) DO UPDATE`), revoke clears neither the
`dashboard_settings` flags nor the feed dirs, so a revoke→re-pair reuses the id, the
`done:` flag still stands, and the backfill never fires again — silently reproducing
R1 F2's divergence. (The providers backfill has this same pre-existing hole — recorded
as a follow-up, NOT in 2b's scope.)

Instead: **at boot (after `backfillGroupsOnce`'s drain point), emit
`op=delete { group_uid }` for every `group_tombstones` row, unconditionally, every
boot.** Safe and cheap because:
- Idempotent on receivers: W2 re-writes the tombstone (UPSERT), the DELETE matches
  nothing on converged peers; a stale-copy holder gets exactly one delete-won
  conflict row and converges.
- No lamport thrash: delete ops never stamp row lamports (`emitChange:1009` skips
  `op=delete`), so unlike the contacts/providers backfills there is nothing to guard
  with a one-shot flag — that flag existed to stop re-emit churn on live rows.
- Bounded: group deletes are rare, rows tiny; the emit loop is
  `SELECT group_uid FROM group_tombstones` per boot.
- This also closes R2 F7's residuals for free: a warn-dropped `feed.append` (`:1040`)
  and any missed window heal on the next boot, and a freshly-paired peer hears every
  historical delete on the first boot after pairing.

### 3.5 Retention: NONE (deviation from the plan item's text — deliberate)

The plan item says "retention pruning". Recommendation: **do not prune.** Rows are
~50 bytes, group deletes are rare (single-user organizational labels), and any
retention window re-opens the resurrection hole for peers offline longer than the
window — the exact defect this item exists to close. `contact_tombstones` set the
never-prune precedent for the same reason (#155 design §D3). If growth ever matters, a
future prune can safely target tombstones older than the oldest possible peer state,
but nothing forces that decision now. R1 F8 challenged this and upheld never-prune:
any horizon would have to exceed "time since a peer last paired", which W4's
motivating case shows is unbounded. The real residual cost — a bug-written tombstone
is permanent with no operator surface — is best met with observability (a follow-up
can list tombstones in the sync-conflicts settings section; NOT in 2b's scope), not
with a pruner.

### 3.6 Known limitations (documented, out of scope)

- **Boot-window emit loss (2c's finding):** `emitChange` returns a valid lamport when
  `outFeeds.size === 0`, so a delete during the boot window broadcasts to nobody. The
  tombstone still lands locally (W1 is atomic with the DELETE), so THIS instance can
  never resurrect — and W4's per-peer backfill now retro-delivers the delete on the
  next peer-generation detection, narrowing the gap further. 2c closes the channel
  itself.
- **Live-row-beside-tombstone anomaly:** the STATEMENT-LEVEL guard (G1) closes the
  concurrent-apply race R1 F1 identified (v1 wrongly claimed the state was
  unreachable); if manufactured manually (direct DB edit), G2 mutes its emits and G1
  drops inbound writes. No auto-heal.
- **A NULL-uid legacy group deleted before its C1 boot** never had a wire identity;
  see W1. Note (R1 F7): `_assignDeterministicGroupUids` runs EVERY boot before the
  backfill flag gate, so on any instance that has booted 2b-era code this branch is
  near-dead — do not build ceremony around it.
- **DB-restore-from-backup** can resurrect rows and lose tombstones on one instance —
  pre-existing class shared with `contact_tombstones` (#155); W4's every-boot re-emit
  heals the peers (the restored instance itself heals on receiving any peer's W4
  re-emit of its own tombstones — if no peer holds the tombstone either, the delete is
  simply lost, same as #155).
- **FK-ON is a load-bearing premise (R2 F4):** G1 closes the row race, but a W2 delete
  landing between the guarded INSERT and `_reconcileGroupMembers` leaves the reconcile
  inserting members against a dead group_id — converged only because `foreign_keys=ON`
  (better-sqlite3 default here, verified at `rooms-store.js:84-87`) rejects each
  insert. On any FK-OFF connection these would be permanent orphan rows. Documented
  premise, no code change.
- **The providers backfill's per-peer flag survives revoke/re-pair** (R2 F1' collateral
  discovery) — pre-existing hole in `backfillProvidersForNewPeers`, same class as the
  one W4 avoids by being flagless. Follow-up, NOT 2b scope.

## 4. Files touched

| File | Change |
|---|---|
| `servers/sharing/group-delete.js` | NEW — import-free tombstone primitives: `groupTombstoneStatement`, `readGroupTombstone`, `isGroupTombstoned` |
| `scripts/init-db.js` | `group_tombstones` DDL |
| `servers/shared/schema-version.js` | `SCHEMA_GENERATION` 7 → 8 |
| `servers/sharing/instance-sync.js` | W2 strict delete (+F6 winner/loser swap) + G1 STATEMENT guards in `_applyGroup`; W3 in `_assignDeterministicGroupUids`; W4 flagless boot re-emit |
| `servers/gateway/dashboard/panels/contacts/api-handlers.js` | W1 atomic batch + room-id routing to `deleteRoom` in `delete_group` |
| `servers/gateway/dashboard/panels/contacts/data-queries.js` | `getGroups` gains `WHERE g.room_uid IS NULL` |
| `servers/sharing/sync-conflict-resolve.js` | G3 restore guard for `contact_groups` |
| `servers/sharing/group-sync.js` | G2 emit gate (fail-open) |
| `tests/group-tombstones.test.js` | NEW — the executable gate (§5) |

## 5. Acceptance gate — EXECUTABLE, MULTI-INSTANCE, MUTUAL (written FIRST, red)

Harness: reuse the two-real-`InstanceSyncManager`s + captured-fake-out-feed pattern
from `tests/advertised-prune-durability.test.js` (two scratch DBs, entries drained
manually in controlled order — both directions, BOTH orders).

⚠️ Harness trap (R1 F5a): the prune harness installs `contact-sync.js`'s test sink;
groups route through `group-sync.js`'s SEPARATE `__setEmitSinkForTest` (`:22`). Wire
the GROUP sink (and/or call `mgr.emitChange` directly) and assert wire-length > 0
before relying on any drain. T1's lamport interleaving must be explicit: advance B's
counter (harness `setCounter`) above the delete's lamport before B's rename.

- **T1 (S1 resurrection, the defect):** A deletes G; B (offline) renames G at a higher
  lamport; drain A→B then B→A. BOTH sides end with no row for G's uid and a standing
  tombstone. **RED-ON-MAIN REQUIRED:** on unmodified main this test must FAIL by
  resurrecting G on A — that failure is the proof the harness reaches the mechanism
  (2a lesson 3, anti-vacuous).
- **T2 (S1 reversed order):** drain B→A first, then A→B. Same converged end state.
  **RED-ON-MAIN REQUIRED.**
- **T3 (mutual delete):** A and B delete G concurrently; drain both. Converged, both
  tombstoned, `sync_conflicts` growth = 0.
- **T4 (negative control):** a live group's rename + membership change still sync
  normally end-to-end; creating a brand-new group after deleting a same-named one
  syncs (fresh uid ≠ tombstoned uid).
- **T5 (restart durability):** rebuild manager B on the same DB (fresh instance, same
  files); a stale upsert for the tombstoned uid is still dropped after restart.
  **RED-ON-MAIN REQUIRED.**
- **T6 (W3 legacy edge):** seed a NULL-uid legacy row on B whose deterministic uid is
  tombstoned; run `_assignDeterministicGroupUids`; the row is deleted, nothing emitted.
  ⚠️ Seeding trap (R1 F5b): the `contact_groups_group_uid_ai` trigger makes a NULL-uid
  INSERT impossible — seed with INSERT then `UPDATE ... SET group_uid = NULL`. Do NOT
  weaken the assertion if the naive seed fails; fix the seed.
- **T7 (W1 atomicity):** batch such that the tombstone write fails ⇒ the DELETE must
  not land (and vice versa) — assert via an injected failing batch. Drive the REAL W1
  site (`handleContactAction` with a fake req — the pattern ten existing tests use).
- **T8 (G1 statement-guard race, R1 F1):** the guarded INSERT/UPDATE statements are
  no-ops against a pre-written tombstone even when a prior read said "no tombstone" —
  unit-test the statements directly against a pre-seeded tombstone.
  ⚠️ Mutation-check trap (R2 F5): on the INSERT branch, forgetting the
  `rowsAffected > 0` reconcile gate is INVISIBLE (`_groupIdByUid` returns null →
  reconcile early-returns) — the "no member rows" assertion passes vacuously. The
  reconcile-gate mutation check must seed the zombie state (tombstone + live row) and
  drive the UPDATE branch, where `localRow.id` is real; that is the only place the
  gate is load-bearing.
- **T9 (W4 every-boot re-emit):** delete G on A (tombstone standing); pair a FRESH
  manager C (new empty feeds) seeded with a stale live copy of G; run A's boot re-emit;
  C converges to deleted + tombstoned with exactly one delete-won conflict row. Also:
  a second boot re-emit produces NO further state change on any peer (idempotence) and
  no `sync_conflicts` growth.
- **T10 (room routing, R2 F2'):** `delete_group` with a room's id calls `deleteRoom`
  (room + members + room_messages gone), writes NO tombstone, emits NOTHING; and
  `getGroups` no longer returns rooms.
- **T11 (restore guard, R2 F3'):** seed a `contact_groups` conflict row whose
  losing_data carries uid U; tombstone U; operator-restore via `restoreConflict` →
  refused/no-op, no live row, tombstone intact.
- **Conflict-row assertions in every T:** exact expected `sync_conflicts` delta (T1/T2
  allow exactly the one delete-won row from W2; others 0).
- **Mutation checks (each must redden the NAMED test that claims to catch it, not a
  neighbor):** remove the statement guard's NOT EXISTS → T8 red (and T1/T2/T5 red via
  the fast path removed too — verify T8 specifically); comment out W2's tombstone
  write → T1 red; comment out W3 → T6 red; split W1's batch into two executes with the
  injected failure → T7 red; comment out W4's emit loop → T9 red; remove the room
  routing → T10 red; remove G3's guard → T11 red. The T8 reconcile-gate mutation runs
  against the UPDATE branch per the F5 trap above.

## 6. Ship sequence

Full §2 pipeline + the §3 migration rail (MANDATORY — schema bump):
1. Branch `fix/2b-group-tombstones`. Test first (T1 red on main's code).
2. Build (SDD tasks per §4 rows), per-task review, final whole-branch review.
3. Gates: full suite on scratch env (baseline 1738 / 3 known fails / 0 skips),
   check-ports (exactly the one capstone-tracker line), build-registry.
4. RAIL: disable auto-update ×4 → confirm; **verify no FIFTH DB exists anywhere in
   the fleet first (R1 F7)** — `servers/db.js:22` mentions a "finance" instance that
   does not exist on disk today; the 2a lesson was precisely a DB the rail forgot, so
   sweep for `*/data/crow.db` under each host's home before backing up; back up all
   FOUR DBs (crow, MPA `~/.crow-mpa`, grackle, black-swan);
   `scripts/schema-migration-dryrun.sh` FROM THE BRANCH on copies of all four — the output MUST show `group_tombstones` as the only
   schema delta, `user_version` 7→8, zero row-count deltas; merge; deploy in runbook
   order (crow+MPA → grackle bridge-then-gateway → black-swan); verify each
   (`/health`, `integrity_check`, row-count diff, `user_version=8`); re-enable
   auto-update ×4 and CONFIRM `'true'` ×4.
5. Live verify (crow↔grackle, throwaway group): create + sync; stop grackle's gateway
   briefly (short window, prod restored immediately after); delete on crow; restart
   grackle; touch/rename the still-present group on grackle → crow must NOT resurrect
   it, and grackle must converge to deleted on draining the feed. `sync_conflicts`
   baseline 219/182/162/0 — only the expected W2 delta. Clean up the throwaway group.
6. Record in plan doc + ledger + memory.
