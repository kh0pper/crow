# Messages Phase 3 — Groups follow the user (D1 groups clause) — Implementation Plan

> **Status: DRAFT PLAN (untracked — for 2-round adversarial Opus SECURITY review next session).**
> This is the HELD follow-up PR of the Crow Messages Phase 3 arc, sequenced AFTER
> PR-A (contacts follow the user — shipped) and PR-B (conversation coherence —
> merged #146 + #147). It honors D1's **groups** clause, deferred in the spec's
> **S-GROUPS** decision until PR-A proved the natural-key sync path out.
>
> **Spec:** `docs/superpowers/specs/2026-07-06-messages-phase3-contacts-follow-user-design.md`
> (§ S-GROUPS; § "Deferred follow-up — Groups"; § Trust boundary).
> **Sibling plan (style + seams to reuse):** `docs/superpowers/plans/2026-07-06-messages-p3-pr-b-conversation-coherence.md`.
> **Master plan:** `docs/superpowers/plans/2026-07-01-crow-messages-usability-arc.md` (§ Phase 3).

---

## R1 review outcome

**Verdict: REVISE — 1 critical / 2 important / 4 minor. All findings closed in this
revision (below); a re-review is required before any code.**

- **C1 (CRITICAL — pre-existing-group split-brain) — CLOSED.** A per-instance
  `randomblob` `group_uid` backfill gives the SAME logical pre-existing group (e.g.
  "Family" created independently on crow AND grackle *before* this feature) a
  **different** uid on each instance → the one-shot backfill cross-INSERTs → every shared
  legacy group is **permanently duplicated fleet-wide**. Adopted R1's recommended fix
  **(B):** pre-existing plain groups get a **deterministic, frozen** uid =
  first-32-hex of `sha256(<shared-identity ed25519 pubkey, hex> + ":" + lower(trim(name)))`,
  computed **in JS** (SQLite has NO `sha256` SQL function) and then **FROZEN** (never
  re-derived on rename). Same-named legacy groups converge on ONE uid exactly like
  `crow_id`; NEW post-feature groups keep the random trigger uid (single-origin — they
  propagate by emit, so the peer never independently creates a duplicate). **Where it
  happens: option (ii) — in `backfillGroupsOnce` (the manager holds the decrypted
  identity), NOT the init-db migration** (init-db cannot decrypt a passphrase-protected
  seed and has no sha256; see the C1 decision box in Task 4). The migration therefore
  **no longer randomblob-fills pre-existing rows** — it leaves them `group_uid IS NULL`,
  and the manager assigns deterministic uids to those NULL rows before emitting. **Local
  same-name collision tie-break:** two locally-distinct plain groups with the same name on
  ONE instance are disambiguated by distinct suffixed hashes in ascending `id` order,
  non-destructive (both local groups are preserved; merging would silently destroy one
  user-intended group + its distinct membership). *Mechanism revised in R2 (see R2 F1
  below): collision-DRIVEN `\x1f`-keyed retry, not the R1 draft's pre-counted `name + "#2"`
  suffix.* See Task 1 (migration), Task 4 (assignment + tie-break + tests), E2E case (e)
  (both-sides same-name convergence).
- **I1 (membership is whole-set LWW) — CLOSED.** Stated explicitly everywhere: on a
  *winning* apply, membership is **wholesale-replaced** by the higher-lamport side's full
  wire-map (bounded to the syncable contact domain). Two instances editing membership
  concurrently resolve to the winner's **entire** set — a concurrent removal on the losing
  side is **reverted**. Known-limitations wording + E2E claims made honest.
- **I2 (emit JOIN leaks local-bot/pending crow_ids + unbounded add-branch) — CLOSED.**
  `emitGroupUpsert`'s member JOIN now **excludes** `origin='local-bot'` and non-established
  (`request_status NOT NULL AND request_status != 'accepted'`) members; `_reconcileGroupMembers`'s
  **add**-branch is now bounded to syncable resolved contacts — symmetric with the
  remove-branch. Tests updated in Tasks 2 + 3.
- **M1 (`sort_order` has no mutation site) — CLOSED.** Reclassified **forward-looking**:
  it rides the wire and applies if present, but NO UI/tool writes it today, so it never
  actually diverges. Dropped from the "actively synced fields" claim.
- **M2 (create_group emit must stay INSIDE the `if(name)` guard) — CLOSED.** Explicit
  warning at the call site — a stale/undefined `lastInsertRowid` outside the guard would
  emit a phantom/duplicate group.
- **M3 (metadata-equal tie → silent membership divergence) — CLOSED.** One-line
  Known-limitation: on a `rowsEquivalent` tie the apply returns without reconciling
  membership, so a concurrent membership divergence at equal metadata persists silently.
- **M4 (trigger not restored under the drift gate) — CLOSED.** One-line completeness note
  (non-issue): the trigger is created by the same migration as the columns via
  `CREATE TRIGGER IF NOT EXISTS`, so the migration is idempotent; the boot drift gate only
  re-runs init-db when `user_version < 5`, so a *manually dropped* trigger on an
  already-migrated host is not auto-restored — but the trigger is never dropped in normal
  operation.

---

## R2 review outcome

**Verdict: REVISE — 0 critical / 1 important / 3 minor. All findings closed in this
revision (below).**

- **F1 (IMPORTANT — tie-break `#n` suffix: literal-name mismerge + non-crash-idempotent
  counter) — CLOSED.** The R1 tie-break hashed `name + "#2"` for dup-slot-2, so (a) a group
  literally named "Family#2" hashed IDENTICALLY to dup-slot-2 of "Family" (sha256 of
  "family#2" both times) → silent cross-instance mismerge of two distinct groups; and
  (b) the per-run counter (seeded only from this run's NULL-uid rows) was not
  crash-idempotent — a partial run left a row whose retry recomputed an already-taken
  hash → UNIQUE violation → permanently stranded NULL. One fix closes both: assignment is
  now **COLLISION-DRIVEN** — attempt the base hash, and on a UNIQUE-constraint rejection
  bump `n` and retry with `hash(base + "\x1f" + n)` (bounded at 16, then warn + skip).
  The `\x1f` unit separator cannot survive `lower(trim(name))` of any real group name, so
  no literal-name collision is possible; and probing the DB instead of pre-counting makes
  uniqueness hold by construction regardless of partial runs. Reference impl + tie-break
  test rewritten; NEW test added: a literal "Family#2" group coexisting with two "Family"
  groups → three distinct uids, no mismerge, idempotent re-run. See Task 4.
- **F2 (MINOR — false "retried on the next mutation/backfill" recovery claim) — CLOSED.**
  Adopted the reviewer's RECOMMENDED option: `_assignDeterministicGroupUids()` now runs
  **BEFORE the `alreadyRan` flag gate** in `backfillGroupsOnce` (every boot — a cheap
  `SELECT … WHERE group_uid IS NULL`, usually 0 rows), so a NULL-uid row introduced by
  restore/import or an interrupted run self-heals on the next boot (closing the R2
  attack-(b) residual, on top of F1's retry loop removing the stranding source).
  Known-limitations wording corrected to match. Rationale for the choice is stated in the
  Task 4 decision box.
- **F3 (MINOR — absent vs empty `members`) — CLOSED.** `_reconcileGroupMembers` conflated
  `members: undefined` (metadata-only emit) with `members: []` — a winning metadata-only
  apply would have wiped every syncable member. Guard added: `wireCrowIds === undefined`
  → skip reconcile entirely; an explicit `[]` is still honored (legit empty group). Test
  added in Task 3.
- **F4 (NIT — E2E case (e) mistitled) — CLOSED.** The bold label said "Membership union
  semantics" while the body correctly describes whole-set LWW; retitled to "Membership
  whole-set LWW replace".

---

## Goal

A user running Crow on more than one machine (operator runs crow + grackle, shared
identity `crow:kdq7zskhat`) organizes contacts into **contact groups** ("Family",
"Work") on one instance — and today those groups are invisible on the other. PR-A
made *contacts + blocks* follow the user over the instance-sync mesh. This PR makes
**plain contact groups + their membership** follow the user too, closing D1's groups
clause. The bar stays "stupidly simple": create a group anywhere, it appears
everywhere, with the same members.

**Explicitly OUT of scope: multi-party rooms.** A `contact_groups` row with a
non-NULL `room_uid` **is** a Crow Messages room (hub-and-spoke, hosted on ONE
instance, with its own Nostr fan-out via `room_messages` + `room-inbound.js`). Rooms
already sync by their own mechanism and MUST NOT ride this path. Only plain
organizational groups (`room_uid IS NULL`) follow the user.

## Architecture

**The two hard problems S-GROUPS names, and how this PR solves each:**

1. **No stable portable key.** `contact_groups.id` is per-instance `AUTOINCREMENT`
   (init-db.js:1859); `room_uid` is NULL for non-rooms. → Add a new
   **`group_uid TEXT UNIQUE`** natural key: NEW rows get a random uid auto-populated by an
   `AFTER INSERT` trigger; PRE-EXISTING rows are assigned a **deterministic, frozen** uid at
   backfill (C1 — so the same logical group converges across instances instead of
   duplicating). This is the sync key, exactly as `crow_id` is for contacts and
   `nostr_event_id` for messages.

2. **Membership is two per-instance FKs.** `contact_group_members(group_id, contact_id)`
   (init-db.js:1868-1873) joins two `AUTOINCREMENT` ids, neither portable. → Membership
   travels as a **wire-map of member contact `crow_id`s** carried *on the group entry
   itself* (attached at emit by a JOIN, exactly like PR-B attaches `crow_id` to a
   message). `contact_group_members` is **NOT** added to `SYNCED_TABLES` — the join
   table never rides the wire; the group's `members: [crow_id, …]` array does. **The emit
   JOIN is filtered to SYNCABLE members only** — `origin='local-bot'` and non-established
   (pending) memberships never leave the instance (I2). On apply, each member `crow_id` is
   resolved to the **local** `contact_id`; unresolvable OR non-syncable members are skipped
   (never conjure a contact, never add a local-bot the peer named — trust boundary, mirrors
   `_applyMessage`). **Membership is whole-set LWW (I1):** on a *winning* apply the local
   membership is wholesale-replaced by the wire-map (within the syncable domain); a
   concurrent removal on the losing side is reverted — it does NOT merge per-member.
   `sort_order` rides the wire but is forward-looking — no mutation site writes it today (M1).

**Push side.** A new guarded helper module `servers/sharing/group-sync.js` (lazy-imports
`managers.js` to break the `managers → nostr → …` require cycle — identical shape to
`contact-sync.js`/`message-sync.js`) exposes `emitGroupUpsert(db, groupId)` and
`emitGroupDelete(groupUid)`. `emitGroupUpsert` re-selects the group, **skips it if it is
a room** (`room_uid != null`), attaches the full member-`crow_id` wire-map via a JOIN,
and calls `emitChange("contact_groups", "update", rowWithMembers)`. `emitChange`'s
existing `EXCLUDED_COLUMNS.contact_groups` strip drops the per-instance `id`/`created_at`;
the group's new `lamport_ts` is stamped by the existing id-path stamp at instance-sync.js:683.
These helpers are called at every **plain-group** mutation site (6 emit points across 2
files — enumerated below); every **room** mutation site is deliberately NOT instrumented.

**Pull side.** A self-contained `_applyGroup` handler — dispatched in `_applyEntry`
**before** the generic id-path (mirroring `_applyCrowContext`/`_applyContact`/`_applyMessage`)
— resolves the group by `group_uid`, applies **LWW on `lamport_ts`** to the group's
metadata (`name`/`color`; `sort_order` forward-looking, M1), and **whole-set reconciles
membership** from the wire-map (I1: on a winning apply the membership is wholesale-replaced,
not per-member merged). A wire row with NO `members` key skips the reconcile entirely —
absent ≠ empty (R2 F3); an explicit `[]` is honored. The reconcile adds
resolvable-and-**syncable**-and-missing members
(I2: the add-branch skips a resolved contact that is `local-bot`/pending, symmetric with
the remove-branch), removes **syncable** members absent from the wire-map, and never
touches local-only / local-bot / pending memberships (the peer can't know them). On a
**tie/stale** apply (`lamportTs <= localTs`) it does NOT touch membership — local wins
wholesale; a metadata-equal tie returns without reconciling, so a concurrent membership
divergence at equal metadata persists silently (M3, documented). `op:"delete"` hard-deletes
by `group_uid`, lamport-gated (the `ON DELETE CASCADE` FK reaps the join rows), with a
`sync_conflicts` row on a stale delete — identical delete discipline to `_applyContact`.

**Backfill.** A one-shot `backfillGroupsOnce()` (flag `__groups_backfill_v1`, only
`done:<n>` terminal, no-peers retryable, **drain inbound first**) re-emits pre-existing
plain groups so they resolve on peers — modeled byte-for-byte on the shipped
`backfillContactsOnce()` (instance-sync.js:522) including its I-B1 drain-first ordering
guard and its residual-window semantics. **It is also where C1's deterministic uid
assignment happens:** every boot, BEFORE the one-shot flag gate (R2 F2 — so a NULL-uid
row introduced later by restore/import or an interrupted run self-heals; the SELECT
usually returns 0 rows), it assigns a **deterministic, frozen**
`group_uid` (`sha256(<shared ed25519 pubkey>":"lower(trim(name)))[:32]`, in JS,
collision-driven `\x1f`-keyed retry for local same-name duplicates — R2 F1) to every
pre-existing plain group whose uid the migration left NULL — so the SAME logical group on
crow + grackle converges on ONE uid instead of duplicating. The manager is the correct
home for this: it already holds the **decrypted** shared identity (`this.identity.ed25519Pubkey`),
which init-db does not (it cannot decrypt a passphrase-protected seed) and could not hash
in SQL (no `sha256` SQL fn). See the C1 decision box + tie-break in Task 4.

**Tech stack:** Node ESM, `@libsql/client` (SQLite), Node built-in test runner
(`node --test`), Hypercore feeds (stubbed in tests), ed25519 sign/verify.

## Global constraints

- **Base branch:** stacks on `main` (PR-A + PR-B are merged: `c81de411` tip carries
  `EXCLUDED_COLUMNS.contacts`/`.messages`, `_applyContact`, `_applyMessage`,
  `backfillContactsOnce`, the `shouldSyncRowForTest` export, and the
  `contact-sync.js`/`message-sync.js` lazy-import emit-helper precedent). Branch:
  `feat/messages-p3-groups-follow-user`.
- **Test runner:** Node built-in — `node --test tests/<file>.test.js`. All tests live
  in `tests/*.test.js`. No third-party framework.
- **Commit discipline:** `git commit <path> -m "..."` with explicit positional paths
  (never bare `git commit`/`git add .`); the working tree carries unrelated untracked
  WIP that must not be swept. For a NEW file, `git add <thatpath>` first, then commit
  that path. Verify with `git show --stat HEAD` after each commit. Never attribute
  Claude as author/co-author.
- **Never-throw on the sync/receive path:** every new emit call, `_applyGroup`, its
  membership reconcile, and `backfillGroupsOnce` must swallow their own errors
  (`.catch(()=>{})` / `try{}catch{}`). A sync failure must never break the local write
  (the dashboard handler must still redirect; the MCP tool must still return) nor the
  apply loop.
- **Key on `group_uid`, resolve members by `crow_id`, never by `id`:**
  `contact_groups.id` and `contact_group_members.{group_id,contact_id}` are per-instance
  `AUTOINCREMENT`/local-FK — never portable. The wire carries `group_uid` +
  `members:[crow_id]`; `_applyGroup` maps them to **local** ids. A group with no
  `group_uid`, or with `room_uid != null`, is not emitted / not applied.
- **Schema change: `SCHEMA_GENERATION` 4 → 5** (argued in Task 1 / Open Question 1).
  Two migrations land together: `contact_groups.group_uid` (add nullable + UNIQUE index +
  `AFTER INSERT` random-uid trigger **for NEW rows only** — the migration deliberately does
  **NOT** randomblob-fill pre-existing rows; they stay `group_uid IS NULL` until the manager
  assigns C1's deterministic uid at backfill) and `contact_groups.lamport_ts` (needed for
  LWW — the table has no lamport column today). The boot drift gate
  (`servers/gateway/index.js:128-133`, `needsSchemaInit`) re-runs idempotent `init-db` on
  any host whose `user_version < 5`; every migration statement is `IF NOT EXISTS` /
  `addColumnIfMissing`, so a re-run is a no-op (M4).
- **Trust boundary:** inbound entries are ed25519-verified against the shared identity
  in `_applyEntry` (instance-sync.js:775) before dispatch — do not bypass it.
  `shouldSyncRow("contact_groups", …)` gates on **apply** as well as emit (defense in
  depth: reject any `room_uid`-bearing entry, and any entry lacking `group_uid`).
  `_applyGroup` never creates a contact and never turns a synced group into a room
  (`room_uid`/`host_crow_id`/`mode` are dropped from every applied write).

**Baseline:** `main` green (**1083** at PR-A/PR-B tip; `ls tests/*.test.js` = 194 files
as of this plan). Live target for the eventual E2E: crow↔grackle (shared seed
`crow:kdq7zskhat`, sync feeds confirmed live 2026-07-06). black-swan (`crow:1m5ughwje2`)
is a distinct identity — not a sync target.

---

## Verified anchors (grepped against the working tree at this plan's writing)

**Schema (scripts/init-db.js):**
- `contact_groups` CREATE — 1857-1865: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `name
  TEXT NOT NULL`, `color TEXT DEFAULT '#6366f1'`, `sort_order INTEGER DEFAULT 0`,
  `created_at`. **No `lamport_ts`, no `group_uid`.**
- `contact_group_members` CREATE — 1867-1876: `id`, `group_id INTEGER NOT NULL
  REFERENCES contact_groups(id) ON DELETE CASCADE`, `contact_id INTEGER NOT NULL
  REFERENCES contacts(id) ON DELETE CASCADE`, `created_at`; `UNIQUE(group_id, contact_id)`
  at 1875. **The `ON DELETE CASCADE` reaps join rows on group delete — no manual cleanup.**
- Room columns migration — 1882-1887: `addColumnIfMissing("contact_groups", "room_uid",
  "TEXT")` + `host_crow_id` + `mode DEFAULT 'addressed'`; partial UNIQUE index
  `idx_contact_groups_room_uid … WHERE room_uid IS NOT NULL` at 1885-1887. **← the new
  `group_uid`/`lamport_ts` migration + trigger goes immediately after this block.**
- `room_messages` CREATE — 1889-1905 (room content; own path, untouched).
- `addColumnIfMissing(table, column, definition)` — 143-154 (ALTER-ADD if the PRAGMA
  shows the column absent; wrapped, non-fatal).
- **UUID-column precedent** — `addUuidColumn` 165-178: `addColumnIfMissing(… "TEXT")`,
  then `UPDATE … SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL`, then
  `CREATE UNIQUE INDEX IF NOT EXISTS`. `group_uid` reuses the *column-shape* (SQLite
  `ALTER ADD COLUMN` cannot take a `randomblob()` default nor a column-level UNIQUE) but
  **deviates on the backfill:** `group_uid` does NOT randomblob-fill pre-existing rows
  (that would give the same logical group a different uid per instance → C1 duplication).
  Pre-existing plain-group rows are left NULL and assigned a **deterministic** uid at
  backfill time (Task 4). The `AFTER INSERT` trigger gives NEW rows a random uid.
- **init-db has no shared-identity + no `sha256` SQL fn** — `scripts/init-db.js` imports
  only schema/tenancy helpers; it never loads the identity, and SQLite exposes no `sha256`.
  `servers/sharing/identity.js:225` `loadInstanceSeed()` **throws on an encrypted seed**,
  so init-db cannot even derive the pubkey on a passphrase-protected install. This is why
  C1's deterministic uid is computed in the **manager** (Task 4), which is constructed with
  the already-decrypted identity — `InstanceSyncManager` constructor (instance-sync.js:215)
  stores `this.identity` with `.ed25519Pubkey` (hex), used at :664/:775 for sign/verify.
  Deterministic uid = `crypto.createHash("sha256").update(pubkeyHex + ":" + name).digest("hex").slice(0,32)`.
- `SCHEMA_GENERATION = 4` — `servers/shared/schema-version.js:13`; consumed by the boot
  gate `servers/gateway/index.js:115,128-133` (`needsSchemaInit`); stamped
  `PRAGMA user_version = SCHEMA_GENERATION` at init-db.js:2694.
- **No FTS shadow** on `contact_groups`/`contact_group_members` (only memories, sources,
  blog_posts, kb_articles are FTS-shadowed per CLAUDE.md) — no trigger co-maintenance
  needed.

**Sync engine (servers/sharing/instance-sync.js):**
- `SYNCED_TABLES` — 50-72 (`contacts`:53, `messages`:55; **no `contact_groups`**). ←
  add `"contact_groups"`.
- `EXCLUDED_COLUMNS` `export const` — 75-93 (`contacts`:87 = `["verified","last_seen",
  "id","created_at"]`; `messages`:92 = `["id","contact_id","is_read","lamport_ts"]`). ←
  add `contact_groups`.
- `OUTBOUND_TRANSFORMS` module-private `const` — 100-102 (only `research_notes`; **NOT
  exported** — do not import in tests). No `contact_groups` transform needed (the
  member wire-map is attached by the emit helper's JOIN, and `EXCLUDED_COLUMNS` is the
  whole strip — same lesson as PR-B's dropped I-3 transform).
- `shouldSyncRow(table,row)` — 165-189 (`contacts`:166, `messages`:177, `dashboard_settings`
  :184). ← add a `contact_groups` branch. Exported for tests as `shouldSyncRowForTest`
  at 192.
- `emitChange(table,op,row)` — 636: `feedsDisabled` gate 638, `SYNCED_TABLES` gate 639,
  `shouldSyncRow` gate 640, `_nextLamport` 642, `EXCLUDED_COLUMNS` strip 645-649,
  `OUTBOUND_TRANSFORMS` 651-652, sign 662-664, **id-path lamport stamp 683-687**
  (`UPDATE ${table} SET lamport_ts=? WHERE id=?` — works for `contact_groups` since it
  has `id`; wrapped try/catch tolerates a missing column), append 695-701.
- `_applyEntry(remoteInstanceId, entry)` — 759: `shouldSyncRow` gate 768, **sig-verify
  775-782**, `_advanceCounter` 785, `dashboard_settings` return 788-798, `crow_context`
  return 809-816, `contacts` return 823-830, `messages` return 836-843, generic conflict
  gate 847-850, generic switch 852-864. ← add a `contact_groups` dispatch after the
  `messages` block (843) and before the generic gate (847).
- `_applyContact` — 1084-1221 (the reference apply): PRAGMA-whitelist `_contactCols`
  1094-1113 + `ALWAYS_DROP` 1107; delete path lamport-gated + conflict row 1121-1136;
  insert 1139-1190; LWW update 1192-1209; `rowsEquivalent` skip / conflict-row 1211-1220;
  `_afterContactApplied` 1224-1231 (the `onContactSynced` hook — **groups need NO such
  hook**; a group is inert local data, not a subscription surface).
- `_applyMessage` — 1251-1313 (skip-on-unresolved-contact precedent, `INSERT OR IGNORE`,
  never-create-contact).
- `_checkConflict` / `_insertConflictRow` / `_notifyConflict` — 1374+ (used by the
  delete + stale paths of `_applyContact`; `_applyGroup` reuses `_insertConflictRow`
  + `_notifyConflict` the same way).
- `rowsEquivalent(a,b)` — 121-135 (per-key equivalence; ignores `lamport_ts`/`instance_id`).
- `reemitSyncableSettingsOnce` — 447-508; **`backfillContactsOnce` — 522-600** (the
  one-shot template: flag read 530-538 with only `done:` terminal; no-peers retryable
  540-544; **I-B1 drain 546-557**; syncable SELECT 559-572; emit loop 574-584; done-mark
  **UPSERT** 586-594). ← `backfillGroupsOnce` mirrors this exactly.
- `_processNewEntries(peerId, feed)` — 713 (per-peer promise-chain serialized drain).

**Emit-site wiring precedents (PR-A):**
- `servers/sharing/contact-sync.js` — full module: `emitContactChange`/`emitContactDelete`,
  lazy `sink()`, `__setEmitSinkForTest`. `group-sync.js` is its structural twin.
- `servers/sharing/message-sync.js` — `emitMessageInsert(db,{contactId,nostrEventId})`:
  re-select-and-JOIN-then-emit; the shape `emitGroupUpsert(db, groupId)` follows.
- PR-A call sites (pattern to copy — capture the natural key, then guarded emit):
  `servers/gateway/dashboard/panels/contacts/api-handlers.js:112,243,261,361,393`;
  `servers/sharing/contact-promote.js:157-158,201,213`.
- Boot wiring — `servers/gateway/boot/mcp-mounts.js`: `onContactSynced` inject 42-48,
  `eagerInitPairedPeers` 55-61, `reemitSyncableSettingsOnce` 66-72, **`backfillContactsOnce`
  78-84**. ← `backfillGroupsOnce` is wired right after 84.

**Group mutation sites (grepped `contact_groups`/`contact_group_members` writes in `servers/`):**

*Plain-group sites (INSTRUMENT — 6 emit points, 2 files):*
| # | File:line | Statement | Emit |
|---|---|---|---|
| 1 | `servers/gateway/dashboard/panels/contacts/api-handlers.js:270-273` (`create_group`) | `INSERT INTO contact_groups (name, color)` | `emitGroupUpsert(db, newId)` |
| 2 | `…/contacts/api-handlers.js:281-284` (`rename_group`) | `UPDATE contact_groups SET name=? WHERE id=?` | `emitGroupUpsert(db, id)` |
| 3 | `…/contacts/api-handlers.js:290-293` (`delete_group`) | `DELETE FROM contact_groups WHERE id=?` | `emitGroupDelete(uid)` (capture uid FIRST) |
| 4 | `…/contacts/api-handlers.js:299-302` (`add_to_group`) | `INSERT OR IGNORE INTO contact_group_members` | `emitGroupUpsert(db, group_id)` |
| 5 | `…/contacts/api-handlers.js:310-313` (`remove_from_group`) | `DELETE FROM contact_group_members …` | `emitGroupUpsert(db, group_id)` |
| 6 | `servers/sharing/tools/messaging.js:91-117` (`crow_create_message_group`) | `INSERT … contact_groups` + member loop | **one** `emitGroupUpsert(db, groupId)` AFTER the member loop |

*Room-only sites (DO NOT instrument — `room_uid` NOT NULL; own Nostr room sync). Even if
one were wired, `shouldSyncRow` drops any `room_uid != null` row both directions:*
`servers/gateway/dashboard/panels/messages/rooms-store.js:14,29,65,68,71,74,83,84`
(createRoom / ensureRoom / addRoomMember / removeRoomMember / setMode / rename /
deleteRoom); `servers/sharing/room-inbound.js:37` (inbound room member add). Add a
one-line "deliberately not synced (room)" comment at `rooms-store.js` create + at
`room-inbound.js:37`.

---

## Task 1: Schema — `group_uid` (+ backfill + UNIQUE index + auto-populate trigger) and `lamport_ts`; bump `SCHEMA_GENERATION` 4→5

**Files:**
- Modify: `scripts/init-db.js` (after the room-columns block at 1882-1887, before
  `room_messages` at 1889)
- Modify: `servers/shared/schema-version.js` (`SCHEMA_GENERATION` 4 → 5)
- Test: `tests/groups-schema.test.js` (create)

**Interfaces:**
- `contact_groups.group_uid TEXT` — stable portable key; UNIQUE-indexed. **NEW rows**:
  auto-populated with a random uid by an `AFTER INSERT` trigger (so **no INSERT call site
  needs to set it** — rooms get one too, harmless). **PRE-EXISTING rows**: the migration
  leaves them `NULL` (SQLite UNIQUE allows multiple NULLs); the manager assigns a
  **deterministic, frozen** uid at backfill (Task 4, C1). The migration does NOT
  randomblob-fill pre-existing rows — that is the C1 duplication bug.
- `contact_groups.lamport_ts INTEGER DEFAULT 0` — LWW clock, parity with `contacts.lamport_ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/groups-schema.test.js`:

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { SCHEMA_GENERATION } from "../servers/shared/schema-version.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-p3g-schema-"));
function initDb() {
  execFileSync(process.execPath, ["scripts/init-db.js"],
    { env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe" });
  return createDbClient(join(tmpDir, "crow.db"));
}
const db = initDb();
after(() => rmSync(tmpDir, { recursive: true, force: true }));

test("SCHEMA_GENERATION bumped to 5 and stamped on the db", async () => {
  assert.equal(SCHEMA_GENERATION, 5);
  const { rows } = await db.execute("PRAGMA user_version");
  assert.equal(Number(rows[0].user_version), 5);
});

test("contact_groups has group_uid + lamport_ts", async () => {
  const { rows } = await db.execute("PRAGMA table_info(contact_groups)");
  const cols = new Set(rows.map((r) => r.name));
  assert.ok(cols.has("group_uid"), "group_uid column present");
  assert.ok(cols.has("lamport_ts"), "lamport_ts column present");
});

test("a bare INSERT gets a group_uid via the auto-populate trigger", async () => {
  await db.execute({ sql: "INSERT INTO contact_groups (name) VALUES ('Family')" });
  const { rows } = await db.execute("SELECT group_uid FROM contact_groups WHERE name='Family'");
  assert.match(String(rows[0].group_uid), /^[0-9a-f]{32}$/, "trigger populated a 16-byte hex uid");
});

test("group_uid is UNIQUE-indexed", async () => {
  const uid = "d".repeat(32);
  await db.execute({ sql: "INSERT INTO contact_groups (name, group_uid) VALUES ('A', ?)", args: [uid] });
  await assert.rejects(
    db.execute({ sql: "INSERT INTO contact_groups (name, group_uid) VALUES ('B', ?)", args: [uid] }),
    /UNIQUE|constraint/i,
    "duplicate group_uid rejected",
  );
});

test("C1: re-running init-db does NOT randomblob-fill a pre-existing NULL group_uid", async () => {
  // Simulate a legacy row: force group_uid NULL past the trigger. The migration must
  // LEAVE it NULL — the deterministic uid is assigned by the manager at backfill (Task 4),
  // NOT by init-db (a random per-instance fill is the C1 split-brain bug).
  await db.execute({ sql: "INSERT INTO contact_groups (name, group_uid) VALUES ('Legacy', ?)", args: ["e".repeat(32)] });
  await db.execute("UPDATE contact_groups SET group_uid = NULL WHERE name='Legacy'");
  initDb(); // re-run migrations against the same data dir (idempotent)
  const db2 = createDbClient(join(tmpDir, "crow.db"));
  const { rows } = await db2.execute("SELECT group_uid FROM contact_groups WHERE name='Legacy'");
  assert.equal(rows[0].group_uid, null, "pre-existing NULL uid is NOT filled by init-db (deterministic assignment is the manager's job)");
});

test("the auto-populate trigger + UNIQUE index survive an init-db re-run (idempotent)", async () => {
  initDb();
  const db3 = createDbClient(join(tmpDir, "crow.db"));
  const { rows: trg } = await db3.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND name='contact_groups_group_uid_ai'");
  assert.equal(trg.length, 1, "trigger present after re-run");
  const { rows: idx } = await db3.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_contact_groups_group_uid'");
  assert.equal(idx.length, 1, "UNIQUE index present after re-run");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/groups-schema.test.js`
Expected: FAIL — `SCHEMA_GENERATION` is 4; `group_uid`/`lamport_ts` columns absent; no trigger.

- [ ] **Step 3: Implement the migration + bump the generation**

In `scripts/init-db.js`, immediately after the room-columns block (after init-db.js:1887's
`idx_contact_groups_room_uid` index, before `room_messages` at 1889), add:

```js
// --- Phase 3 groups-follow-user: stable portable key + LWW clock for plain
// contact groups (room_uid IS NULL). group_uid is the cross-instance natural key
// (contact_groups.id is per-instance AUTOINCREMENT; room_uid is NULL for non-rooms).
// SQLite ALTER ADD COLUMN cannot take a randomblob() default nor a column-level
// UNIQUE, so: add nullable → UNIQUE index → AFTER-INSERT trigger to auto-populate
// NEW rows with a random uid (rooms get one too — harmless, rooms never sync here).
//
// C1 (split-brain fix): we DELIBERATELY DO NOT randomblob-fill PRE-EXISTING rows here.
// A random per-instance uid would give the SAME logical group (e.g. "Family" created
// independently on crow AND grackle before this feature) a DIFFERENT uid on each host,
// so the one-shot backfill would cross-INSERT and permanently duplicate every shared
// legacy group. Pre-existing rows are left group_uid IS NULL (SQLite UNIQUE permits
// multiple NULLs); backfillGroupsOnce() assigns them a DETERMINISTIC, FROZEN uid derived
// from the shared identity + group name (Task 4) so both instances converge on ONE uid.
// (This deterministic hash needs the DECRYPTED shared identity + a sha256 — neither is
// available to init-db, so it lives in the manager, not here. See Task 4's decision box.)
//
// lamport_ts gives groups the same last-write-wins clock contacts already have.
// SCHEMA_GENERATION 4 -> 5.
await addColumnIfMissing("contact_groups", "group_uid", "TEXT");
await addColumnIfMissing("contact_groups", "lamport_ts", "INTEGER DEFAULT 0");
await db.execute(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_groups_group_uid ON contact_groups(group_uid)"
);
await db.execute(`
  CREATE TRIGGER IF NOT EXISTS contact_groups_group_uid_ai
  AFTER INSERT ON contact_groups
  WHEN NEW.group_uid IS NULL
  BEGIN
    UPDATE contact_groups SET group_uid = lower(hex(randomblob(16))) WHERE id = NEW.id;
  END
`);
```

In `servers/shared/schema-version.js`, bump the constant:

```js
export const SCHEMA_GENERATION = 5;
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/groups-schema.test.js`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add tests/groups-schema.test.js
git commit scripts/init-db.js servers/shared/schema-version.js tests/groups-schema.test.js -m "feat(sharing): Phase 3 groups — add contact_groups.group_uid + lamport_ts + auto-populate trigger (SCHEMA_GENERATION 4->5)"
git show --stat HEAD | head
```

---

## Task 2: `group-sync.js` emit helper + `SYNCED_TABLES`/`EXCLUDED_COLUMNS`/`shouldSyncRow` + wire all 6 plain-group emit sites (room carve-out)

**Files:**
- Create: `servers/sharing/group-sync.js`
- Modify: `servers/sharing/instance-sync.js` (`SYNCED_TABLES` :72 → add `"contact_groups"`;
  `EXCLUDED_COLUMNS` :93 → add `contact_groups`; `shouldSyncRow` :165 → add a
  `contact_groups` branch)
- Modify: `servers/gateway/dashboard/panels/contacts/api-handlers.js` (emit at the 5
  group actions :266-317; capture `group_uid` before the delete)
- Modify: `servers/sharing/tools/messaging.js` (emit once after the member loop in
  `crow_create_message_group` :117)
- Modify: `servers/gateway/dashboard/panels/messages/rooms-store.js` +
  `servers/sharing/room-inbound.js` (one-line "not synced (room)" comments — NO emit)
- Test: `tests/groups-sync-emit.test.js` (create)

**Interfaces:**
- `emitGroupUpsert(db, groupId)` — re-selects the group; **no-op if it is a room
  (`room_uid != null`) or lacks a `group_uid`**; attaches `members: [crow_id,…]` via a
  JOIN over `contact_group_members` → `contacts.crow_id`, **filtered to SYNCABLE members
  only** — `c.origin != 'local-bot'` AND (`c.request_status IS NULL OR c.request_status =
  'accepted'`) — so a local-bot / pending membership never leaks its `crow_id` onto the
  wire (I2); forwards the FULL local row (with `id` retained so emitChange's :683 lamport
  stamp fires) as `emitChange("contact_groups", "update", row)`. Guarded (never throws).
  `__setEmitSinkForTest`.
- `emitGroupDelete(groupUid)` — `emitChange("contact_groups", "delete", { group_uid })`.
  Guarded. (Delete sites MUST capture the `group_uid` before the `DELETE` — the row is
  gone after.)
- `shouldSyncRow("contact_groups", row)` returns `false` unless `row.room_uid` is
  null/absent AND `row.group_uid` is truthy (drops rooms + keyless rows both directions).
- `EXCLUDED_COLUMNS.contact_groups = ["id", "created_at"]` — the sole wire strip
  (`id` per-instance; `created_at` differs per-instance → spurious conflicts). `room_uid`/
  `host_crow_id`/`mode` are **left on the wire** (value NULL for a plain group) so the
  apply-side `shouldSyncRow` can still *inspect* and reject a malicious `room_uid`-bearing
  entry; `lamport_ts` rides the row and is dropped on apply (mirrors contacts).

- [ ] **Step 1: Write the failing test**

Create `tests/groups-sync-emit.test.js`:

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import {
  emitGroupUpsert,
  emitGroupDelete,
  __setEmitSinkForTest,
} from "../servers/sharing/group-sync.js";
import {
  shouldSyncRowForTest,
  EXCLUDED_COLUMNS,
  SYNCED_TABLES,
} from "../servers/sharing/instance-sync.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-p3g-emit-"));
execFileSync(process.execPath, ["scripts/init-db.js"],
  { env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe" });
const db = createDbClient(join(tmpDir, "crow.db"));
after(() => rmSync(tmpDir, { recursive: true, force: true }));
const SECP = "a".repeat(64);

test("contact_groups is a synced table", () => {
  assert.ok(SYNCED_TABLES.includes("contact_groups"));
});

test("EXCLUDED_COLUMNS.contact_groups strips only id + created_at", () => {
  assert.deepEqual([...EXCLUDED_COLUMNS.contact_groups].sort(), ["created_at", "id"]);
});

test("shouldSyncRow: plain group with group_uid syncs; rooms + keyless drop", () => {
  const ok = (r) => shouldSyncRowForTest("contact_groups", r);
  assert.equal(ok({ group_uid: "g1", name: "Family" }), true);
  assert.equal(ok({ group_uid: "g1", room_uid: "r1", name: "Room" }), false, "room drops");
  assert.equal(ok({ name: "no uid" }), false, "keyless drops");
  assert.equal(ok({ group_uid: "g2" }), true, "delete-shaped {group_uid} passes (room_uid absent)");
  assert.equal(ok(null), false);
});

test("emitGroupUpsert: attaches ONLY syncable members (I2: local-bot + pending excluded) and forwards to the sink", async () => {
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (1,'crow:m1','', ?)", args: [SECP] });
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (2,'crow:m2','', ?)", args: [SECP] });
  // A local-bot member and a pending member must NOT ride the wire (I2).
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, origin) VALUES (3,'crow:bot','', ?, 'local-bot')", args: [SECP] });
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, request_status) VALUES (4,'crow:pending','', ?, 'pending')", args: [SECP] });
  await db.execute({ sql: "INSERT INTO contact_groups (id, name, group_uid) VALUES (10,'Family','g10')" });
  await db.execute({ sql: "INSERT INTO contact_group_members (group_id, contact_id) VALUES (10,1),(10,2),(10,3),(10,4)" });
  const seen = [];
  __setEmitSinkForTest({ emitChange: async (t, op, row) => seen.push([t, op, row.group_uid, [...(row.members || [])].sort(), row.id]) });
  await emitGroupUpsert(db, 10);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], ["contact_groups", "update", "g10", ["crow:m1", "crow:m2"], 10], "local-bot + pending members excluded from the wire-map");
  __setEmitSinkForTest(null);
});

test("emitGroupUpsert: a ROOM group is never emitted", async () => {
  await db.execute({ sql: "INSERT INTO contact_groups (id, name, group_uid, room_uid) VALUES (11,'Room','g11','room-uid-1')" });
  const seen = [];
  __setEmitSinkForTest({ emitChange: async (...a) => seen.push(a) });
  await emitGroupUpsert(db, 11);
  assert.equal(seen.length, 0, "room_uid != null → helper skips");
  __setEmitSinkForTest(null);
});

test("emitGroupDelete + missing-row + null-sink are all no-throw", async () => {
  const seen = [];
  __setEmitSinkForTest({ emitChange: async (t, op, row) => seen.push([t, op, row.group_uid]) });
  await emitGroupDelete("g10");
  assert.deepEqual(seen[0], ["contact_groups", "delete", "g10"]);
  __setEmitSinkForTest(null);
  await emitGroupUpsert(db, 9999); // no such group → no throw
  await emitGroupDelete("");       // empty uid → no-op, no throw
  await emitGroupUpsert(db, 10);   // null sink → no throw
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/groups-sync-emit.test.js`
Expected: FAIL — `group-sync.js` does not exist; `contact_groups` not in `SYNCED_TABLES`/
`EXCLUDED_COLUMNS`; `shouldSyncRow` has no `contact_groups` branch.

- [ ] **Step 3: Write the helper + extend the three maps + wire the emit sites**

Create `servers/sharing/group-sync.js`:

```js
/**
 * Phase 3 (groups follow the user): push PLAIN contact-group mutations onto the
 * instance-sync mesh so a user's organizational groups + membership appear on
 * every paired instance.
 *
 * Guarded + null-safe — a sync failure never breaks the local write, and the
 * sink is null pre-boot / in unit tests (no-op). Groups are keyed on the stable
 * group_uid; membership travels as a wire-map of member contact crow_ids attached
 * here via a JOIN (the per-instance group_id/contact_id are never portable).
 *
 * ROOMS ARE EXCLUDED: a contact_groups row with a non-NULL room_uid IS a
 * multi-party Crow Messages room with its OWN Nostr fan-out (room_messages /
 * room-inbound.js). emitGroupUpsert no-ops on such rows; shouldSyncRow drops them
 * again both directions (defense in depth).
 *
 * managers.js → nostr.js → group-sync.js would form a require cycle under a
 * static import; the cached lazy dynamic import keeps the graph acyclic — identical
 * to contact-sync.js / message-sync.js. Do NOT "simplify" to a static import.
 */
let _mgrMod = null;
let _testSink = null;
export function __setEmitSinkForTest(sink) { _testSink = sink; }

async function sink() {
  if (_testSink) return _testSink;
  if (!_mgrMod) { try { _mgrMod = await import("./managers.js"); } catch { return null; } }
  return _mgrMod.getInstanceSyncManager?.() || null;
}

/**
 * Emit an upsert for a plain group: re-select it, skip if it is a room or lacks a
 * group_uid, attach the full member-crow_id wire-map, forward the FULL local row
 * (id retained for emitChange's lamport stamp). Never throws.
 */
export async function emitGroupUpsert(db, groupId) {
  try {
    if (!db || !groupId) return;
    const { rows } = await db.execute({
      sql: "SELECT * FROM contact_groups WHERE id = ? LIMIT 1",
      args: [groupId],
    });
    const row = rows[0];
    if (!row || row.room_uid != null || !row.group_uid) return; // room / keyless → skip
    // I2: attach ONLY syncable members — exclude local-bot origin and pending
    // (unestablished) memberships, which the peer must never learn about.
    const { rows: mem } = await db.execute({
      sql: `SELECT c.crow_id AS crow_id
              FROM contact_group_members gm JOIN contacts c ON c.id = gm.contact_id
             WHERE gm.group_id = ?
               AND c.crow_id IS NOT NULL
               AND (c.origin IS NULL OR c.origin != 'local-bot')
               AND (c.request_status IS NULL OR c.request_status = 'accepted')`,
      args: [groupId],
    });
    row.members = mem.map((r) => r.crow_id).filter(Boolean);
    await (await sink())?.emitChange("contact_groups", "update", row);
  } catch { /* never throw — group sync is best-effort */ }
}

/** Emit a group delete by its stable group_uid. Capture the uid BEFORE the local DELETE. */
export async function emitGroupDelete(groupUid) {
  if (!groupUid) return;
  try { await (await sink())?.emitChange("contact_groups", "delete", { group_uid: groupUid }); }
  catch { /* never throw */ }
}
```

In `servers/sharing/instance-sync.js`:

`SYNCED_TABLES` (add `"contact_groups"` — plain groups only; the room carve-out is
enforced by `shouldSyncRow`, not table membership):

```js
  "glasses_note_sessions",
  // Phase 3 (groups follow the user): PLAIN contact groups (room_uid IS NULL)
  // sync so a user's organizational groups + membership follow them across
  // instances. Multi-party ROOMS (room_uid NOT NULL) are gated OUT by
  // shouldSyncRow — they have their own Nostr fan-out.
  "contact_groups",
];
```

`EXCLUDED_COLUMNS` (add the key next to `messages`):

```js
  // Phase 3 groups: group_uid is the stable wire key; id is per-instance
  // AUTOINCREMENT (never portable); created_at differs when two instances form
  // the same group independently (spurious conflicts). room_uid/host_crow_id/mode
  // are LEFT on the wire (NULL for a plain group) so the apply-side shouldSyncRow
  // can still reject a malicious room-bearing entry; lamport_ts rides the row and
  // is dropped on apply. Membership rides the attached `members` wire-map.
  contact_groups: ["id", "created_at"],
```

`shouldSyncRow` (add before the `dashboard_settings` check):

```js
  if (table === "contact_groups") {
    if (!row) return false;
    // Rooms (room_uid NOT NULL) sync via their own Nostr fan-out — never here.
    // `!= null` catches both null and undefined (a delete row omits room_uid).
    if (row.room_uid != null) return false;
    return Boolean(row.group_uid);
  }
```

Wire the emit sites. In `servers/gateway/dashboard/panels/contacts/api-handlers.js`,
import at top (next to the existing `emitContactChange` import):

```js
import { emitGroupUpsert, emitGroupDelete } from "../../../../sharing/group-sync.js";
```

- `create_group` (:270-273) — capture the new id, then emit. **M2 — the emit MUST stay
  INSIDE the existing `if (name)` guard**, right after the INSERT: `gRes` is only assigned
  inside that block, so an emit hoisted outside it would read a stale/undefined
  `lastInsertRowid` (emitting the wrong group, or a phantom on an empty-name no-op).
  Reviewer: confirm both the INSERT and its `emitGroupUpsert` sit within `if (name) { … }`.

```js
    if (name) {
      const gRes = await db.execute({
        sql: "INSERT INTO contact_groups (name, color) VALUES (?, ?)",
        args: [name, color],
      });
      // M2: keep this emit INSIDE if(name) — gRes.lastInsertRowid is only valid here.
      try { await emitGroupUpsert(db, Number(gRes.lastInsertRowid)); } catch {}
    }
```

- `rename_group` (:281-284) — after the UPDATE:

```js
      try { await emitGroupUpsert(db, parseInt(req.body.group_id)); } catch {}
```

- `delete_group` (:289-295) — capture `group_uid` BEFORE the DELETE, emit AFTER:

```js
  if (action === "delete_group" && req.body.group_id) {
    const gid = parseInt(req.body.group_id);
    let gUid = null;
    try { const { rows } = await db.execute({ sql: "SELECT group_uid FROM contact_groups WHERE id = ?", args: [gid] }); gUid = rows[0]?.group_uid || null; } catch {}
    await db.execute({ sql: "DELETE FROM contact_groups WHERE id = ?", args: [gid] });
    if (gUid) { try { await emitGroupDelete(gUid); } catch {} }
    return { redirect: "/dashboard/contacts?view=groups" };
  }
```

- `add_to_group` (:299-302) and `remove_from_group` (:310-313) — after each member
  mutation, re-emit the group (full-replace membership wire-map):

```js
      try { await emitGroupUpsert(db, parseInt(req.body.group_id)); } catch {}
```

In `servers/sharing/tools/messaging.js`, import `emitGroupUpsert` and emit ONCE after
the member loop in `crow_create_message_group` (after :117, before building the result
`text`):

```js
      try { await emitGroupUpsert(db, groupId); } catch {}
```

In `servers/gateway/dashboard/panels/messages/rooms-store.js` (at `createRoom`/`ensureRoom`)
and `servers/sharing/room-inbound.js:37`, add a one-line comment (NO emit):

```js
      // NOTE: rooms (room_uid NOT NULL) are NOT synced via group-sync — they have
      // their own hub-and-spoke Nostr fan-out (room_messages / room-inbound.js).
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/groups-sync-emit.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add servers/sharing/group-sync.js tests/groups-sync-emit.test.js
git commit servers/sharing/group-sync.js tests/groups-sync-emit.test.js servers/sharing/instance-sync.js servers/gateway/dashboard/panels/contacts/api-handlers.js servers/sharing/tools/messaging.js servers/gateway/dashboard/panels/messages/rooms-store.js servers/sharing/room-inbound.js -m "feat(sharing): Phase 3 groups emit helper + wire maps + emit at all plain-group mutation sites (room carve-out)"
git show --stat HEAD | head
```

---

## Task 3: `_applyGroup` inbound handler (group_uid-keyed LWW + membership reconcile + delete) + dispatch

**Files:**
- Modify: `servers/sharing/instance-sync.js` (add a `contact_groups` dispatch in
  `_applyEntry` after the `messages` block (:843) and before the generic conflict gate
  (:847); add `_applyGroup` + `_reconcileGroupMembers` after `_applyContact`/`_applyMessage`)
- Test: `tests/groups-sync.test.js` (create)

**Interfaces:**
- `async _applyGroup(op, row, lamportTs, instanceId)`:
  - keyed on `group_uid`; PRAGMA-whitelists group columns (mirrors `_contactCols`), with
    `ALWAYS_DROP = {id, lamport_ts, instance_id, created_at, room_uid, host_crow_id, mode, members}`
    — so a synced group can NEVER be written as a room and NEVER conjure the `members`
    pseudo-column.
  - `op:"delete"`: `!localRow` → return; `lamportTs > localTs` → `DELETE FROM
    contact_groups WHERE group_uid=?` (cascade reaps membership); else `_insertConflictRow`
    + `_notifyConflict` (local kept). Identical to `_applyContact` delete.
  - insert/update (LWW): `!localRow` → INSERT metadata (`name/color/sort_order`,
    `group_uid`, `lamport_ts`); `lamportTs > localTs` → UPDATE metadata; on either
    apply, call `_reconcileGroupMembers(localGroupId, row.members)`. Stale/tie
    (`lamportTs <= localTs`): `rowsEquivalent` → silent; else `_insertConflictRow` +
    `_notifyConflict` and **do not touch membership** (local wins wholesale).
- `async _reconcileGroupMembers(groupId, wireCrowIds)` — **whole-set replace (I1)** over
  the **shared, syncable contact domain only** — a *winning* apply overwrites the entire
  local membership with the wire-map (a concurrent removal on the losing side is reverted;
  it is NOT a per-member merge):
  - **Absent ≠ empty (R2 F3):** `wireCrowIds === undefined` (the wire row carries no
    `members` key — a metadata-only emit) → **skip the reconcile entirely** (return);
    an explicit `[]` is still honored (legit empty group). Without this guard a winning
    metadata-only apply would wipe every syncable member.
  - `wireSet = new Set((wireCrowIds || []).filter(Boolean))`.
  - **Add (I2 — bounded, symmetric with Remove):** for each `crow_id` in `wireSet`,
    resolve `SELECT id, origin, request_status FROM contacts WHERE crow_id=?`; add it
    **only if** it resolves AND is *syncable* (`origin != 'local-bot'` AND `request_status
    ∈ {NULL,'accepted'}`), via `INSERT OR IGNORE INTO contact_group_members`. **Never
    create a contact** — an unresolved member is skipped (mirrors `_applyMessage`); a
    resolved-but-non-syncable member (e.g. a peer naming your local-bot's crow_id) is also
    skipped, so a malicious wire-map cannot pull a local-bot into a synced group.
  - **Remove:** for each current local member, resolve its contact's `crow_id` + `origin`
    + `request_status`; remove it **only if** it is a *syncable* contact
    (`origin != 'local-bot'` AND `request_status ∈ {NULL,'accepted'}`) AND its `crow_id`
    is absent from `wireSet`. **Local-only / local-bot / pending members are never
    removed by sync** — the emitting peer can't know about them, so a whole-set replace must
    not wipe them (this is the load-bearing correctness rule; see Open Question 3).

- [ ] **Step 1: Write the failing tests**

Create `tests/groups-sync.test.js` (reuse the instance-sync harness: real init-db tmpdir,
`sign()` to forge signed entries):

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { sign } from "../servers/sharing/identity.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-p3g-apply-"));
execFileSync(process.execPath, ["scripts/init-db.js"],
  { env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe" });
const DB_PATH = join(tmpDir, "crow.db");
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const TEST_PRIV = Buffer.alloc(32, 0xAB);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };
const REMOTE_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const SECP = "a".repeat(64);

function mgr(id = "aaaaaaaa-0000-0000-0000-000000000001") {
  return new InstanceSyncManager(IDENTITY, createDbClient(DB_PATH), id);
}
function signedEntry(table, op, row, lamport_ts, instance_id = REMOTE_ID) {
  const e = { table, op, row, lamport_ts, instance_id };
  e.signature = sign(JSON.stringify(e), IDENTITY.ed25519Priv);
  return e;
}
async function seedContact(db, id, crowId, extra = "") {
  await db.execute({ sql: `INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey${extra ? ", " + extra.split("=")[0] : ""}) VALUES (?, ?, '', ?${extra ? ", " + extra.split("=")[1] : ""})`, args: [id, crowId, SECP] });
}
async function members(db, gUid) {
  const { rows } = await db.execute({
    sql: `SELECT c.crow_id FROM contact_group_members gm
            JOIN contacts c ON c.id = gm.contact_id
            JOIN contact_groups g ON g.id = gm.group_id
           WHERE g.group_uid = ? ORDER BY c.crow_id`, args: [gUid],
  });
  return rows.map((r) => r.crow_id);
}

test("_applyGroup: inserts a plain group keyed on group_uid + resolves members to LOCAL ids", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (50,'crow:a','', ?),(51,'crow:b','', ?)", args: [SECP, SECP] });
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update",
    { id: 999, group_uid: "gg1", name: "Family", color: "#f00", members: ["crow:a", "crow:b"] }, 10));
  const { rows } = await db.execute({ sql: "SELECT id, name, color FROM contact_groups WHERE group_uid='gg1'" });
  assert.equal(rows.length, 1);
  assert.notEqual(Number(rows[0].id), 999, "stored under a LOCAL id, not the wire 999");
  assert.equal(rows[0].name, "Family");
  assert.deepEqual(await members(db, "gg1"), ["crow:a", "crow:b"]);
});

test("_applyGroup: a ROOM entry (room_uid set) is rejected by shouldSyncRow", async () => {
  const m = mgr(); const db = m.db;
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update",
    { group_uid: "gg-room", room_uid: "R1", name: "Should not land", members: [] }, 11));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contact_groups WHERE group_uid='gg-room'" })).rows[0].c, 0);
});

test("_applyGroup: an unresolvable member is skipped (never creates a contact)", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (52,'crow:known','', ?)", args: [SECP] });
  const before = (await db.execute("SELECT COUNT(*) c FROM contacts")).rows[0].c;
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update",
    { group_uid: "gg2", name: "Mix", members: ["crow:known", "crow:ghost"] }, 12));
  assert.deepEqual(await members(db, "gg2"), ["crow:known"], "only the resolvable member joined");
  assert.equal((await db.execute("SELECT COUNT(*) c FROM contacts")).rows[0].c, before, "no phantom contact");
});

test("_applyGroup: LWW — a newer entry updates name + reconciles membership; a stale entry is skipped", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (60,'crow:x','', ?),(61,'crow:y','', ?)", args: [SECP, SECP] });
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg3", name: "V1", members: ["crow:x"] }, 5));
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg3", name: "V2", members: ["crow:x", "crow:y"] }, 9));
  assert.equal((await db.execute({ sql: "SELECT name FROM contact_groups WHERE group_uid='gg3'" })).rows[0].name, "V2");
  assert.deepEqual(await members(db, "gg3"), ["crow:x", "crow:y"]);
  // Stale replay (lower lamport) must not revert.
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg3", name: "STALE", members: ["crow:x"] }, 3));
  assert.equal((await db.execute({ sql: "SELECT name FROM contact_groups WHERE group_uid='gg3'" })).rows[0].name, "V2", "stale entry ignored");
  assert.deepEqual(await members(db, "gg3"), ["crow:x", "crow:y"], "stale membership ignored");
});

test("_applyGroup: reconcile REMOVES a syncable member absent from the wire-map", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (70,'crow:p','', ?),(71,'crow:q','', ?)", args: [SECP, SECP] });
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg4", name: "G", members: ["crow:p", "crow:q"] }, 5));
  assert.deepEqual(await members(db, "gg4"), ["crow:p", "crow:q"]);
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg4", name: "G", members: ["crow:p"] }, 9));
  assert.deepEqual(await members(db, "gg4"), ["crow:p"], "crow:q removed by full-replace");
});

test("_applyGroup: reconcile does NOT remove a LOCAL-BOT member the peer can't know about", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (80,'crow:human','', ?)", args: [SECP] });
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, origin) VALUES (81,'crow:localbot','', ?, 'local-bot')", args: [SECP] });
  // Group exists locally with a human + a local-bot member.
  await db.execute({ sql: "INSERT INTO contact_groups (id, name, group_uid, lamport_ts) VALUES (200,'G','gg5',5)" });
  await db.execute({ sql: "INSERT INTO contact_group_members (group_id, contact_id) VALUES (200,80),(200,81)" });
  // A peer that only knows the human re-emits {crow:human}.
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg5", name: "G", members: ["crow:human"] }, 9));
  assert.deepEqual(await members(db, "gg5"), ["crow:human", "crow:localbot"], "local-bot membership preserved (not wiped by peer full-replace)");
});

test("_applyGroup: I2 — a wire-map naming a LOCAL-BOT contact does NOT add it (add-branch bounded to syncable)", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (85,'crow:h2','', ?)", args: [SECP] });
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, origin) VALUES (86,'crow:bot2','', ?, 'local-bot')", args: [SECP] });
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, request_status) VALUES (87,'crow:pend','', ?, 'pending')", args: [SECP] });
  // Peer's wire-map names a human, a local-bot, and a pending contact — only the human joins.
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update",
    { group_uid: "gg5b", name: "G", members: ["crow:h2", "crow:bot2", "crow:pend"] }, 5));
  assert.deepEqual(await members(db, "gg5b"), ["crow:h2"], "resolved-but-non-syncable members (local-bot, pending) skipped on add");
});

test("_applyGroup: delete is lamport-gated + cascades membership; stale delete logs a conflict and keeps local", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (90,'crow:z','', ?)", args: [SECP] });
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg6", name: "Doomed", members: ["crow:z"] }, 5));
  // Stale delete (lower lamport) → kept.
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "delete", { group_uid: "gg6" }, 3));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contact_groups WHERE group_uid='gg6'" })).rows[0].c, 1, "stale delete ignored");
  // Newer delete → removed + membership cascade-reaped.
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "delete", { group_uid: "gg6" }, 9));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contact_groups WHERE group_uid='gg6'" })).rows[0].c, 0);
  assert.deepEqual(await members(db, "gg6"), [], "membership cascade-reaped on delete");
});

test("_applyGroup: a forged wire id/room_uid cannot hijack — id ignored, room dropped, never throws", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contact_groups (id, name, group_uid) VALUES (300,'Existing','gg7')" });
  // Attacker copies an existing local id + tries to inject room_uid.
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update",
    { id: 300, group_uid: "gg-new", room_uid: "HIJACK", name: "evil", members: [] }, 20));
  // room_uid present → shouldSyncRow drops the whole entry (nothing lands).
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contact_groups WHERE group_uid='gg-new'" })).rows[0].c, 0);
  assert.equal((await db.execute({ sql: "SELECT name FROM contact_groups WHERE id=300" })).rows[0].name, "Existing", "existing row untouched (wire id ignored)");
});

test("_applyGroup: members ABSENT (no key) skips reconcile — a metadata-only emit cannot wipe members; explicit [] still empties (R2 F3)", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (95,'crow:keep','', ?)", args: [SECP] });
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg8", name: "G", members: ["crow:keep"] }, 5));
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg8", name: "G2" }, 9)); // no members key
  assert.equal((await db.execute({ sql: "SELECT name FROM contact_groups WHERE group_uid='gg8'" })).rows[0].name, "G2", "metadata applied");
  assert.deepEqual(await members(db, "gg8"), ["crow:keep"], "absent members key → membership untouched");
  await m._applyEntry(REMOTE_ID, signedEntry("contact_groups", "update", { group_uid: "gg8", name: "G3", members: [] }, 12));
  assert.deepEqual(await members(db, "gg8"), [], "explicit [] honored — legit empty group");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/groups-sync.test.js`
Expected: FAIL — `contact_groups` entries fall through to the generic id-path
(`_applyInsert`/`_applyUpdate` would copy the wire `id` / mis-key), and no
`group_uid`-resolution or membership reconcile happens.

- [ ] **Step 3: Write the dispatch + `_applyGroup` + `_reconcileGroupMembers`**

In `_applyEntry`, add a dispatch block after the `messages` block (:843) and before the
generic conflict gate (:847):

```js
    // contact_groups (plain groups only — rooms gated by shouldSyncRow) are keyed
    // on the stable group_uid; the per-instance AUTOINCREMENT id + join-table FKs
    // are NOT portable. Route ALL ops through the natural-key handler, mirroring
    // _applyContact. shouldSyncRow already dropped room_uid/keyless rows at :768.
    if (table === "contact_groups") {
      try {
        await this._applyGroup(op, row, lamport_ts, instance_id);
      } catch (err) {
        console.warn(`[instance-sync] Failed to apply ${op} on contact_groups:`, err.message);
      }
      return;
    }
```

Add `_applyGroup` + `_reconcileGroupMembers` after `_applyContact` (mirror its structure —
PRAGMA whitelist, delete gate, LWW):

```js
  /**
   * Apply a PLAIN contact-group mutation keyed on the stable group_uid (Phase 3
   * groups-follow-user). Rooms (room_uid NOT NULL) are dropped upstream by
   * shouldSyncRow. Group metadata (name/color; sort_order forward-looking, M1) is
   * LWW by lamport_ts, exactly like _applyContact; membership is WHOLE-SET replaced
   * (I1) from the wire-map of member crow_ids on a winning apply — a concurrent
   * removal on the losing side is reverted, not merged — but ONLY when the wire row
   * carries a `members` key (absent != empty, R2 F3: a metadata-only emit skips the
   * reconcile; an explicit [] replaces). Members are resolved to LOCAL
   * contact ids, bounded to the syncable domain (unresolvable OR local-bot/pending
   * members skipped — never conjure a contact, never add a local-bot the peer named).
   * A synced group can never become a room: room_uid/host_crow_id/mode are dropped
   * from every applied write.
   */
  async _applyGroup(op, row, lamportTs, instanceId) {
    const groupUid = row && row.group_uid;
    if (!groupUid) {
      console.warn("[instance-sync] _applyGroup: missing group_uid — skipping");
      return;
    }

    if (!this._groupCols) {
      try {
        const { rows: pragma } = await this.db.execute({ sql: "PRAGMA table_info(contact_groups)", args: [] });
        this._groupCols = new Set(pragma.map((r) => r.name));
      } catch { this._groupCols = null; }
    }
    if (!this._groupCols) {
      console.warn("[instance-sync] _applyGroup: contact_groups columns unavailable — skipping");
      return;
    }
    // Never write id/lamport/created_at, never turn a synced group into a room,
    // never treat the `members` pseudo-column as a real column.
    const ALWAYS_DROP = new Set(["id", "lamport_ts", "instance_id", "created_at", "room_uid", "host_crow_id", "mode", "members"]);
    const filtered = {};
    for (const [k, v] of Object.entries(row)) {
      if (ALWAYS_DROP.has(k)) continue;
      if (!this._groupCols.has(k)) continue;
      filtered[k] = v;
    }

    const { rows: localRows } = await this.db.execute({ sql: "SELECT * FROM contact_groups WHERE group_uid = ?", args: [groupUid] });
    const localRow = localRows[0] ?? null;
    const localTs = localRow?.lamport_ts || 0;
    const rowIdJson = JSON.stringify({ group_uid: groupUid });

    // ── delete ──────────────────────────────────────────────────────────────
    if (op === "delete") {
      if (!localRow) return;
      if (lamportTs > localTs) {
        // ON DELETE CASCADE reaps contact_group_members.
        await this.db.execute({ sql: "DELETE FROM contact_groups WHERE group_uid = ?", args: [groupUid] });
        return;
      }
      try {
        await this._insertConflictRow("contact_groups", rowIdJson,
          localRow.instance_id || this.localInstanceId, instanceId, localTs, lamportTs,
          JSON.stringify(localRow), JSON.stringify(filtered), "delete");
        await this._notifyConflict();
      } catch (err) {
        console.warn("[instance-sync] contact_groups delete conflict LOGGING failed (local kept):", err.message);
      }
      return;
    }

    // ── insert / update (LWW) ───────────────────────────────────────────────
    if (!localRow) {
      const cols = Object.keys(filtered).filter((k) => filtered[k] !== undefined);
      if (!cols.includes("group_uid")) cols.push("group_uid");
      const insertCols = [...new Set(cols)];
      const placeholders = insertCols.map(() => "?").join(", ");
      const values = insertCols.map((k) => (k === "group_uid" ? groupUid : filtered[k] ?? null));
      await this.db.execute({
        sql: `INSERT INTO contact_groups (${insertCols.join(", ")}, lamport_ts) VALUES (${placeholders}, ?)`,
        args: [...values, lamportTs],
      });
      const gid = await this._groupIdByUid(groupUid);
      await this._reconcileGroupMembers(gid, row.members);
      return;
    }

    if (lamportTs > localTs) {
      const updateKeys = Object.keys(filtered).filter((k) => k !== "group_uid");
      const setClauses = updateKeys.map((k) => `${k} = ?`);
      const vals = updateKeys.map((k) => filtered[k] ?? null);
      setClauses.push("lamport_ts = ?"); vals.push(lamportTs);
      await this.db.execute({ sql: `UPDATE contact_groups SET ${setClauses.join(", ")} WHERE group_uid = ?`, args: [...vals, groupUid] });
      await this._reconcileGroupMembers(localRow.id, row.members);
      return;
    }

    // incomingTs <= localTs — local wins wholesale (metadata AND membership).
    // M3: on a metadata-equal tie we return WITHOUT reconciling membership, so a
    // concurrent membership divergence at equal metadata persists silently (documented
    // in Known limitations — acceptable for a single user's low-contention groups).
    if (rowsEquivalent(localRow, filtered)) return; // re-delivery noise
    try {
      await this._insertConflictRow("contact_groups", rowIdJson,
        localRow.instance_id || this.localInstanceId, instanceId, localTs, lamportTs,
        JSON.stringify(localRow), JSON.stringify(filtered), op || "update");
      await this._notifyConflict();
    } catch (err) {
      console.warn("[instance-sync] contact_groups conflict LOGGING failed (local kept):", err.message);
    }
  }

  async _groupIdByUid(groupUid) {
    const { rows } = await this.db.execute({ sql: "SELECT id FROM contact_groups WHERE group_uid = ? LIMIT 1", args: [groupUid] });
    return rows[0]?.id ?? null;
  }

  /**
   * Whole-set replace (I1) of group membership from a wire-map of member crow_ids,
   * bounded to the SHARED, SYNCABLE contact domain. Absent != empty (R2 F3): a wire
   * row WITHOUT a members key (metadata-only emit) skips the reconcile entirely —
   * only an EXPLICIT array (including []) replaces. A winning apply overwrites the
   * entire local membership: adds resolvable-and-SYNCABLE-and-missing members (never
   * creates a contact, never adds a local-bot/pending contact the peer named — I2);
   * removes only SYNCABLE members (origin != local-bot, established) whose crow_id is
   * absent from the wire-map. Local-only / local-bot / pending memberships are NEVER
   * touched — the emitting peer can't know about them, so a whole-set replace must not
   * wipe them (and a concurrent removal on the LOSING side IS reverted — I1).
   */
  async _reconcileGroupMembers(groupId, wireCrowIds) {
    if (groupId == null) return;
    // R2 F3: members ABSENT (undefined) is a metadata-only emit, NOT an empty group —
    // treating it as [] would wipe every syncable member. Skip; explicit [] still honored.
    if (wireCrowIds === undefined) return;
    const wireSet = new Set((Array.isArray(wireCrowIds) ? wireCrowIds : []).filter(Boolean));

    // Add: resolvable + SYNCABLE + missing (I2 — symmetric with the remove branch).
    for (const crowId of wireSet) {
      try {
        const { rows } = await this.db.execute({ sql: "SELECT id, origin, request_status FROM contacts WHERE crow_id = ? LIMIT 1", args: [crowId] });
        const c = rows[0];
        if (c == null || c.id == null) continue; // unresolved — never create a contact
        const syncable = c.origin !== "local-bot" &&
          (c.request_status == null || c.request_status === "accepted");
        if (!syncable) continue; // peer cannot pull a local-bot/pending contact into a synced group
        await this.db.execute({ sql: "INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?, ?)", args: [groupId, c.id] });
      } catch (err) {
        console.warn(`[instance-sync] _reconcileGroupMembers add ${crowId} failed: ${err.message}`);
      }
    }

    // Remove: syncable members no longer in the wire-map.
    try {
      const { rows: locals } = await this.db.execute({
        sql: `SELECT gm.contact_id, c.crow_id, c.origin, c.request_status
                FROM contact_group_members gm JOIN contacts c ON c.id = gm.contact_id
               WHERE gm.group_id = ?`, args: [groupId],
      });
      for (const lm of locals) {
        const syncable = lm.origin !== "local-bot" &&
          (lm.request_status == null || lm.request_status === "accepted");
        if (!syncable) continue;                 // local-only membership — peer can't know it
        if (wireSet.has(lm.crow_id)) continue;   // still a member
        await this.db.execute({ sql: "DELETE FROM contact_group_members WHERE group_id = ? AND contact_id = ?", args: [groupId, lm.contact_id] });
      }
    } catch (err) {
      console.warn(`[instance-sync] _reconcileGroupMembers remove failed: ${err.message}`);
    }
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/groups-sync.test.js`
Expected: PASS (10/10).

Then a focused regression on the existing sync suite:
Run: `node --test tests/instance-sync.test.js`
Expected: PASS (unchanged — the new dispatch only intercepts `contact_groups`).

- [ ] **Step 5: Commit**

```bash
git add tests/groups-sync.test.js
git commit servers/sharing/instance-sync.js tests/groups-sync.test.js -m "feat(sharing): Phase 3 groups — _applyGroup (group_uid-keyed LWW + membership reconcile + lamport-gated delete + room carve-out)"
git show --stat HEAD | head
```

---

## Task 4: One-shot `backfillGroupsOnce` — deterministic uid assignment (C1) + re-emit pre-existing plain groups so they resolve on peers

**Why:** `_applyGroup` and `emitGroupUpsert` only carry groups mutated *after* this PR
ships. A group created before the feature (or before the pair paired) never emitted a
group entry, so it never lands on the peer. This one-shot, idempotent backfill re-emits
existing **plain** groups once per instance — modeled byte-for-byte on the shipped
`backfillContactsOnce()` (instance-sync.js:522), including its I-B1 drain-first ordering
guard and residual-window semantics. **It is also the home of C1's deterministic uid
assignment:** the migration (Task 1) left every pre-existing plain group `group_uid IS
NULL`; this backfill assigns each a deterministic, frozen uid BEFORE re-emitting, so the
same logical group on crow + grackle converges on ONE uid.

> **C1 decision — WHERE the deterministic assignment lives: option (ii), the manager
> (`backfillGroupsOnce`), NOT option (i), the init-db migration.** The deterministic uid is
> `sha256(<shared ed25519 pubkey, hex> + ":" + lower(trim(name)))[:32]`, which requires
> **(a)** the DECRYPTED shared identity and **(b)** a `sha256`. Neither is available to
> init-db: `scripts/init-db.js` never loads the identity, `loadInstanceSeed()`
> (identity.js:225) **throws on a passphrase-encrypted seed** (so option (i) would break on
> every encrypted-identity install), and SQLite exposes no `sha256` SQL function (so the hash
> would have to be done in JS anyway, pulling identity-derivation into a pure-schema script —
> a layering violation). The `InstanceSyncManager`, by contrast, is constructed
> (instance-sync.js:215) with the ALREADY-decrypted `this.identity.ed25519Pubkey` and runs in
> Node with `crypto`. Option (ii) also keeps assignment + emit atomic (assign, then re-emit
> the now-uid'd row) and lets the migration stay a trivial column-add. The migration leaving
> pre-existing rows NULL is safe: `group_uid` is brand-new (nothing else reads it) and SQLite
> UNIQUE permits multiple NULLs.
>
> **Local same-name collision tie-break (chosen: COLLISION-DRIVEN `\x1f`-keyed retry, by
> ascending `id` — revised in R2 F1).** Two locally-distinct plain groups both named
> "Family" on ONE instance would hash to the SAME deterministic uid → UNIQUE-index
> violation. We disambiguate **collision-driven**: each NULL-uid row (visited `id ASC`)
> first attempts the base hash `sha256(pubkey ":" lower(trim(name)))`; every
> UNIQUE-constraint rejection bumps a retry counter `n` and re-attempts with
> `sha256(pubkey ":" lower(trim(name)) "\x1f" n)` (n = 1, 2, …; bounded at 16 retries,
> then warn + skip). Two properties fall out by construction (both R1-draft `name + "#2"`
> bugs, closed):
> - **No literal-name collision.** The `\x1f` unit separator is a control character that
>   cannot survive `lower(trim(name))` of any real group name, so a suffixed key can NEVER
>   equal the base key of a literal name — unlike `"#2"`, where a group literally named
>   "Family#2" hashed identically to dup-slot-2 of "Family" (silent cross-instance
>   mismerge of two distinct groups).
> - **Crash-idempotent.** Probing the DB (attempt → UNIQUE failure → retry next slot)
>   instead of pre-counting this run's rows means a partial/interrupted run strands
>   nothing: a retry re-probes from the base hash and walks past whatever already landed —
>   from this run, a previous run, or a peer's identical deterministic uid. (The R1
>   per-run counter recomputed an already-taken hash on retry → UNIQUE violation →
>   permanently stranded NULL row.)
>
> This is **non-destructive** (both user-intended groups
> survive with distinct memberships) — the rejected alternative, *merging* the two rows, would
> silently destroy one group and union unrelated memberships. Trade-off, stated: the common,
> correct case (exactly one "Family" per instance) converges EXACTLY across instances; two
> same-name groups on both instances converge only if their `id ASC` order agrees (a
> degenerate already-duplicated case) — documented in Known limitations, not silently wrong.
> Assignment runs BEFORE the `alreadyRan` flag gate (every boot — R2 F2, chosen over
> keep-placement-and-reword because the SELECT is cheap, usually 0 rows, and it makes
> NULL-uid rows introduced by restore/import or an interrupted run self-heal instead of
> staying local-only forever) and BEFORE the `outFeeds` peer gate, so a
> peerless instance still gets stable uids (idempotent: only NULL-uid rows are touched; a
> frozen uid is never re-derived on later rename).

**Convergence semantics (inherited from `backfillContactsOnce` I-B1):** a re-emit gives
the group a fresh (higher) `lamport_ts`, so on the peer `_applyGroup` takes the
`lamportTs > localTs` UPDATE branch. When both instances agree it's a harmless
re-write; when the peer holds a **newer diverged** edit we haven't applied (e.g. the peer
removed a member while we were offline), the fresh lamport would make our stale row win.
The **drain-first** guard applies the peer's already-replicated backlog before we
re-emit, closing the common 2-instance case; the residual window (peer edits not yet
replicated into our in-feed at backfill time) is documented in Known limitations.

**Files:**
- Modify: `servers/sharing/instance-sync.js` (add `backfillGroupsOnce()` next to
  `backfillContactsOnce`)
- Modify: `servers/gateway/boot/mcp-mounts.js` (call it right after the
  `backfillContactsOnce()` block at :78-84, in its own guarded try/catch — AFTER contacts
  backfill so member contacts have a chance to land first)
- Test: `tests/groups-backfill.test.js` (create)

**Interfaces:**
- `async backfillGroupsOnce()` — **`_assignDeterministicGroupUids()` runs FIRST, BEFORE
  the `alreadyRan` flag gate** (R2 F2: it runs every boot — a cheap `SELECT … WHERE
  group_uid IS NULL`, usually 0 rows — so a NULL-uid row introduced by restore/import or
  an interrupted run self-heals on the next boot instead of staying local-only forever);
  then flag `__groups_backfill_v1` (only `done:<n>` terminal); then `outFeeds.size === 0` →
  return 0 **without** marking the flag (retry next boot); else drain every open in-feed
  (`_processNewEntries`) FIRST, then `SELECT id FROM contact_groups WHERE room_uid IS NULL`
  and `emitGroupUpsert(this.db, row.id)` each; done-mark via `ON CONFLICT DO UPDATE` UPSERT.
  Never throws out of the loop.
- `async _assignDeterministicGroupUids()` — selects plain groups (`room_uid IS NULL`) with
  `group_uid IS NULL` ordered by `id ASC`; for each, **collision-driven assignment (R2 F1)**:
  attempt `UPDATE contact_groups SET group_uid=? WHERE id=? AND group_uid IS NULL` with
  `deterministicGroupUid(name, 0)` = `sha256(this.identity.ed25519Pubkey + ":" +
  lower(trim(name)))[:32]`; on a UNIQUE-constraint failure bump `n` and retry with
  `deterministicGroupUid(name, n)` = `sha256(… + ":" + lower(trim(name)) + "\x1f" + n)[:32]`
  (n = 1, 2, …; bound 16, then warn + skip that row). No pre-counted per-name counter —
  uniqueness is guaranteed by construction regardless of partial runs, and the `\x1f`
  separator makes a literal-name collision (e.g. a group named "Family#2") impossible.
  Guarded; returns the number assigned. Requires `import { createHash } from
  "node:crypto"` at the top of instance-sync.js.

- [ ] **Step 1: Write the failing test**

Create `tests/groups-backfill.test.js`:

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const TEST_PRIV = Buffer.alloc(32, 0xAB);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };

function freshMgr(label, id) {
  const d = mkdtempSync(join(tmpdir(), `crow-p3g-backfill-${label}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: d }, stdio: "pipe" });
  after(() => rmSync(d, { recursive: true, force: true }));
  const m = new InstanceSyncManager(IDENTITY, createDbClient(join(d, "crow.db")), id);
  m.feedsDisabled = false;
  m.outFeeds.set("peer-1", { append: async () => {} });
  return m;
}

test("backfillGroupsOnce: re-emits plain groups once, no-ops on re-run (idempotent)", async () => {
  const m = freshMgr("idem", "local-1"); const db = m.db;
  const emitted = [];
  const orig = m.emitChange.bind(m);
  m.emitChange = async (t, o, r) => { if (t === "contact_groups") emitted.push(r.group_uid); return orig(t, o, r); };
  await db.execute({ sql: "INSERT INTO contact_groups (name, group_uid) VALUES ('Family','gb1')" });
  const n1 = await m.backfillGroupsOnce();
  assert.equal(n1, 1);
  assert.deepEqual(emitted, ["gb1"]);
  emitted.length = 0;
  assert.equal(await m.backfillGroupsOnce(), 0, "flag-guarded second run is a no-op");
  assert.equal(emitted.length, 0);
});

test("backfillGroupsOnce: excludes ROOM groups (room_uid NOT NULL)", async () => {
  const m = freshMgr("rooms", "local-2"); const db = m.db;
  const emitted = [];
  m.emitChange = async (t, _o, r) => { if (t === "contact_groups") emitted.push(r.group_uid); };
  await db.execute({ sql: "INSERT INTO contact_groups (name, group_uid) VALUES ('Plain','gb2')" });
  await db.execute({ sql: "INSERT INTO contact_groups (name, group_uid, room_uid) VALUES ('Room','gb3','ruid')" });
  const n = await m.backfillGroupsOnce();
  assert.equal(n, 1);
  assert.deepEqual(emitted, ["gb2"], "only the plain group re-emitted");
});

test("backfillGroupsOnce: no peers → returns 0 and does NOT mark the flag (retryable)", async () => {
  const m = freshMgr("nopeers", "local-3");
  m.outFeeds.clear();
  await m.db.execute({ sql: "INSERT INTO contact_groups (name, group_uid) VALUES ('Solo','gb4')" });
  assert.equal(await m.backfillGroupsOnce(), 0);
  const { rows } = await m.db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key='__groups_backfill_v1'" });
  assert.equal(rows.length, 0, "flag NOT written when peerless — retry next boot");
});

test("C1: a pre-existing NULL-uid plain group is assigned the DETERMINISTIC uid (frozen)", async () => {
  const m = freshMgr("det", "local-4"); const db = m.db;
  // Legacy row: insert then force NULL past the trigger (mirrors a pre-feature group).
  await db.execute({ sql: "INSERT INTO contact_groups (name, group_uid) VALUES ('  Family  ', 'seed')" });
  await db.execute("UPDATE contact_groups SET group_uid = NULL WHERE name='  Family  '");
  await m._assignDeterministicGroupUids();
  const expect = createHash("sha256").update(`${TEST_PUB_HEX}:family`).digest("hex").slice(0, 32);
  const { rows } = await db.execute({ sql: "SELECT group_uid FROM contact_groups WHERE name='  Family  '" });
  assert.equal(rows[0].group_uid, expect, "uid = sha256(pubkey:lower(trim(name)))[:32]");
  // Idempotent + frozen: a rename does NOT change the assigned uid; a re-run is a no-op.
  await db.execute("UPDATE contact_groups SET name='Renamed' WHERE name='  Family  '");
  assert.equal(await m._assignDeterministicGroupUids(), 0, "no NULL-uid rows left → no-op");
  const { rows: r2 } = await db.execute({ sql: "SELECT group_uid FROM contact_groups WHERE name='Renamed'" });
  assert.equal(r2[0].group_uid, expect, "uid frozen across rename");
});

test("C1 convergence: two instances (same shared identity) derive the SAME uid for the same-named group", async () => {
  const a = freshMgr("convA", "inst-A"); const b = freshMgr("convB", "inst-B");
  for (const m of [a, b]) {
    await m.db.execute({ sql: "INSERT INTO contact_groups (name, group_uid) VALUES ('Family','seed')" });
    await m.db.execute("UPDATE contact_groups SET group_uid = NULL WHERE name='Family'");
    await m._assignDeterministicGroupUids();
  }
  const ua = (await a.db.execute("SELECT group_uid FROM contact_groups WHERE name='Family'")).rows[0].group_uid;
  const ub = (await b.db.execute("SELECT group_uid FROM contact_groups WHERE name='Family'")).rows[0].group_uid;
  assert.equal(ua, ub, "same shared identity + same name → identical deterministic uid → converges, not duplicates");
});

test("C1 tie-break (R2 F1): two same-name plain groups on ONE instance get DISTINCT collision-driven uids (no UNIQUE crash) + a partial run self-heals", async () => {
  const m = freshMgr("tie", "local-5"); const db = m.db;
  await db.execute({ sql: "INSERT INTO contact_groups (id, name, group_uid) VALUES (1,'Family','s1'),(2,'Family','s2')" });
  await db.execute("UPDATE contact_groups SET group_uid = NULL WHERE name='Family'");
  const n = await m._assignDeterministicGroupUids();
  assert.equal(n, 2, "both rows assigned, no UNIQUE-index crash");
  const first = createHash("sha256").update(`${TEST_PUB_HEX}:family`).digest("hex").slice(0, 32);
  const second = createHash("sha256").update(`${TEST_PUB_HEX}:family\x1f1`).digest("hex").slice(0, 32);
  const u1 = (await db.execute("SELECT group_uid FROM contact_groups WHERE id=1")).rows[0].group_uid;
  const u2 = (await db.execute("SELECT group_uid FROM contact_groups WHERE id=2")).rows[0].group_uid;
  assert.equal(u1, first, "lowest id lands the base hash");
  assert.equal(u2, second, "second (by id ASC) collides on base, retries → \\x1f1 slot hash");
  assert.notEqual(u1, u2);
  // Crash-idempotency (R2 F1b): simulate a partial run — strand row 2 back to NULL.
  // The retry loop re-probes from the base hash, walks past the already-taken slot,
  // and re-lands \x1f1 — no permanent UNIQUE-stranding (the R1 counter design's bug).
  await db.execute("UPDATE contact_groups SET group_uid = NULL WHERE id = 2");
  assert.equal(await m._assignDeterministicGroupUids(), 1, "stranded row re-assigned on the next run");
  const u2b = (await db.execute("SELECT group_uid FROM contact_groups WHERE id=2")).rows[0].group_uid;
  assert.equal(u2b, second, "partial-run retry converges on the same \\x1f1 slot, no crash");
});

test("C1 no literal-name mismerge (R2 F1a): a group literally named 'Family#2' coexists with two 'Family' groups — three DISTINCT uids, idempotent re-run", async () => {
  const m = freshMgr("lit", "local-6"); const db = m.db;
  await db.execute({ sql: "INSERT INTO contact_groups (id, name, group_uid) VALUES (1,'Family','s1'),(2,'Family','s2'),(3,'Family#2','s3')" });
  await db.execute("UPDATE contact_groups SET group_uid = NULL");
  assert.equal(await m._assignDeterministicGroupUids(), 3, "all three assigned");
  const uids = (await db.execute("SELECT group_uid FROM contact_groups ORDER BY id ASC")).rows.map((r) => r.group_uid);
  assert.equal(new Set(uids).size, 3, "three DISTINCT uids — no cross-group mismerge");
  const literal = createHash("sha256").update(`${TEST_PUB_HEX}:family#2`).digest("hex").slice(0, 32);
  assert.equal(uids[2], literal, "'Family#2' keeps ITS OWN base hash — never confused with dup-slot-2 of 'Family' (which is \\x1f-keyed)");
  assert.equal(uids[1], createHash("sha256").update(`${TEST_PUB_HEX}:family\x1f1`).digest("hex").slice(0, 32), "dup-slot-2 of 'Family' is \\x1f1, disjoint from the literal name's hash");
  // Idempotent re-run: nothing left NULL, nothing re-derived.
  assert.equal(await m._assignDeterministicGroupUids(), 0, "re-run is a no-op");
  const again = (await db.execute("SELECT group_uid FROM contact_groups ORDER BY id ASC")).rows.map((r) => r.group_uid);
  assert.deepEqual(again, uids, "uids stable across re-runs");
});
```

> `createHash` is imported from `node:crypto` in the test file (add
> `import { createHash } from "node:crypto";` to the header). The convergence test seeds
> BOTH managers from the SAME `IDENTITY` (shared seed) — exactly the crow↔grackle case.

> The I-B1 drain-first behavior is already unit-proven for the shared `_processNewEntries`
> path in `tests/messages-contacts-backfill.test.js`; `backfillGroupsOnce` reuses the same
> drain loop verbatim, so this file asserts the group-specific SELECT/room-exclusion/flag
> semantics rather than re-testing the drain primitive.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/groups-backfill.test.js`
Expected: FAIL — `backfillGroupsOnce` is not a method (TypeError).

- [ ] **Step 3: Implement `backfillGroupsOnce` + wire the boot call**

Add next to `backfillContactsOnce` in `servers/sharing/instance-sync.js` (import
`emitGroupUpsert` at the top of the module, alongside the existing sharing imports; add
`import { createHash } from "node:crypto";`):

```js
  /**
   * C1: assign a DETERMINISTIC, FROZEN group_uid to every pre-existing PLAIN group
   * the migration left NULL, so the SAME logical group on two instances (same shared
   * identity) converges on ONE uid instead of duplicating. uid = first-32-hex of
   * sha256(<shared ed25519 pubkey> ":" lower(trim(name))). Local same-name collisions
   * are resolved COLLISION-DRIVEN (R2 F1): a UNIQUE rejection retries with a
   * "\x1f"-suffixed key (base\x1f1, base\x1f2, …, bound 16 then warn+skip). The \x1f
   * unit separator cannot survive lower(trim(name)) of any real group name, so a
   * suffixed key can never collide with a literal name's base key; and probing the DB
   * instead of pre-counting makes the assignment crash-idempotent (a partial run
   * strands nothing — the retry walks past whatever already landed).
   * Idempotent: only touches NULL-uid rows; a frozen uid is never re-derived on rename.
   * Never throws. Returns the count assigned.
   */
  deterministicGroupUid(name, n = 0) {
    const base = String(name ?? "").trim().toLowerCase();
    // n=0 → base hash; n>0 → collision-retry slot. "\x1f" is a control char no real
    // group name contains — unlike "#2", a slot key can never equal a literal name.
    const keyed = n > 0 ? `${base}\x1f${n}` : base;
    return createHash("sha256")
      .update(`${this.identity.ed25519Pubkey}:${keyed}`)
      .digest("hex")
      .slice(0, 32);
  }

  async _assignDeterministicGroupUids() {
    const MAX_COLLISION_RETRIES = 16;
    let assigned = 0;
    let rows = [];
    try {
      const r = await this.db.execute({ sql: "SELECT id, name FROM contact_groups WHERE room_uid IS NULL AND group_uid IS NULL ORDER BY id ASC" });
      rows = r.rows || [];
    } catch (err) {
      console.warn(`[instance-sync] deterministic group_uid read failed: ${err.message}`);
      return 0;
    }
    for (const row of rows) {
      // COLLISION-DRIVEN (R2 F1): try the base hash; every UNIQUE rejection bumps n
      // and retries the \x1f-suffixed slot. No in-memory counter → crash-idempotent:
      // the retry walks past hashes that already landed (this run, a previous
      // interrupted run, or a peer's identical deterministic uid).
      let settled = false;
      for (let n = 0; n <= MAX_COLLISION_RETRIES && !settled; n++) {
        const uid = this.deterministicGroupUid(row.name, n);
        try {
          // group_uid IS NULL guard makes the UPDATE a no-op if a concurrent path already set it.
          await this.db.execute({ sql: "UPDATE contact_groups SET group_uid = ? WHERE id = ? AND group_uid IS NULL", args: [uid, row.id] });
          assigned++;
          settled = true;
        } catch (err) {
          if (!/unique|constraint/i.test(err.message || "")) {
            // Non-UNIQUE failure — skip this row, never throw (re-attempted next boot,
            // since assignment runs before the flag gate — R2 F2).
            console.warn(`[instance-sync] deterministic group_uid assign failed for group ${row.id}: ${err.message}`);
            settled = true;
          }
          // UNIQUE collision → loop retries with n+1.
        }
      }
      if (!settled) {
        console.warn(`[instance-sync] deterministic group_uid: ${MAX_COLLISION_RETRIES} collisions for group ${row.id} — left NULL (re-attempted next boot)`);
      }
    }
    if (assigned > 0) console.log(`[instance-sync] assigned ${assigned} deterministic group_uid(s) to pre-existing groups`);
    return assigned;
  }

  /**
   * One-shot idempotent backfill (Phase 3 groups-follow-user): re-emit every
   * existing PLAIN contact group (room_uid IS NULL) so a peer can resolve it for
   * groups that predate this feature. Rooms are excluded (own Nostr sync). The
   * RE-EMIT is guarded by a flag so it runs once per instance lifetime; C1
   * deterministic uid assignment runs BEFORE that gate — every boot (R2 F2) — so
   * pre-existing groups converge (not duplicate) and a NULL-uid row introduced
   * later (restore/import/interrupted run) self-heals on the next boot. Then it
   * drains the inbound backlog (I-B1) so a peer's already-delivered newer group
   * edit wins before we re-emit with a fresh lamport. Mirrors
   * backfillContactsOnce(). Never throws.
   */
  async backfillGroupsOnce() {
    // C1: assign deterministic frozen uids to legacy NULL-uid plain groups BEFORE the
    // flag gate (R2 F2 — every boot; usually 0 rows) and BEFORE the peer gate — so even
    // a peerless instance gets stable, convergent uids and stranded NULLs self-heal.
    await this._assignDeterministicGroupUids();

    const FLAG_KEY = "__groups_backfill_v1";
    let alreadyRan = false;
    try {
      const { rows } = await this.db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [FLAG_KEY] });
      alreadyRan = typeof rows?.[0]?.value === "string" && rows[0].value.startsWith("done:");
    } catch {}
    if (alreadyRan) return 0;

    if (this.outFeeds.size === 0) return 0; // no peers armed yet — retry next boot; do NOT mark

    // I-B1 ordering guard: apply the peer's already-replicated backlog first.
    try {
      for (const [peerId, inFeed] of this.inFeeds) {
        await this._processNewEntries(peerId, inFeed);
      }
    } catch (err) {
      console.warn(`[instance-sync] groups backfill drain failed: ${err.message}`);
    }

    let rows = [];
    try {
      const r = await this.db.execute({ sql: "SELECT id FROM contact_groups WHERE room_uid IS NULL" });
      rows = r.rows || [];
    } catch (err) {
      console.warn(`[instance-sync] groups backfill read failed: ${err.message}`);
      return 0;
    }

    let emitted = 0;
    for (const row of rows) {
      try {
        await emitGroupUpsert(this.db, row.id); // shouldSyncRow + room skip are the final gate
        emitted++;
      } catch (err) {
        console.warn(`[instance-sync] groups backfill emit failed for group ${row.id}: ${err.message}`);
      }
    }

    try {
      await this.db.execute({
        sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        args: [FLAG_KEY, `done:${emitted}`],
      });
    } catch {}

    if (emitted > 0) console.log(`[instance-sync] one-shot groups backfill: ${emitted} group(s) re-emitted → peers resolve legacy groups`);
    return emitted;
  }
```

> **Note:** `backfillGroupsOnce` counts `emitted` as the number of plain groups it *asked*
> `emitGroupUpsert` to emit; a room slipping through `room_uid IS NULL` is impossible (rooms
> carry a `room_uid`), and `emitGroupUpsert`'s own room/keyless skip is the belt-and-suspenders
> final gate. Unit test asserts the count matches plain groups only.

In `servers/gateway/boot/mcp-mounts.js`, right after the `backfillContactsOnce()` block
(:78-84), add:

```js
  // Phase 3 groups: one-shot re-emit of existing plain groups so peers resolve
  // groups that predate this feature. AFTER contacts backfill so member contacts
  // have a chance to land first. Guarded by a flag row; idempotent on later boots.
  try {
    if (syncManager?.backfillGroupsOnce) {
      await syncManager.backfillGroupsOnce();
    }
  } catch (err) {
    console.warn(`[instance-sync] backfillGroupsOnce failed: ${err.message}`);
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/groups-backfill.test.js`
Expected: PASS (7/7 — 3 backfill + 4 C1 deterministic-uid/convergence/tie-break/literal-name).

- [ ] **Step 5: Commit**

```bash
git add tests/groups-backfill.test.js
git commit servers/sharing/instance-sync.js servers/gateway/boot/mcp-mounts.js tests/groups-backfill.test.js -m "feat(sharing): Phase 3 groups — one-shot backfillGroupsOnce so pre-existing plain groups resolve on peers"
git show --stat HEAD | head
```

---

## Task 5: Full-suite verification, isolated boot smoke (user_version=5), self-review, ledger

**Files:**
- Modify: `.superpowers/sdd/progress.md` (git-ignored — do NOT `git add`)

- [ ] **Step 1: Full suite**

Run: `node --test tests/`
Expected: PR-A/PR-B baseline (1083) + the four new files (`groups-schema`,
`groups-sync-emit`, `groups-sync`, `groups-backfill`), **0 fail** (~35s). A pre-existing
flaky (`crow-accept-bot-invite.test.js` handle-leak) must fail identically on `main`
before being attributed here.

- [ ] **Step 2: Isolated boot smoke (schema bump to 5 expected)**

```bash
D=$(mktemp -d); CROW_GATEWAY_URL= CROW_DATA_DIR=$D PORT=3999 timeout -k 5 25 node servers/gateway/index.js --no-auth > /tmp/p3g-boot.log 2>&1
grep -E "listening|Subscribed|Error|Schema|group_uid" /tmp/p3g-boot.log
sqlite3 $D/crow.db "PRAGMA user_version;"                 # expect 5
sqlite3 $D/crow.db "PRAGMA table_info(contact_groups);"   # expect group_uid + lamport_ts present
sqlite3 $D/crow.db "SELECT name FROM sqlite_master WHERE type='trigger' AND name='contact_groups_group_uid_ai';"
```
Expected: `listening`, both subscribe lines, no new `Error`, `user_version=5`,
`group_uid`+`lamport_ts` columns, trigger present. `backfillGroupsOnce` on a fresh
single-instance DB logs nothing (no peers → returns 0, flag unset — retryable). The
`--no-auth` companion sets `feedsDisabled` so `emitChange` short-circuits; a real primary
boot (crow/grackle) runs the backfill once peers arm.

- [ ] **Step 3: Self-review vs spec + trust boundary**

Confirm each S-GROUPS requirement maps to a task: new `group_uid` stable key (Task 1) ✓;
membership as a wire-map of member `crow_id`s, `contact_group_members` NOT on the wire
(Task 2/3) ✓; **room carve-out** enforced on emit (`emitGroupUpsert` room skip) AND apply
(`shouldSyncRow` `room_uid != null` reject) AND write (`ALWAYS_DROP` room columns) —
triple-layered ✓; `SCHEMA_GENERATION` bump argued + applied (Task 1) ✓; one-shot backfill
mirrors `backfillContactsOnce` incl. drain-first (Task 4) ✓.

R1-closure checklist (confirm each is implemented, not just documented): **C1** — migration
does NOT randomblob-fill pre-existing rows (Task 1); `_assignDeterministicGroupUids` gives a
deterministic frozen uid before emit, both instances converge, local same-name collision
suffix holds (Task 4 tests) ✓; **I1** — membership whole-set LWW stated in code doc +
Known-limitations + E2E (e) ✓; **I2** — emit JOIN excludes local-bot/pending (Task 2 test),
add-branch bounded to syncable (Task 3 test) ✓; **M1** — `sort_order` marked forward-looking
✓; **M2** — create_group emit inside `if(name)` guard ✓; **M3** — metadata-equal tie skips
membership reconcile, documented ✓; **M4** — trigger idempotency note ✓.

R2-closure checklist (same discipline): **F1** — collision-driven `\x1f`-keyed assignment
(no pre-counted counter); literal-"Family#2" no-mismerge test + partial-run
crash-idempotency test pass (Task 4) ✓; **F2** — `_assignDeterministicGroupUids` runs
BEFORE the `alreadyRan` flag gate (every-boot self-heal; Known-limitations wording matches
the code) ✓; **F3** — `members === undefined` skips reconcile, explicit `[]` empties
(Task 3 test) ✓; **F4** — E2E (e) label reads "whole-set LWW replace" ✓.

Trust-boundary checklist (adversarial focus): (1) sig-verify at `_applyEntry:775` is not
bypassed by the new dispatch — the `contact_groups` block sits AFTER the verify, same as
`contacts`/`messages` ✓; (2) no phantom contact — `_reconcileGroupMembers` only ever
`INSERT`s a `(group_id, contact_id)` for a contact that *already resolves* locally ✓;
(3) no room hijack — a `room_uid`-bearing entry is dropped by `shouldSyncRow` and, even
if it weren't, `ALWAYS_DROP` strips `room_uid`/`host_crow_id`/`mode` from every write ✓;
(4) no forged-id collision — `_applyGroup` keys on `group_uid`, ignores the wire `id`
(test: forged `id=300` leaves the existing row untouched) ✓; (5) full-replace cannot
wipe a local-only/local-bot membership the peer can't know about ✓; (6) delete is
lamport-gated (a stale delete logs a conflict, keeps local) ✓; (7) never-throw on emit +
apply + reconcile + backfill ✓.

- [ ] **Step 4: Update the git-ignored ledger** (do NOT `git add`) — append a groups-PR
status block to `.superpowers/sdd/progress.md`.

- [ ] **Step 5: No commit for the ledger.** Code is committed per-task. Proceed to the
whole-branch final SECURITY review (opus) before opening the PR.

---

## Known limitations

- **Backfill divergence window (inherited I-B1 residual).** `backfillGroupsOnce` drains
  the locally-replicated inbound backlog before re-emitting, but a peer edit not yet
  replicated into our in-feed at backfill time can still be overwritten by the fresh-lamport
  re-emit (last-write-wins picks the fabricated-newer local row; for membership that means
  a silently re-added member the peer had removed, or a silently resurrected group the peer
  had deleted). One boot, once per instance lifetime, flag-guarded — identical to the
  operator-accepted `backfillContactsOnce`/`reemitSyncableSettingsOnce` window. A
  lamport-preserving re-emit (peer INSERTs only rows it lacks; no clobber) is the clean
  fix and needs an explicit-lamport path through `emitChange` — logged as a shared
  follow-up with the contacts one.
- **Member added before their contact syncs.** If a group membership entry names a member
  whose contact has not yet synced to the peer, `_reconcileGroupMembers` **skips** that
  member (no phantom contact). Unlike PR-B messages (which also re-arrive via direct
  Nostr), a group has no second delivery channel, so the skipped member stays absent until
  the **next** membership mutation on that group re-emits the full wire-map (self-heals on
  any later add/remove), or until a fresh `backfillGroupsOnce` runs on a new instance
  lifetime. The boot ordering (`backfillContactsOnce` before `backfillGroupsOnce`) narrows
  but does not eliminate this — sync application is async, so the contact rows may not be
  applied when the group entry arrives. Documented, not silent.
- **Rooms are explicitly not covered.** Multi-party rooms (`room_uid NOT NULL`) keep their
  existing hub-and-spoke Nostr sync (`room_messages` / `room-inbound.js`); this PR does not
  change room replication and deliberately excludes rooms from group-sync at three layers.
- **Metadata AND membership LWW is whole-set, not per-field / per-member (I1).** A group's
  `name`/`color` converge by whole-row LWW on `lamport_ts` (same model as contacts): two
  instances editing different fields of the same group concurrently resolve to the
  higher-lamport row wholesale, not a per-field merge. **Membership is likewise whole-set
  (I1):** on a winning apply the local membership is REPLACED by the winner's full wire-map
  (within the syncable domain) — if crow adds member X and grackle removes member Y
  concurrently, the higher-lamport side's ENTIRE set wins and the losing side's edit
  (X-add or Y-remove) is REVERTED. Acceptable for a single user's own low-contention
  groups; a `sync_conflicts` row records the losing edit on a true tie/stale collision.
- **Tie with differing membership persists silently (M3).** On a `lamportTs <= localTs`
  apply where metadata is `rowsEquivalent` (a metadata-equal tie), `_applyGroup` returns
  WITHOUT reconciling membership — so if two instances hold identical metadata but divergent
  membership at equal lamport, that divergence is not reconciled and persists until the next
  higher-lamport edit on that group. Low-probability under a single user's serialized edits;
  documented, not silent.
- **`sort_order` is forward-looking (M1).** `sort_order` rides the wire and applies under LWW
  if present, but **no UI or MCP tool writes it today** — so in practice it never diverges and
  the sync of it is inert until a future group-ordering feature adds a mutation site. Listed
  as synced-if-present, not as an actively-converged field.
- **C1 deterministic-uid residual — same-name duplicates on BOTH instances.** The C1
  deterministic uid makes the common case (one group of a given name per instance) converge
  exactly. If BOTH instances independently hold TWO+ plain groups of the SAME name, they
  converge pairwise only when their `id ASC` order agrees (the collision-driven tie-break
  lands `base`, `base\x1f1`, `base\x1f2` slots in local id-visit order — R2 F1); a
  differing creation order pairs them arbitrarily. A group whose deterministic uid collides
  with a peer's already-landed identical uid is NO LONGER stranded NULL (the R1 draft's
  outcome, and R2 F2's false "retried on the next mutation" claim about it): the collision
  retry walks it to the next `\x1f` slot, so that race yields a *distinct synced group* — a
  visible duplicate the user can merge/delete by hand — never a silently local-only row.
  Any row that IS left NULL (the 16-retry bound, or a NULL introduced by restore/import)
  self-heals on the next boot, because `_assignDeterministicGroupUids` runs before the
  one-shot flag gate (R2 F2). This is a degenerate,
  already-duplicated input; the frozen-on-rename rule also means a group renamed on ONE
  instance BEFORE its backfill ran derives its uid from the NEW name and will not converge
  with the peer's original-name uid. Documented, narrow, non-crashing.
- **Auto-populate trigger is not auto-restored under the drift gate (M4, non-issue).** The
  `contact_groups_group_uid_ai` trigger + the UNIQUE index are created by the Task 1 migration
  via `CREATE … IF NOT EXISTS`, so the migration is idempotent; but the boot drift gate only
  re-runs init-db when `user_version < 5`, so a *manually dropped* trigger on an
  already-migrated (`user_version = 5`) host would NOT be recreated automatically. The trigger
  is never dropped in normal operation; flagged only for completeness.
- **Plaintext-at-rest (acknowledged, out of scope).** Group names + membership ride the
  instance-sync Hypercore feeds in cleartext under the shared-identity trust boundary,
  consistent with every other synced table (contacts, messages, memories). Not new surface.

## Trust boundary (adversarial-review focus)

This PR crosses the **sync** trust boundary — inbound entries from a paired instance become
local groups + memberships. Review must verify:

1. **Signature binding.** `_applyEntry` ed25519-verifies against the shared identity
   (`instance-sync.js:775`) BEFORE the `contact_groups` dispatch. The new block must not be
   reachable for an unverified entry (it sits after the verify + after the `shouldSyncRow`
   gate at :768).
2. **Room carve-out is unbypassable.** A peer must not create/convert a room through the
   group channel. Enforced at emit (`emitGroupUpsert` room skip), apply-gate
   (`shouldSyncRow` rejects `room_uid != null`), and write (`ALWAYS_DROP` strips
   `room_uid`/`host_crow_id`/`mode`). Verify all three; removing any one must be caught.
3. **No phantom-contact injection AND no local-bot capture (I2).** `_reconcileGroupMembers`
   resolves member `crow_id → local contact_id` and **skips** unresolved members — a peer
   cannot conjure a contact (or a trust surface) through a group's membership list (same
   guarantee as `_applyMessage`). The add-branch is ALSO bounded to the *syncable* domain: a
   resolved-but-`local-bot`/pending contact is skipped, so a peer's wire-map cannot pull your
   local-bot into a synced group. Symmetric with the emit-side JOIN filter (a local-bot/pending
   member never leaves the instance in the first place) and with the remove-branch.
4. **No whole-set-replace data loss of local-only members (I1).** Membership apply is
   whole-set replace, but the removal branch only deletes *syncable* members
   (`origin != local-bot`, established) absent from the wire-map — a peer that lacks your
   local-bot/pending members cannot wipe them. (The whole-set semantics DO mean a concurrent
   membership edit on the losing lamport side is reverted — see Known limitations I1.)
5. **No forged-id hijack.** `_applyGroup` keys on `group_uid` and ignores the wire `id` (in
   `ALWAYS_DROP`); a copied local `id` cannot overwrite an unrelated group.
6. **No resurrection.** A stale delete/insert is lamport-gated; the one new resurrection
   vector (backfill re-emit) is mitigated by drain-first + one-shot flag, residual documented.
7. **Never-throw.** Emit, `_applyGroup`, `_reconcileGroupMembers`, and `backfillGroupsOnce`
   must swallow their own errors — a group-sync failure must never break the local write nor
   the apply loop.

## Open questions for plan-time (with best-evidence answers)

1. **Schema-gen verdict: does this PR bump `SCHEMA_GENERATION` 4→5, or reuse an existing
   key?** **Bump to 5.** There is no reusable stable key: `contact_groups.id` is per-instance
   `AUTOINCREMENT` (init-db.js:1859) and `room_uid` is NULL for exactly the rows we sync
   (non-rooms) — it identifies rooms, the opposite population. A new `group_uid` is required,
   and LWW needs a `lamport_ts` the table lacks today. Both are `addColumnIfMissing` +
   backfill migrations → the boot gate (`needsSchemaInit`, index.js:129) re-runs idempotent
   init-db on any host with `user_version < 5`. Cost of the bump is one column-add each and a
   trigger; benefit is a proper portable key with UNIQUE enforcement. No cheaper option
   survives review.

2. **Membership reconciliation: full-replace from the wire-map, or per-member add/remove
   events?** **Full-replace wire-map on the group entry (chosen), not separate
   join-table sync entries.** Rationale: (a) it keeps `contact_group_members` — two
   non-portable FKs — off the wire entirely (S-GROUPS's exact concern); (b) it is
   *self-healing* — any later group edit re-emits the complete membership, so a member
   skipped for an unresolved contact is picked up on the next edit, whereas a one-shot
   per-member "add" event that was skipped is lost forever; (c) it inherits the group's
   single `lamport_ts` LWW clock, so the resurrection story is identical to contacts
   (drain-first backfill + LWW). The cost — a naive full-replace would wipe local-only
   members — is neutralized by bounding BOTH the add- and remove-branches to the *syncable*
   contact domain (`origin != local-bot`, established) (I2), with the emit JOIN filtered to
   the same domain so those members never leave the instance. Being honest about the model
   (I1): this is **whole-set LWW**, not a mergeable CRDT — on a winning apply the entire
   membership is replaced, so a concurrent removal on the losing lamport side is reverted
   (documented in Known limitations, and reflected in the E2E claims). **The
   resurrection/delete case the prompt names
   (A removes member X while B is offline, B later re-emits):** with drain-first, B applies
   A's removal before its backfill re-emits → B's wire-map already omits X → converges. The
   only failure is the documented residual window (B's backfill runs before A's removal
   replicates into B's in-feed) → X transiently re-added, then re-removed on A's next edit.
   Per-member events would have the *same* residual window without the self-healing property.

3. **Delete semantics: tombstone column or hard-delete?** **Hard-delete, lamport-gated, NO
   tombstone — mirroring PR-A's shipped `_applyContact`.** PR-A's delete path (instance-sync.js:1121)
   hard-`DELETE`s by `crow_id` when `lamportTs > localTs` and logs a `sync_conflicts` row on
   a stale delete; it ships NO `deleted_at` column. The resurrection defense there is
   three-fold and applies identically to groups: (i) **per-feed append-only ordering** — a
   delete at a higher seq applies after its insert; an old insert cannot re-appear at a lower
   seq in an append-only Hypercore feed, so within one peer's feed a delete is never
   un-done; (ii) **LWW lamport gate** for the localRow-present case; (iii) **drain-first
   backfill** for the cross-peer re-emit case. The prompt flags that "re-emit backfills EXIST
   now" — true, and the groups backfill is the one new resurrection vector, but it is the
   *same* vector `backfillContactsOnce` already carries, mitigated the same way (drain-first
   + one-shot flag). Adding a tombstone for groups but not contacts would be an inconsistent
   asymmetry that closes only the already-narrow residual window. Verdict: hard-delete, and
   the `ON DELETE CASCADE` FK (init-db.js:1870-1871) makes membership cleanup automatic.

4. **Emit-site inventory — did we catch them all?** **Yes: 6 plain-group emit points across
   2 files** (`contacts/api-handlers.js` create/rename/delete/add-member/remove-member ×5;
   `messaging.js` `crow_create_message_group` ×1, emitted once after its member loop). All
   `contact_groups`/`contact_group_members` writes were grepped; every other write site
   carries a `room_uid` (rooms — `rooms-store.js` ×8 statements, `room-inbound.js` ×1) and is
   deliberately NOT instrumented (and would be dropped by `shouldSyncRow` anyway). `data-queries.js`
   hits are reads. If a reviewer finds a group-write path outside these two files, it is a
   gap — re-grep before merge.

5. **Do new groups get a `group_uid` without editing every INSERT?** **Yes — via the
   `AFTER INSERT` trigger** (Task 1), which populates `group_uid` on any row inserted with a
   NULL uid, regardless of call site (dashboard, MCP, future code, even rooms). This is more
   robust than editing each INSERT (which would silently miss a future call site) and is why
   the emit sites can simply re-select the trigger-populated uid. The trigger + column-default
   approaches were weighed; SQLite `ALTER ADD COLUMN` cannot take a `randomblob()` default, so
   the trigger is the only way to auto-populate on an existing table. **NEW rows get a RANDOM
   uid, which is correct (C1):** a new group is single-origin — it is created on ONE instance
   and PROPAGATES to the peer via `emitGroupUpsert`, which lands it under the SAME uid; the
   peer never independently creates a second "Family", so no convergence is needed. Only
   PRE-EXISTING groups (created before sync existed, independently on each instance) need the
   deterministic uid — handled at backfill (Q6).

6. **C1 — where does the deterministic uid for PRE-EXISTING groups get assigned: migration or
   manager?** **The manager (`backfillGroupsOnce` → `_assignDeterministicGroupUids`), NOT the
   init-db migration.** The deterministic uid `sha256(<shared ed25519 pubkey>":"lower(trim(name)))[:32]`
   needs the DECRYPTED shared identity and a sha256; init-db has neither
   (`loadInstanceSeed()` throws on an encrypted seed → option (i) breaks on encrypted installs;
   SQLite has no `sha256` SQL fn), whereas the manager is constructed with the decrypted
   `this.identity.ed25519Pubkey` and runs under Node `crypto`. So the migration leaves
   pre-existing plain groups `group_uid IS NULL` (SQLite UNIQUE permits multiple NULLs, and
   `group_uid` is brand-new so nothing else reads it), and the manager assigns deterministic
   frozen uids before re-emitting. **Local same-name collisions** (two "Family" groups on one
   instance → same hash) are disambiguated collision-driven in `id ASC` visit order (`base`,
   then `base\x1f1`, `base\x1f2`, … on each UNIQUE rejection — R2 F1) rather than merged —
   non-destructive, preserving both user-intended groups.
   Residual (same-name duplicates on both instances / rename-before-backfill) is documented in
   Known limitations.

---

## Post-plan pipeline (the arc's standing process)

1. **2-round adversarial SECURITY review** of THIS plan (opus subagent) before any code —
   hardest on: the room carve-out being unbypassable (all three layers), no phantom-contact
   via membership, no local-bot capture via the add-branch (I2), no whole-set-replace wipe of
   local-only members (I1), forged-`id`/`room_uid` rejection, delete/resurrection semantics,
   **C1 deterministic-uid correctness** (both instances derive the same uid; no cross-INSERT
   duplication; local same-name collision tie-break holds; frozen-on-rename), the migration
   NOT randomblob-filling pre-existing rows, `SCHEMA_GENERATION` correctness, never-throw.
   Do NOT code until both rounds pass. **R1 (REVISE: C1/I1/I2/M1-4) and R2 (REVISE:
   F1/F2/F3/F4 — R2 confirmed the R1 closures and raised 0 critical / 1 important /
   3 minor) are both folded into this revision; see the two review-outcome sections.
   The final reviewer confirms the R2 closures before execution.**
2. **Subagent-driven execution** (fresh implementer per task, TDD, per-task spec+quality review).
3. **Opus final whole-branch SECURITY review** (crosses cross-instance data flow).
4. **PR** via github MCP (owner `kh0pper`, repo `crow`, base `main`); check-runs verified
   pre-merge — **note:** this PR touches the schema but adds NO new bundle host port, so
   `check-ports` is not implicated; confirm all Actions check-runs `completed`/`success`.
5. **Merge** = MERGE COMMIT, **operator-gated** (AskUserQuestion).
6. **Deploy** crow first, then grackle (groups-follow-user needs BOTH on the new code +
   the schema-5 migration): `git checkout main && git pull --rebase && sudo systemctl
   restart crow-gateway`. Verify on each: `/health` 200, `PRAGMA user_version` = **5**,
   `integrity_check ok`, `PRAGMA table_info(contact_groups)` shows `group_uid`+`lamport_ts`,
   the `contact_groups_group_uid_ai` trigger present, 4 relays + both subscribe lines, sync
   feeds initialized. Fleet (MPA/black-swan) self-updates via pull-only auto-update on next
   restart.
7. **LIVE E2E (crow↔grackle, shared seed):**
   - **(a) Fresh group.** On crow, create a group "Family" and add 2 synced contacts →
     within seconds grackle shows "Family" with the same 2 members (verify grackle
     `contact_groups` has the `group_uid`, and `contact_group_members` maps to grackle's
     local contact ids). Rename on crow → renames on grackle. Remove a member on crow →
     removed on grackle. Delete the group on crow → gone on grackle.
   - **(b) Membership resolution boundary.** Add a member whose contact does NOT exist on
     grackle → grackle shows the group without that member (skipped, no phantom); once that
     contact syncs AND the group is next edited, the member appears. Confirm honest outcome,
     not a bug.
   - **(c) Pre-existing group (backfill, one side).** A group created on crow BEFORE this
     deploy (and NOT existing on grackle): after `backfillGroupsOnce` runs with grackle
     paired, it appears on grackle under crow's deterministic `group_uid`. Verify.
   - **(e) C1 — pre-existing SAME-NAMED group on BOTH sides (the split-brain case).** Before
     this deploy, "Family" already exists **independently** on crow AND grackle (each with its
     own members — say crow's Family = {Alice, Bob}, grackle's Family = {Alice, Carol}). After
     BOTH deploy to schema-5 and both backfills run: there must be **exactly ONE "Family" group
     with ONE identical `group_uid` on each instance** (deterministic uid from the shared
     identity + "family") — NOT two duplicated rows. **Membership whole-set LWW replace:** the two
     wire-maps reconcile under whole-set LWW — the higher-lamport backfill re-emit wins and its
     full syncable member set replaces the other's; after both backfills settle the surviving
     set is the last-writer's set (e.g. {Alice, Carol} if grackle re-emitted last), with each
     side's local-only/local-bot members preserved. (This is NOT a set-union CRDT — I1;
     document the observed converged set.) Verify: one row, one uid, no duplicate "Family".
   - **(d) Room isolation.** Create/verify a multi-party ROOM still works and does NOT appear
     as a duplicated plain group on the peer (room_uid path unchanged; `contact_groups` room
     row not re-synced via group-sync).
   - **Honesty note on (a):** because membership is whole-set LWW (I1), a "remove a member on
     crow → removed on grackle" check is only deterministic when crow's edit is the
     higher-lamport write; a concurrent membership edit on grackle at a higher lamport would
     win instead. Drive the checks serially (one instance at a time) for a clean result.
   - black-swan excluded (distinct identity).
